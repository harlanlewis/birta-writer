import Foundation

/// Names for a folder's subjects, with no model involved: what the model is
/// asked, and what of its answer is kept. The asking is the app's
/// (`OnDeviceSubjectNamer`), because it needs a framework this package's
/// core cannot link and a machine the tests do not have.
///
/// The page groups the notes (webview/components/graph/folderSignals.ts) and
/// names each group from what its notes share; a name from here is laid over
/// that one when it comes, and the page keeps its own when it does not. So
/// every rule below refuses rather than repairs: an answer that is not a
/// short name is no name, and the page's stands.
///
/// What the model sees is a subject's note NAMES and its commonest tags,
/// never a note's text, and it runs on this Mac: nothing here leaves it.
public enum SubjectNames {
    /// One subject to name, as the page sends it (`requestSubjectNames`).
    public struct Request: Equatable, Sendable {
        public let id: String
        public let notes: [String]
        public let tags: [String]

        public init(id: String, notes: [String], tags: [String]) {
            self.id = id
            self.notes = notes
            self.tags = tags
        }
    }

    /// The longest name kept, in characters: the row it titles is one line.
    public static let maxLength = 40

    /// The most words a name may have.
    public static let maxWords = 5

    /// What the session is told once, before any subject.
    public static let instructions = """
        You name groups of related notes from one person's notes. \
        Reply with a short topic name, one to four words, in title case. \
        Name what ALL the notes have in common, not the subject of the first one, \
        and not that they are notes. \
        Reply with the name only: no quotes, no punctuation at the end, no explanation.
        """

    /// What one subject is asked as.
    public static func prompt(for request: Request) -> String {
        var lines = ["Notes in the group:"]
        lines += request.notes.map { "- \($0)" }
        if !request.tags.isEmpty {
            lines.append("Tags they carry: " + request.tags.joined(separator: ", "))
        }
        lines.append("Topic name:")
        return lines.joined(separator: "\n")
    }

    /// The name in `answer`, or nil when it is not one.
    ///
    /// Takes the first non-empty line, drops a label the model put in front
    /// (`Topic name:`), surrounding quotes and markup, and trailing
    /// punctuation; then refuses anything empty, longer than `maxLength`, or
    /// of more than `maxWords` words, which is an explanation rather than a
    /// name.
    public static func clean(_ answer: String) -> String? {
        guard var line = answer.split(whereSeparator: \.isNewline)
            .map({ $0.trimmingCharacters(in: .whitespaces) })
            .first(where: { !$0.isEmpty }) else { return nil }
        if let colon = line.firstIndex(of: ":"), line[..<colon].lowercased().contains("name") {
            line = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let strip = CharacterSet(charactersIn: "\"'“”‘’`*_#").union(.whitespaces)
        line = line.trimmingCharacters(in: strip)
        while let last = line.last, ".,;:!".contains(last) { line.removeLast() }
        line = line.trimmingCharacters(in: strip)
        guard !line.isEmpty, line.count <= maxLength,
              line.split(whereSeparator: \.isWhitespace).count <= maxWords else { return nil }
        return line
    }
}
