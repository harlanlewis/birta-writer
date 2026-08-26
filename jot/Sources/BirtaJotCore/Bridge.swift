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
    /// The three things the table-of-contents panel remembers: whether it is
    /// out, which edge it is docked to, and how wide it was dragged. The page
    /// reports each as the user settles it, and a fresh page is booted back
    /// into what it reported, so a panel the reader opened is open the next
    /// time the window loads a file.
    /// Blocks of plain text for the host's spelling and grammar checker. The
    /// page holds the request open until it is answered, so a host that
    /// declares `spellAndGrammar` must reply with `lintResults` carrying the
    /// same `id`, even when it found nothing.
    case lintBlocks(id: Int, blocks: [LintBlock])
    /// "Add to dictionary" on a spelling hit.
    case spellAddWord(String)
    /// One row of the Checks menu, by the page's own option key.
    case setProofreadOption(key: String, value: Bool)
    /// "Keep this phrase" on a style hit: the flagged text is the writer's own
    /// and no check may flag it again.
    case styleAddException(String)
    case setTocVisibility(String)
    case setTocPosition(String)
    case setTocWidth(Int)
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
    /// One step of a flow the page is driving, to be drawn as a sheet. `step`
    /// is nil for a kind this build cannot draw, which is answered explicitly
    /// rather than dropped (MAR-395; the silence hazard is MAR-390).
    case hostPrompt(id: String, step: HostPromptStep?)
    /// The page is composing a feedback report and wants the facts only this
    /// host has: the app's version, macOS, and this app's own settings.
    case requestHostDiagnostics(id: String)
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
        case "lintBlocks":
            // A block the page could not describe is skipped rather than
            // failing the batch: the rest of the document is still worth
            // checking, and the reply carries only the keys it answers for.
            guard let id = int("id") else { return .other(type: type) }
            let blocks = (dict["blocks"] as? [Any] ?? []).compactMap { entry -> LintBlock? in
                guard let row = entry as? [String: Any],
                      let key = (row["key"] as? NSNumber)?.intValue,
                      let text = row["text"] as? String else { return nil }
                return LintBlock(key: key, text: text)
            }
            return .lintBlocks(id: id, blocks: blocks)
        case "spellAddWord": return str("word").map { .spellAddWord($0) } ?? .other(type: type)
        case "setProofreadOption":
            guard let key = str("key"), let value = bool("value") else { return .other(type: type) }
            return .setProofreadOption(key: key, value: value)
        case "styleAddException": return str("phrase").map { .styleAddException($0) } ?? .other(type: type)
        // The page's own spellings, which are three rather than one because
        // these grew in the extension at different times: the panel reports
        // its visibility as `tocVisibility`, its width as `tocWidth`, and its
        // side as `setTocPosition`.
        case "tocVisibility": return str("visibility").map { .setTocVisibility($0) } ?? .other(type: type)
        case "setTocPosition": return str("position").map { .setTocPosition($0) } ?? .other(type: type)
        case "tocWidth": return int("width").map { .setTocWidth($0) } ?? .other(type: type)
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
        case "hostPrompt":
            // A request with no id cannot be answered, so it is not a request.
            // A step that does not parse IS still a request: it is answered as
            // unsupported, which is the whole reason the associated value is
            // optional rather than the case being dropped.
            guard let id = str("id") else { return .other(type: type) }
            return .hostPrompt(id: id, step: HostPromptStep.parse(dict["step"]))
        case "requestHostDiagnostics":
            guard let id = str("id") else { return .other(type: type) }
            return .requestHostDiagnostics(id: id)
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
    /// Reply to `lintBlocks`, carrying the request's own `id` so a slow answer
    /// that a newer request has already superseded is dropped by the page
    /// rather than drawn over fresher text.
    case lintResults(id: Int, results: [LintBlockResult])
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
    /// The answer to one `hostPrompt`. `value` is the text typed or the row's
    /// id; nil is a cancel. `unsupported` says this build cannot draw the step
    /// at all, which the page reports rather than treating as a cancel.
    case hostPromptResult(id: String, value: String?, unsupported: Bool)
    case hostDiagnosticsResult(id: String, diagnostics: HostDiagnostics)
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
        case let .lintResults(id, results):
            return ["type": "lintResults", "id": id, "results": results.map(\.json)]
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
        case let .hostPromptResult(id, value, unsupported):
            var out: [String: Any] = ["type": "hostPromptResult", "id": id,
                                      "value": value ?? NSNull()]
            // Present only when true: the page's type has it optional, and an
            // explicit `false` on every reply would be noise on the wire.
            if unsupported { out["unsupported"] = true }
            return out
        case let .hostDiagnosticsResult(id, diagnostics):
            return ["type": "hostDiagnosticsResult", "id": id,
                    "diagnostics": diagnostics.jsonObject]
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
    /// The editor command the key runs (`shared/editorCommands.ts`), or nil
    /// where the key is the shell's own gesture and reaches no command.
    ///
    /// What the page does with it: chrome resolves a command to a printable
    /// chord through this field (`webview/commandChords.ts`), so the link
    /// button's tooltip says ⌘K here and says nothing inside VS Code, where the
    /// binding is the user's to change and unreadable from the page.
    public let command: String?
    /// The menu the key lives in, as the cheatsheet's section heading.
    public let section: String?

    public init(keys: String, label: String, command: String? = nil, section: String? = nil) {
        self.keys = keys
        self.label = label
        self.command = command
        self.section = section
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

    /// The same chord as menu-bar symbols (⇧⌘S), in Apple's modifier order.
    ///
    /// For a control that DRAWS its own chord rather than handing one to the
    /// page: the global hotkey's spelling in Settings, and the tooltips on the
    /// titlebar's buttons. Here beside `chord` because both are one rule about
    /// how a chord is written down, and the order is the half that a second
    /// copy would eventually get wrong: ⌃⌥⇧⌘ is what AppKit draws a key
    /// equivalent in, so a control spelling it any other way is a control
    /// whose chord does not match the menu row printing the same gesture two
    /// inches away.
    public static func symbols(
        key: String, command: Bool = false, shift: Bool = false,
        option: Bool = false, control: Bool = false
    ) -> String {
        var out = ""
        if control { out += "⌃" }
        if option { out += "⌥" }
        if shift { out += "⇧" }
        if command { out += "⌘" }
        return out + key.uppercased()
    }
}

