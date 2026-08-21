import Foundation

/// The webview↔host message protocol, host side. The vocabulary is
/// `shared/messages.ts` (`ToExtensionMessage` inbound, `ToWebviewMessage`
/// outbound); Jot speaks the subset a scratchpad needs and files everything
/// else under `.other`, which is logged and never fatal.
///
/// Inbound messages arrive as JSON text: the shim in the page stringifies
/// before `webkit.messageHandlers.birta.postMessage`, so what reaches Swift is
/// always a JSON object. Bytes are the one payload JSON cannot carry directly;
/// see `BinaryPayload` below for the shape they take instead.

/// How binary data crosses the bridge.
///
/// `WKScriptMessage` cannot marshal a typed array and JSON has no bytes, so a
/// payload that is bytes (today: the image an `uploadImage` carries) is wrapped
/// as `{"$bytes": "<base64>"}` by the page-side shim and read back here. Both
/// halves are in this one type so the key is named once rather than spelled in
/// two languages that cannot check each other.
public enum BinaryPayload {
    public static let key = "$bytes"

    /// The bytes of a `{"$bytes": ...}` wrapper, or nil for anything else.
    public static func data(from value: Any?) -> Data? {
        guard let dict = value as? [String: Any],
              let encoded = dict[key] as? String else { return nil }
        return Data(base64Encoded: encoded)
    }
}

public enum WebviewMessage: Equatable {
    case ready
    case update(content: String, baseSyncVersion: Int, seq: Int)
    case flushResult(id: String, content: String, baseSyncVersion: Int, seq: Int)
    case viewState(json: String)
    case openUrl(String)
    case openHostPreferences
    /// `/ai`: the request typed after the pill, with the id the page will
    /// match every `agentRun` report against.
    case askAgent(prompt: String?, requestId: String?, model: String?, effort: String?)
    /// Cancel a run, from a click on its gutter marker. The wire name is
    /// `agentCancel`, which is what `notifyAgentCancel` posts; a case
    /// spelled anything else is a case nothing ever reaches.
    case agentCancel(requestId: String)
    /// What the page's merge did with a finished run: `applied`, `partial`,
    /// `conflict` or `unchanged`. Jot acts on it because `partial` and
    /// `conflict` leave the agent's version only in the file, and Jot's
    /// autosave is about to write the buffer over it (`AgentRescuePolicy`).
    case agentMergeResult(requestId: String, outcome: String)
    /// A file the `/ai-advanced` composer is attaching, on its way to a path
    /// the agent can read. `bytes` is base64: unlike `uploadImage`, which uses
    /// the `$bytes` wrapper, the panel encodes this one itself and sends a
    /// plain string (`shared/messages.ts`).
    ///
    /// Jot MUST answer, and answering is not optional politeness: the composer
    /// disables Send while any attachment is unresolved, so a request that
    /// never comes back leaves the panel unable to send anything at all, the
    /// typed prompt included.
    case agentAttachment(id: String, name: String, bytes: Data)
    case clipboardWrite(format: String, data: String)
    /// The selection palette's button: put a reference to where the caret is,
    /// and the selected lines, on the clipboard. Answered by asking the page
    /// where the selection is (`requestEditorContext`), because only the page
    /// knows and only the shell knows the file's path.
    case copyAgentReference
    /// Reply to `requestEditorContext`. The primary selection's ends, in
    /// document coordinates, or nil when the page could not place them.
    case editorContextResult(id: String, selection: AgentReference.Selection?)
    case setToolbarLayout(itemId: String?, placement: String?, order: [String])
    case setToolbarVisible(Bool)
    case setFontPreset(String)
    case setFontSize(Int)
    case setContentWidth(String)
    case focusState(Bool)
    case crash(message: String, source: String)
    case uploadImage(id: String, data: Data, mimeType: String, altText: String)
    /// Link-card metadata for a link sitting alone on its own line.
    case resolveLinkCard(id: String, url: String)
    /// The title of a bare URL just pasted, so its link text can be upgraded.
    case unfurlUrl(id: String, url: String)
    /// Embed-card caption for a recognized provider. Jot answers it with
    /// nothing (see `Coordinator`), but must answer: the page keeps a pending
    /// request until it hears back.
    case resolveEmbedMeta(id: String, url: String)
    case perfMarks(json: String)
    /// The page asked for the app's own date picker, anchored at the caret
    /// rectangle (viewport coordinates, CSS pixels).
    case showDatePicker(id: String, left: Double, top: Double, bottom: Double)
    case other(type: String)

