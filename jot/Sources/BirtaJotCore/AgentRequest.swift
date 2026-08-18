import Foundation

/// How a `/ai` request becomes a shell command.
///
/// A port of `src/agentBridge/askAgent.ts`, kept deliberately literal. Both
/// surfaces hand the same shape of line to the same CLIs, so a user who has
/// tuned `birta.agent.command` for the extension can paste it into Jot's
/// Settings and get the same behaviour. Swift cannot import the TypeScript, so
/// the rules are restated here and `AgentRequestTests` carries the same cases
/// the TypeScript tests do; a change to either has to be made in both.
public enum AgentRequest {
    public static let promptPlaceholder = "{prompt}"

    /// The one line handed over: the request, whitespace collapsed so it stays
    /// a single shell argument, prefixed with where it applies. Every major
    /// agent reads `relative/path.md#L12` as a location.
    public static func compose(prompt: String, reference: String) -> String {
        let collapsed = prompt.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return "In \(reference): \(collapsed)"
    }

    /// Quote `text` as one POSIX shell argument. Single quotes, with the
    /// embedded-quote idiom, so nothing inside is expanded: the content is
    /// prose, and a `$` or a backtick in it is a character rather than a
    /// substitution.
    public static func shellQuote(_ text: String) -> String {
        "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// The template with every `{prompt}` replaced by the quoted line. A
    /// template without the placeholder gets the line appended, so `claude`
    /// alone works.
    public static func expand(template: String, quotedPrompt: String) -> String {
        let trimmed = template.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.contains(promptPlaceholder) else {
            return "\(trimmed) \(quotedPrompt)"
        }
        return trimmed.replacingOccurrences(of: promptPlaceholder, with: quotedPrompt)
    }

    /// The harness a command names, for the running marker's tooltip: the
    /// first word, with any directory part dropped. Nil when the template is
    /// blank, which is the one case where there is nothing to name.
    public static func harnessName(from template: String) -> String? {
        let first = template.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: \.isWhitespace).first
        guard let first, !first.isEmpty else { return nil }
        return String(first).components(separatedBy: "/").last
    }
}
