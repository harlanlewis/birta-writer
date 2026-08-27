import Foundation

/// What goes on the clipboard when you copy the current place for an agent.
///
/// A port of the projections in `src/agentBridge/format.ts` and the span rules
/// in `shared/agentContext.ts`, kept deliberately literal, for the same reason
/// and by the same rule as `AgentRequest`: Swift cannot import the TypeScript,
/// both surfaces must hand the same shape to the same tools, and
/// `AgentReferenceTests` carries the same cases the TypeScript tests do. A
/// change to either has to be made in both.
///
/// Two things are deliberately NOT the same, and there are no others.
///
/// The PATH. The extension writes a workspace-relative one, which is what a
/// tool already working in that project resolves. The Mac app has no project:
/// its file lives under Application Support, nowhere near any agent's working
/// directory, so a relative path would name nothing. It writes the absolute
/// path, and the caller is what decides — this type takes whatever it is
/// handed.
///
/// And the FALLBACK when the span cannot be read. The extension quotes the
/// selection's stripped plain text, which it has because the page sends it;
/// this quotes nothing and returns the reference alone. Not an oversight: the
/// source here is the buffer the page is currently showing, so a span it just
/// reported and this cannot read is a disagreement with itself rather than the
/// document-on-disk-has-moved case the extension is guarding. Quoting a
/// stripped copy to paper over that would hide it.
public enum AgentReference {
    /// A 1-indexed line and 0-indexed column, as `shared/agentContext.ts`
    /// carries them across the bridge.
    public struct Position: Equatable, Sendable {
        public let line: Int
        public let column: Int

        public init(line: Int, column: Int) {
            self.line = line
            self.column = column
        }
    }

    /// The primary selection, as the page reports it.
    public struct Selection: Equatable, Sendable {
        public let anchor: Position
        public let active: Position
        /// Whether it is a bare caret. Carried rather than derived: the page
        /// decides, and a zero-length span is not the same claim.
        public let isEmpty: Bool

        public init(anchor: Position, active: Position, isEmpty: Bool) {
            self.anchor = anchor
            self.active = active
            self.isEmpty = isEmpty
        }
    }

    /// `start` before `end`, whichever way round the selection was made.
    static func ordered(_ selection: Selection) -> (start: Position, end: Position) {
        let a = selection.anchor, b = selection.active
        if a.line != b.line { return a.line < b.line ? (a, b) : (b, a) }
        return a.column <= b.column ? (a, b) : (b, a)
    }

    /// The 1-indexed line span a selection covers, start ≤ end.
    ///
    /// A selection ending at column 0 of a later line selects nothing of that
    /// line, so the span, and the `#L` reference built from it, ends on the
    /// previous one. That is the editor and GitHub convention, and getting it
    /// wrong sends an agent one line further than the writer pointed.
    public static func lineSpan(_ selection: Selection) -> (startLine: Int, endLine: Int) {
        let (start, end) = ordered(selection)
        let endLine = end.line > start.line && end.column == 0 ? end.line - 1 : end.line
        return (start.line, endLine)
    }

    /// `#L12` for one line, `#L12-L20` for a range. The form every major
    /// coding agent accepts in an @-mention or a file reference.
    public static func lineSuffix(startLine: Int, endLine: Int) -> String {
        startLine == endLine ? "#L\(startLine)" : "#L\(startLine)-L\(endLine)"
    }

    /// The pointer: a path and the lines it means.
    public static func reference(path: String, selection: Selection) -> String {
        let span = lineSpan(selection)
        return path + lineSuffix(startLine: span.startLine, endLine: span.endLine)
    }

    /// Fence `content` as a markdown block, with the fence long enough that no
    /// backtick run inside it can close the block early. A note that quotes
    /// code is the ordinary case here, not the exotic one.
    public static func fence(_ content: String) -> String {
        var longestRun = 0
        var run = 0
        for character in content {
            run = character == "`" ? run + 1 : 0
            longestRun = max(longestRun, run)
        }
        let ticks = String(repeating: "`", count: max(3, longestRun + 1))
        return "\(ticks)markdown\n\(content)\n\(ticks)"
    }

    /// The selection's exact SOURCE fragment, structure intact.
    ///
    /// Mid-line endpoints trim the first and last lines: someone selecting
    /// three words is pointing AT those words, and that signal has to survive
    /// the copy. A column of 0 trims nothing, because it means either "the
    /// whole line" or "could not be mapped", and over-sharing a line beats
    /// clipping real content. Nil when the span cannot be read at all, which
    /// is stale coordinates against a shorter document.
    static func sourceSpan(_ selection: Selection, source: String) -> String? {
        let (start, end) = ordered(selection)
        let span = lineSpan(selection)
        // `components` rather than `split`, which drops the empty strings that
        // blank lines are, and a blank line inside a selection is content.
        let all = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        guard span.startLine >= 1, span.startLine <= all.count else { return nil }
        var lines = Array(all[(span.startLine - 1)..<min(span.endLine, all.count)])
        guard !lines.isEmpty else { return nil }
        let last = lines.count - 1
        // End first, then start: both columns index the ORIGINAL lines, and
        // the end trim only removes a tail the start trim never reaches.
        if end.line == span.startLine + last, end.column > 0 {
            lines[last] = String(lines[last].prefix(end.column))
        }
        if start.column > 0 {
            lines[0] = String(lines[0].dropFirst(min(start.column, lines[0].count)))
        }
        let joined = lines.joined(separator: "\n")
        return joined.isEmpty ? nil : joined
    }

    /// What the button copies: the reference alone for a bare caret, or the
    /// reference and then the selected lines QUOTED as a fenced block.
    ///
    /// Both halves earn their place, and which tool you paste into decides
    /// which one you needed. An agent running where the file is opens it from
    /// the reference and ignores the rest; one that cannot reach the file at
    /// all, a chat box in a browser, has only the lines. Sending both means
    /// not having to know which you are about to use.
    public static func clipboardPayload(path: String, selection: Selection, source: String) -> String {
        let reference = reference(path: path, selection: selection)
        guard !selection.isEmpty else { return reference }
        guard let content = sourceSpan(selection, source: source) else { return reference }
        // NOT truncated, which the model-facing `describeForModel` on the
        // other side is and this is not: the clipboard commands there do not
        // truncate either, and a person who selected a long passage and asked
        // for it meant it. The app's own Copy Everything has no ceiling for the
        // same reason.
        return "\(reference)\n\n\(fence(content))"
    }
}