    public static func parse(_ text: String) -> WebviewMessage? {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data),
              let dict = obj as? [String: Any],
              let type = dict["type"] as? String else { return nil }
        func str(_ k: String) -> String? { dict[k] as? String }
        func int(_ k: String) -> Int? { (dict[k] as? NSNumber)?.intValue }
        func double(_ k: String) -> Double? { (dict[k] as? NSNumber)?.doubleValue }
        func bool(_ k: String) -> Bool? { dict[k] as? Bool }
        func bytes(_ k: String) -> Data? { BinaryPayload.data(from: dict[k]) }
        func json(_ k: String) -> String? {
            guard let v = dict[k], JSONSerialization.isValidJSONObject(v),
                  let d = try? JSONSerialization.data(withJSONObject: v, options: [.sortedKeys]) else { return nil }
            return String(decoding: d, as: UTF8.self)
        }
        /// The PRIMARY selection out of an `EditorSelectionContext`
        /// (shared/agentContext.ts). Only its two ends and whether it is a
        /// caret are read: the plain text it also carries is the page's
        /// stripped version, and the shell holds the real source.
        func selection(from value: Any?) -> AgentReference.Selection? {
            guard let context = value as? [String: Any],
                  let selections = context["selections"] as? [Any] else { return nil }
            let index = (context["primary"] as? NSNumber)?.intValue ?? 0
            let candidate: Any? = selections.indices.contains(index) ? selections[index] : selections.first
            guard let entry = candidate as? [String: Any] else { return nil }
            func position(_ key: String) -> AgentReference.Position? {
                guard let p = entry[key] as? [String: Any],
                      let line = (p["line"] as? NSNumber)?.intValue,
                      let column = (p["column"] as? NSNumber)?.intValue else { return nil }
                return .init(line: line, column: column)
            }
            guard let anchor = position("anchor"), let active = position("active") else { return nil }
            return .init(anchor: anchor, active: active,
                         isEmpty: context["isEmpty"] as? Bool ?? false)
        }
        switch type {
        case "ready": return .ready
        case "update":
            guard let c = str("content"), let b = int("baseSyncVersion"), let s = int("seq") else { return .other(type: type) }
            return .update(content: c, baseSyncVersion: b, seq: s)
        case "flushResult":
            guard let id = str("id"), let c = str("content"), let b = int("baseSyncVersion"), let s = int("seq") else { return .other(type: type) }
            return .flushResult(id: id, content: c, baseSyncVersion: b, seq: s)
        case "viewState": return .viewState(json: json("state") ?? "{}")
        case "openUrl": return str("url").map { .openUrl($0) } ?? .other(type: type)
        case "openHostPreferences": return .openHostPreferences
        case "askAgent", "askAgentAdvanced":
            return .askAgent(prompt: str("prompt"), requestId: str("requestId"),
                             model: str("model"), effort: str("effort"))
        case "agentCancel":
            return str("requestId").map { .agentCancel(requestId: $0) } ?? .other(type: type)
        case "agentMergeResult":
            guard let id = str("requestId"), let outcome = str("outcome") else { return .other(type: type) }
            return .agentMergeResult(requestId: id, outcome: outcome)
        case "agentAttachment":
            // A missing or undecodable payload is answered rather than
            // dropped: `agentAttachmentSaved` with a null path is what tells
            // the panel to mark the chip failed and re-enable Send.
            guard let id = str("id") else { return .other(type: type) }
            return .agentAttachment(id: id,
                                    name: str("name") ?? "",
                                    bytes: str("bytes").flatMap { Data(base64Encoded: $0) } ?? Data())
        case "clipboardWrite":
            guard let f = str("format"), let d = str("data") else { return .other(type: type) }
            return .clipboardWrite(format: f, data: d)
        case "copyAgentReference":
            return .copyAgentReference
        case "editorContextResult":
            guard let id = str("id") else { return .other(type: type) }
            return .editorContextResult(id: id, selection: selection(from: dict["context"]))
        case "setToolbarLayout":
            let item = dict["item"] as? [String: Any]
            let order = (dict["order"] as? [Any])?.compactMap { $0 as? String } ?? []
            return .setToolbarLayout(itemId: item?["id"] as? String, placement: item?["placement"] as? String, order: order)
        case "setToolbarVisible": return bool("visible").map { .setToolbarVisible($0) } ?? .other(type: type)
        case "setFontPreset": return str("preset").map { .setFontPreset($0) } ?? .other(type: type)
        case "setFontSize": return int("size").map { .setFontSize($0) } ?? .other(type: type)
        case "setContentWidth": return str("mode").map { .setContentWidth($0) } ?? .other(type: type)
        case "focusState": return bool("focused").map { .focusState($0) } ?? .other(type: type)
        case "crash": return .crash(message: str("message") ?? "", source: str("source") ?? "")
        case "uploadImage":
            // No bytes is `.other`, not an upload with an empty payload: the
            // shell must answer an upload it cannot fulfil with an error the
            // user sees, and silently saving nothing is the one outcome that
            // looks like success.
            guard let id = str("id"), let data = bytes("data"), !data.isEmpty else {
                return .other(type: type)
            }
            return .uploadImage(id: id,
                                data: data,
                                mimeType: str("mimeType") ?? "",
                                altText: str("altText") ?? "")
        case "resolveLinkCard":
            guard let id = str("id"), let u = str("url") else { return .other(type: type) }
            return .resolveLinkCard(id: id, url: u)
        case "unfurlUrl":
            guard let id = str("id"), let u = str("url") else { return .other(type: type) }
            return .unfurlUrl(id: id, url: u)
        case "resolveEmbedMeta":
            guard let id = str("id"), let u = str("url") else { return .other(type: type) }
            return .resolveEmbedMeta(id: id, url: u)
        case "showDatePicker":
            // A picker with no anchor would open at the window's origin rather
            // than at the caret, which is worse than not opening, so a request
            // missing its rectangle is not a request.
            guard let id = str("id"),
                  let left = double("left"), let top = double("top"), let bottom = double("bottom")
            else { return .other(type: type) }
            return .showDatePicker(id: id, left: left, top: top, bottom: bottom)
        case "__perfMarks": return .perfMarks(json: json("marks") ?? "{}")
        default: return .other(type: type)
        }
    }
}

