import Foundation

/// The webview↔host message protocol, host side. The vocabulary is
/// `shared/messages.ts` (`ToExtensionMessage` inbound, `ToWebviewMessage`
/// outbound); Jot speaks the subset a scratchpad needs and files everything
/// else under `.other`, which is logged and never fatal.
///
/// Inbound messages arrive as JSON text (the shim in the page stringifies
/// before `webkit.messageHandlers.birta.postMessage`, so typed arrays and
/// other unmarshallable values are already replaced by null).
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
    case uploadImage(id: String)
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
        case "uploadImage": return str("id").map { .uploadImage(id: $0) } ?? .other(type: type)
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
    case imageUploadError(id: String, error: String)
    case toolbarConfig(json: String)
    case getPerfMarks(id: String)
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
        case let .imageUploadError(id, error):
            return ["type": "imageUploadError", "id": id, "error": error]
        case let .toolbarConfig(json):
            let config = (json.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
            return ["type": "toolbarConfig", "config": config]
        case let .getPerfMarks(id):
            return ["type": "__getPerfMarks", "id": id]
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
            "embedsEnabled": networkEnabled,
            "linkCardsEnabled": networkEnabled,
            "calcEnabled": true,
            "calcBlocksEnabled": true,
            "hostCapabilities": hostCapabilities,
            // No sidebar in Jot: belt to the `toc` capability's braces.
            "tocVisibility": "hidden",
        ]
    }

    /// The document-start user script: `__i18n`, the `acquireVsCodeApi` shim
    /// and the initial theme class. Typed arrays are replaced by null before
    /// posting because `WKScriptMessage` cannot marshal them (`uploadImage`
    /// carries one; the shell answers it with an error).
    public func userScript(themeClass: String) -> String {
        let i18n = jsonText(i18nObject())
        let state = viewStateJSON ?? "null"
        return """
        (function () {
          window.__i18n = \(i18n);
          var state = \(state);
          document.documentElement.classList.add(\(jsonText(themeClass)));
          document.addEventListener("DOMContentLoaded", function () {
            document.body.classList.add(\(jsonText(themeClass)));
          });
          function replacer(key, value) {
            if (value && (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)) { return null; }
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