public struct BootConfig: Equatable {
    /// `toolbar` config as the page expects it: `{placements, order}` plus `visible`.
    public var toolbarJSON: String
    public var fontPreset: String
    public var fontSize: Int
    public var contentWidth: String
    /// The table-of-contents panel as the reader last left it: "shown",
    /// "hidden" or "auto" for the page's own heading-count heuristic, the side
    /// it is docked to, and its width in CSS pixels (nil for the page's
    /// default). The page CLAMPS the width it is given, so no bound is
    /// restated here.
    /// The Checks menu's answers, by the page's own option key. Only what the
    /// reader changed; an empty map sends nothing and the page keeps its
    /// defaults.
    public var proofreadOptions: [String: Bool]
    /// Phrases the reader has claimed as their own, which no style check may
    /// flag again. A `ProofreadConfig` field rather than an option key, so it
    /// travels in `proofread` beside nothing else: it is stored user DATA, not
    /// a decision about which checks a host can run, which is the page's.
    public var styleExceptions: [String]
    public var tocVisibility: String
    public var tocWidth: Int?
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
                proofreadOptions: [String: Bool] = [:],
                styleExceptions: [String] = [],
                tocVisibility: String = "hidden",
                tocWidth: Int? = nil,
                networkEnabled: Bool = false,
                hostCapabilities: [String] = [],
                viewStateJSON: String? = nil,
                hostShortcuts: [HostShortcut] = []) {
        self.hostShortcuts = hostShortcuts
        self.toolbarJSON = toolbarJSON
        self.fontPreset = fontPreset
        self.fontSize = fontSize
        self.contentWidth = contentWidth
        self.proofreadOptions = proofreadOptions
        self.styleExceptions = styleExceptions
        self.tocVisibility = tocVisibility
        self.tocWidth = tocWidth
        self.networkEnabled = networkEnabled
        self.hostCapabilities = hostCapabilities
        self.viewStateJSON = viewStateJSON
    }

    /// The outline panel's width, as the rule the page reads it from.
    ///
    /// It rides the SERVED HTML rather than the boot script, and so does the
    /// side (`BirtaSchemeHandler.renderPage`, which writes `toc-right` on every
    /// page), because the page reads both while it mounts: the panel is built
    /// by the module script, which runs
    /// after the document is parsed and before `DOMContentLoaded`, so a boot
    /// script has no moment that is both late enough to have a document and
    /// early enough to be read. Empty when nothing has been stored, so the page
    /// keeps its own default rather than being handed a number this side
    /// invented.
    public var tocRootStyle: String {
        tocWidth.map { ":root { --toc-width: \($0)px; }" } ?? ""
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
            //   nativeDatePicker          this is an application, so `/date`
            //     shows the picker macOS already has.
            //   fixedTocSide              a macOS sidebar is on the trailing
            //     edge. The page is told which edge by `body.toc-right`, which
            //     `WebHost` writes unconditionally; this says the reader is not
            //     offered the other one, so the panel drops its flip button and
            //     Swap Sides leaves the palette and the slash menu with it.
            //   tocToggleInBar            the bar already carries a button that
            //     shows and hides the sidebar, at the corner the panel's own
            //     hide button and reveal tab would sit in. One of the two has
            //     to go, and the one that stays is the one that is on screen
            //     whether the sidebar is open or shut; it inherits the reveal
            //     tab's hover preview rather than replacing it with nothing.
            "host": [
                "capabilities": hostCapabilities,
                "arrangements": ["typographyInGearMenu", "formattingInSecondRow", "fixedToolbarLayout", "barMenusOnClick", "nativeFindBar", "nativeDatePicker", "fixedTocSide", "tocToggleInBar"],
                "shortcuts": hostShortcuts.map { shortcut -> [String: Any] in
                // The optional halves are omitted rather than sent as null: an
                // absent `command` is the claim "this key runs no editor
                // command", which is what the page's own optional field means.
                var row: [String: Any] = ["keys": shortcut.keys, "label": shortcut.label]
                if let command = shortcut.command { row["command"] = command }
                if let section = shortcut.section { row["section"] = section }
                return row
            },
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
            // The Checks answers, exactly as the menu posted them, and no
            // `proofread` config beside them. Which of the checks can RUN is
            // the page's to decide from the capabilities above, and a config
            // computed here would be a second declarer of that: one is how the
            // whole pass came to be switched off on this surface, by testing
            // `hostCapabilities` for a name a rename had taken away.
            "proofreadOptions": proofreadOptions,
            // The kept phrases, and ONLY them. Still no config computed here:
            // this is a list the reader built, where `proofreadingEnabled` and
            // its siblings are decisions about what a surface can run.
            "proofread": ["styleExceptions": styleExceptions],
            // The panel as the reader last left it. A first launch gets
            // "hidden" rather than "auto": the page's heuristic opens the
            // sidebar once a document has a few headings, which is right for an
            // editor pane and wrong for a window this size, where the outline
            // is something you ask for.
            "tocVisibility": tocVisibility,
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
