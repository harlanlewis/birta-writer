import Foundation

/// One step of a flow the page is driving, as it arrives over the bridge.
///
/// A literal reading of `HostPromptStep` in `shared/hostPrompt.ts`, and the
/// only thing about that seam this side owns: the questions, their order,
/// their validation rule and the composed report are all the page's, so a
/// second flow moving onto the seam adds a definition there and no Swift here.
/// That is the whole reason the seam exists, and it is what tells this apart
/// from `AgentRequest.swift` and `AgentReference.swift`, which are ports of
/// behaviour and carry headers naming where the two copies have diverged.
///
/// Parsing is strict, and a step that does not parse is not a step. A sheet
/// drawn from half a request would ask a question the page did not write, and
/// the page would then record the answer as if it had.
public enum HostPromptStep: Equatable {
    /// A free-text question.
    ///
    /// `required` and `maxLength` carry the message shown when they refuse,
    /// rather than a code this side would have to spell a sentence for: the
    /// wording is the page's, so both surfaces refuse a too-long title with
    /// the same words.
    case input(title: String, prompt: String, placeholder: String?,
               required: String?, maxLength: MaxLength?)
    /// A choice between named rows.
    case pick(title: String, placeholder: String?, rows: [Row])

    /// A ceiling, with the sentence shown when it refuses.
    public struct MaxLength: Equatable {
        public let value: Int
        public let message: String

        public init(value: Int, message: String) {
            self.value = value
            self.message = message
        }
    }

    public struct Row: Equatable {
        /// Returned verbatim as the answer when this row is chosen.
        public let id: String
        public let label: String
        /// The second line: what this row costs, or what it means.
        public let detail: String?

        public init(id: String, label: String, detail: String?) {
            self.id = id
            self.label = label
            self.detail = detail
        }
    }

    /// The title the sheet shows, whichever kind this is.
    public var title: String {
        switch self {
        case let .input(title, _, _, _, _): return title
        case let .pick(title, _, _): return title
        }
    }

    /// Read one step out of the message's `step` object.
    ///
    /// Returns nil for a kind this build does not draw, which the caller
    /// answers as `unsupported` rather than by staying silent: an unhandled
    /// message is dropped here with only a trace line (MAR-390), so silence
    /// would make a step this app cannot draw look exactly like one it
    /// correctly ignored.
    public static func parse(_ value: Any?) -> HostPromptStep? {
        guard let dict = value as? [String: Any], let kind = dict["kind"] as? String,
              let title = dict["title"] as? String else { return nil }
        let placeholder = dict["placeholder"] as? String

        switch kind {
        case "input":
            guard let prompt = dict["prompt"] as? String else { return nil }
            let required = (dict["required"] as? [String: Any])?["message"] as? String
            var maxLength: MaxLength?
            if let limit = dict["maxLength"] as? [String: Any],
               let count = (limit["value"] as? NSNumber)?.intValue,
               let message = limit["message"] as? String {
                maxLength = MaxLength(value: count, message: message)
            }
            return .input(title: title, prompt: prompt, placeholder: placeholder,
                          required: required, maxLength: maxLength)
        case "pick":
            // A pick with no rows is a question with no answers, which would
            // draw a sheet the user can only cancel.
            guard let raw = dict["rows"] as? [Any], !raw.isEmpty else { return nil }
            var rows: [Row] = []
            for entry in raw {
                guard let row = entry as? [String: Any],
                      let id = row["id"] as? String,
                      let label = row["label"] as? String else { return nil }
                rows.append(Row(id: id, label: label, detail: row["detail"] as? String))
            }
            return .pick(title: title, placeholder: placeholder, rows: rows)
        default:
            return nil
        }
    }

    /// The message to show for `value`, or nil when it is acceptable.
    ///
    /// A literal reading of `validateHostPromptInput`, including the trim:
    /// both surfaces have to agree on what an empty answer is, or one of them
    /// accepts a title made of spaces.
    public static func validate(_ value: String, required: String?,
                                maxLength: MaxLength?) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let required, trimmed.isEmpty { return required }
        if let maxLength, trimmed.count > maxLength.value { return maxLength.message }
        return nil
    }
}

/// What Birta Writer for Mac reports about itself when a feedback report asks.
///
/// It names THIS host, which is why the page cannot gather it: the extension
/// reports its own version, VS Code's and the `birta.*` settings that differ
/// from their defaults, and none of those three exist here. The app reports
/// the app, macOS, and its own settings.
///
/// Never the note, its path, or the folder it is in. `shared/feedback/
/// compose.ts` is never given any of them, and this is the only thing that
/// reaches it from this side.
public struct HostDiagnostics: Equatable {
    public let appVersion: String
    public let systemVersion: String
    public let platform: String
    public let changedSettings: [String]

    public init(appVersion: String, systemVersion: String, platform: String,
                changedSettings: [String]) {
        self.appVersion = appVersion
        self.systemVersion = systemVersion
        self.platform = platform
        self.changedSettings = changedSettings
    }

    /// The `Diagnostics` shape `shared/feedback/compose.ts` reads.
    ///
    /// `extensionVersion` and `hostVersion` are the field names the composer
    /// prints as "Birta" and "Host"; what goes in them here is the app and
    /// macOS, so a report from this surface names what a reader would need to
    /// reproduce it rather than a VS Code that was never running.
    public var jsonObject: [String: Any] {
        [
            "extensionVersion": appVersion,
            "hostVersion": systemVersion,
            "platform": platform,
            "changedSettings": changedSettings,
        ]
    }
}