/// Outbound messages. `jsonObject()` is what gets marshalled into
/// `window.postMessage(...)`; the shapes mirror `ToWebviewMessage`.
public enum HostMessage: Equatable {
    case initDoc(content: String, syncVersion: Int, viewStateJSON: String?)
    case externalUpdate(content: String, syncVersion: Int)
    case flushSave(id: String)
    case flushAck(id: String, applied: Bool)
    /// Reply to `uploadImage`: `url` is what goes INTO the document, so it is
    /// the store's relative reference rather than a path on this machine.
    case imageUploaded(id: String, url: String)
    case imageUploadError(id: String, error: String)
    /// Reply to `resolveLinkCard`. A nil title AND description is sent as a
    /// null card, which is the contract's "nothing usable, leave the link
    /// alone" rather than a card with empty fields.
    case linkCardResult(id: String, url: String, title: String?, description: String?)
    /// Reply to `unfurlUrl`. A nil title means the webview keeps the bare
    /// `[url](url)` it already inserted, which is the offline-safe default.
    case unfurlResult(id: String, url: String, title: String?)
    /// Reply to `resolveEmbedMeta`.
    case embedMetaResult(id: String, url: String, title: String?)
    /// Reply to `agentAttachment`: where the bytes went, or nil when they
    /// could not be written. Nil is a real answer; the panel marks that chip
    /// failed and stops waiting on it.
    case agentAttachmentSaved(id: String, path: String?)
    case toolbarConfig(json: String)
    case getPerfMarks(id: String)
    /// Ask the page where the selection is. Answered with
    /// `editorContextResult` carrying the same `id`; the page maps its own
    /// selection onto document lines (webview/agentContext.ts), which is a
    /// question only it can answer.
    case requestEditorContext(id: String)
    /// The app's date picker closed. `date` is nil when it was dismissed
    /// without a pick, and the reply is sent either way so the page never
    /// waits on a picker that is gone.
    ///
    /// A DAY, never a string: `webview/utils/dateFormat.ts` owns the one
    /// spelling of a date, so the app reports what was chosen and the editor
    /// writes it. That is what keeps the two surfaces from drifting into two
    /// formats of the same date.
    case datePickerResult(id: String, date: CalendarDay?)
    /// Run one editor command by id (shared/editorCommands.ts), the way a
    /// contributed keybinding reaches the page.
    case editorCommand(String)
    /// One report about an `/ai` run. `status` drives the gutter marker the
    /// page already draws for the extension.
    case agentRun(requestId: String, status: String, harness: String?, text: String?, message: String?)
    /// Measurement-only: an arbitrary message object, so `jot/scripts/measure.sh`
    /// can drive the test-only page commands (`__testInsertText`, `__getPerfMarks`).
    case raw(json: String)

