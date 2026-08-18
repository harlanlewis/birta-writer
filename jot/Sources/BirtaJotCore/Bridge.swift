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
    case clipboardWrite(format: String, data: String)
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
    case other(type: String)

    public static func parse(_ text: String) -> WebviewMessage? {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data),
              let dict = obj as? [String: Any],
              let type = dict["type"] as? String else { return nil }
        func str(_ k: String) -> String? { dict[k] as? String }
        func int(_ k: String) -> Int? { (dict[k] as? NSNumber)?.intValue }
        func bool(_ k: String) -> Bool? { dict[k] as? Bool }
        func bytes(_ k: String) -> Data? { BinaryPayload.data(from: dict[k]) }
        func json(_ k: String) -> String? {
            guard let v = dict[k], JSONSerialization.isValidJSONObject(v),
                  let d = try? JSONSerialization.data(withJSONObject: v, options: [.sortedKeys]) else { return nil }
            return String(decoding: d, as: UTF8.self)
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
        case "clipboardWrite":
            guard let f = str("format"), let d = str("data") else { return .other(type: type) }
            return .clipboardWrite(format: f, data: d)
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
    case toolbarConfig(json: String)
    case getPerfMarks(id: String)
    /// Run one editor command by id (shared/editorCommands.ts), the way a
    /// contributed keybinding reaches the page.
    case editorCommand(String)
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
        case let .toolbarConfig(json):
            let config = (json.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
            return ["type": "toolbarConfig", "config": config]
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

    public init(toolbarJSON: String = #"{"placements":{},"order":[]}"#,
                fontPreset: String = "editor",
                fontSize: Int = 100,
                contentWidth: String = "full",
                networkEnabled: Bool = false,
                hostCapabilities: [String] = [],
                viewStateJSON: String? = nil) {
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
            "hostCapabilities": hostCapabilities,
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