    public func jsonObject() -> [String: Any] {
        switch self {
        case let .raw(json):
            return (json.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
        case let .initDoc(content, syncVersion, viewStateJSON):
            var o: [String: Any] = ["type": "init", "content": content, "syncVersion": syncVersion]
            if let vs = viewStateJSON, let d = vs.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: d), obj is [String: Any] {
                o["viewState"] = obj
            }
            return o
        case let .externalUpdate(content, syncVersion):
            return ["type": "externalUpdate", "content": content, "syncVersion": syncVersion]
        case let .agentRun(requestId, status, harness, text, message):
            var o: [String: Any] = ["type": "agentRun", "requestId": requestId, "status": status]
            if let harness { o["harness"] = harness }
            if let text { o["text"] = text }
            if let message { o["message"] = message }
            return o
        case let .flushSave(id):
            return ["type": "flushSave", "id": id]
        case let .flushAck(id, applied):
            return ["type": "flushAck", "id": id, "applied": applied]
        case let .imageUploaded(id, url):
            return ["type": "imageUploaded", "id": id, "url": url]
        case let .imageUploadError(id, error):
            return ["type": "imageUploadError", "id": id, "error": error]
        case let .linkCardResult(id, url, title, description):
            var card: Any = NSNull()
            if title != nil || description != nil {
                var fields: [String: Any] = [:]
                fields["title"] = title ?? NSNull()
                fields["description"] = description ?? NSNull()
                card = fields
            }
            return ["type": "linkCardResult", "id": id, "url": url, "card": card]
        case let .unfurlResult(id, url, title):
            return ["type": "unfurlResult", "id": id, "url": url, "title": title ?? NSNull()]
        case let .embedMetaResult(id, url, title):
            return ["type": "embedMetaResult", "id": id, "url": url, "title": title ?? NSNull()]
        case let .agentAttachmentSaved(id, path):
            return ["type": "agentAttachmentSaved", "id": id, "path": path ?? NSNull()]
        case let .toolbarConfig(json):
            let config = (json.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
            return ["type": "toolbarConfig", "config": config]
        case let .requestEditorContext(id):
            return ["type": "requestEditorContext", "id": id]
        case let .datePickerResult(id, date):
            return ["type": "datePickerResult", "id": id,
                    "date": date.map { ["year": $0.year, "month": $0.month, "day": $0.day] } ?? NSNull()]
        case let .getPerfMarks(id):
            return ["type": "__getPerfMarks", "id": id]
        case let .editorCommand(command):
            return ["type": "editorCommand", "command": command]
        }
    }

    public func jsonString() -> String {
        let d = (try? JSONSerialization.data(withJSONObject: jsonObject(), options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: d, as: UTF8.self)
    }
}

/// The `window.__i18n` config blob the page reads at boot, and the
/// `acquireVsCodeApi` shim. Built here so the exact JS the shell injects is
/// testable text rather than a string assembled in three places.
/// One shortcut the host binds itself, as the cheatsheet prints it.
public struct HostShortcut: Equatable, Sendable {
    /// The chord in the page's own notation ("Cmd+Shift+D").
    public let keys: String
    /// What it does, in the words the menu uses.
    public let label: String

    public init(keys: String, label: String) {
        self.keys = keys
        self.label = label
    }

    /// A chord in the ProseMirror keymap notation the page already speaks
    /// (`Mod-Shift-d`), which is what `kbd()` in `webview/i18n` parses.
    ///
    /// Not a rendered chord. The panel runs these through the same helper its
    /// own rows use, so they come out as ⌘⇧D beside everything else instead of
    /// as a differently spelled string in the same column. Order is the order
    /// that helper prints, since it renders the parts as it is given them.
    ///
    /// `Mod` rather than `Cmd`: the notation means "the platform's command
    /// key", and it is the token `kbd()` maps.
    public static func chord(
        key: String, command: Bool = false, shift: Bool = false,
        option: Bool = false, control: Bool = false
    ) -> String {
        var parts: [String] = []
        if command { parts.append("Mod") }
        if control { parts.append("Ctrl") }
        if option { parts.append("Alt") }
        if shift { parts.append("Shift") }
        parts.append(key)
        return parts.joined(separator: "-")
    }
}

public struct BootConfig: Equatable {
    /// `toolbar` config as the page expects it: `{placements, order}` plus `visible`.
    public var toolbarJSON: String
    public var fontPreset: String
    public var fontSize: Int
    public var contentWidth: String
    public var networkEnabled: Bool
    public var hostCapabilities: [String]
    /// Persisted `viewState` bag, JSON object text, or nil.
    public var viewStateJSON: String?
    /// The host's OWN fixed shortcuts, for the cheatsheet to print. Only a
    /// host that truly fixes a key may declare one: the panel's whole content
    /// policy is that a printed key cannot lie, and in VS Code these are
    /// rebindable, which is why it declares none and links to its own UI.
    public var hostShortcuts: [HostShortcut]

    public init(toolbarJSON: String = #"{"placements":{},"order":[]}"#,
                fontPreset: String = "editor",
                fontSize: Int = 100,
                contentWidth: String = "full",
                networkEnabled: Bool = false,
                hostCapabilities: [String] = [],
                viewStateJSON: String? = nil,
                hostShortcuts: [HostShortcut] = []) {
        self.hostShortcuts = hostShortcuts
        self.toolbarJSON = toolbarJSON
        self.fontPreset = fontPreset
        self.fontSize = fontSize
        self.contentWidth = contentWidth
        self.networkEnabled = networkEnabled
        self.hostCapabilities = hostCapabilities
        self.viewStateJSON = viewStateJSON
    }

    /// The `__i18n` object. Every consumer in the page reads it with a
    /// default, so this lists only what Jot decides.
    public func i18nObject() -> [String: Any] {
        let toolbar = (toolbarJSON.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])
            ?? ["placements": [String: Any](), "order": [String]()]
        return [
            "translations": [String: String](),
            "isMac": true,
            "toolbar": toolbar,
            // Everything Jot says about ITSELF, in the one key the editor reads
            // (shared/hostProfile.ts). `arrangements` are layout choices rather
            // than capabilities: every control named here exists on both
            // surfaces and runs the same command, and only its holder differs.
            //
            //   typographyInGearMenu      the panel's toolbar is short and its
            //     right-hand block is always on screen, so the typography rows
            //     read better inside the gear than as a second dropdown.
            //   formattingInSecondRow    the titlebar row is the window's, so
            //     the editing controls leave it: the file name sits beside the
            //     traffic lights and the dock holds the rest.
            //   fixedToolbarLayout        two controls and a fixed dock is not
            //     an arrangement worth offering to rearrange, and the bar is
            //     the only route to search and settings, so it does not hide.
            //   barMenusOnClick           a window's own menus open on a click,
            //     and a panel summoned under the pointer would otherwise open
            //     one on arrival.
            //   nativeFindBar             every other control in this window is
            //     a native one, so the search field is drawn as macOS draws
            //     one and its four options move behind a ⋯ button.
            "host": [
                "capabilities": hostCapabilities,
                "arrangements": ["typographyInGearMenu", "formattingInSecondRow", "fixedToolbarLayout", "barMenusOnClick", "nativeFindBar", "nativeDatePicker"],
                "shortcuts": hostShortcuts.map { ["keys": $0.keys, "label": $0.label] },
            ],
            "fontPreset": fontPreset,
            "fontSize": fontSize,
            "contentWidth": contentWidth,
            "network": networkEnabled,
            // All three ride the one network switch. An embed renders in an
            // iframe the page loads itself; a link card and a pasted link's
            // title are fetched by the HOST, which the shell now answers
            // (`Coordinator.resolveLinkCard` and `unfurl`, under the SSRF
            // guard and the byte and time bounds in `PageMetadataFetcher`).
            //
            // `pasteUnfurlAutoApply` is deliberately absent, so it keeps its
            // default of false: a fetched title arrives as an offer at the
            // link and nothing reaches the file until the user takes it. That
            // is what keeps this rung 1 "a URL you typed" rather than
            // something that writes on its own (docs/NETWORK_POSTURE.md).
            "embedsEnabled": networkEnabled,
            "linkCardsEnabled": networkEnabled,
            "pasteUnfurl": networkEnabled,
            "calcEnabled": true,
            "calcBlocksEnabled": true,
            // No sidebar in Jot: belt to the `toc` capability's braces.
            "tocVisibility": "hidden",
            // Proofreading is a host capability Jot does not declare, and the
            // engine defaults ON when the snapshot is absent; the capability
            // gates the chrome, this gates the work (webview/plugins/proofread.ts).
            "proofread": ["proofreadingEnabled": hostCapabilities.contains("proofreading")],
        ]
    }

    /// The document-start user script: `__i18n`, the `acquireVsCodeApi` shim
    /// and the initial theme class.
    ///
    /// The replacer is the binary seam. A message carrying image bytes
    /// (`uploadImage`) holds a `Uint8Array`, which `JSON.stringify` would turn
    /// into an object keyed by index ("0", "1", ...) and which the message
    /// handler cannot marshal at all, so it is encoded as base64 under
    /// `$bytes`. Chunked rather than one `apply` over the whole array, because
    /// `String.fromCharCode.apply` on a multi-megabyte screenshot exceeds the
    /// argument limit and throws.
    public func userScript(themeClass: String) -> String {
        let i18n = jsonText(i18nObject())
        let state = viewStateJSON ?? "null"
        return """
        (function () {
          window.__i18n = \(i18n);
          var state = \(state);
          document.addEventListener("DOMContentLoaded", function () {
            document.body.classList.add(\(jsonText(themeClass)));
          });
          function toBase64(bytes) {
            var CHUNK = 8192;
            var parts = [];
            // The comparison is written the long way round on purpose: this
            // script contains no angle bracket, so it stays safe to inline
            // into HTML, and BridgeTests pins that.
            for (var i = 0; bytes.length > i; i += CHUNK) {
              parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
            }
            return btoa(parts.join(""));
          }
          function replacer(key, value) {
            if (value instanceof ArrayBuffer) {
              return { "\(BinaryPayload.key)": toBase64(new Uint8Array(value)) };
            }
            if (value && ArrayBuffer.isView(value)) {
              return { "\(BinaryPayload.key)": toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
            }
            return value;
          }
          window.acquireVsCodeApi = function () {
            return {
              postMessage: function (m) { window.webkit.messageHandlers.birta.postMessage(JSON.stringify(m, replacer)); },
              getState: function () { return state; },
              setState: function (s) { state = s; }
            };
          };
        })();
        """
    }

    private func jsonText(_ value: Any) -> String {
        let d = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])) ?? Data("null".utf8)
        // `<` inside a script would end a <script> in HTML; this is a user
        // script, but the same escape costs nothing and keeps the text safe to
        // inline later.
        return String(decoding: d, as: UTF8.self).replacingOccurrences(of: "<", with: "\\u003c")
    }
}

/// The toolbar layout Jot persists on the host side, in place of the
/// `birta.toolbar.*` settings the extension writes. Fed back to the page as
/// `__i18n.toolbar` at boot and as a `toolbarConfig` message after a change.
public struct ToolbarLayout: Codable, Equatable {
    public var placements: [String: String]
    public var order: [String]
    public var visible: Bool

    public init(placements: [String: String] = [:], order: [String] = [], visible: Bool = true) {
        self.placements = placements
        self.order = order
        self.visible = visible
    }

    /// Fold one `setToolbarLayout` message in: the moved item's placement, and
    /// the zone order the page reports.
    public mutating func apply(itemId: String?, placement: String?, order: [String]) {
        if let id = itemId, let p = placement { placements[id] = p }
        self.order = order
    }

    public var json: String {
        let d = (try? JSONEncoder.sortedKeys.encode(self)) ?? Data("{}".utf8)
        return String(decoding: d, as: UTF8.self)
    }

    public static func fromJSON(_ text: String?) -> ToolbarLayout {
        guard let t = text, let d = t.data(using: .utf8), let v = try? JSONDecoder().decode(ToolbarLayout.self, from: d) else {
            return ToolbarLayout()
        }
        return v
    }
}

extension JSONEncoder {
    static var sortedKeys: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }
}
