import Foundation

/// What File > Append to Note… adds to the end of another file: the note's
/// body under a timestamped heading, so an inbox or a daily note that is
/// appended to again and again reads as a log.
///
///     ...what the file already held
///
///     ## 2026-11-01 10:42
///
///     The appended note.
///
/// The answer is a SUFFIX, never a rewritten file, and that is the contract
/// the shape exists for: whatever the target held is left byte for byte,
/// trailing blank lines, a missing final newline and a byte-order mark
/// included, because the caller appends these bytes to the bytes it read (or
/// to the buffer of the tab holding the file) and has nothing of the
/// target's to re-encode. Tidying the target's end would be an edit to a file
/// the reader only asked to add to.
///
/// What it does decide, from the target's tail and nothing else:
///
/// - **One blank line before the heading.** A target ending in no line break
///   gets two, one ending in one gets one, and one already ending in a blank
///   line gets none, since adding to it would widen a gap the reader left. A
///   line of spaces counts as blank, which is how Markdown reads it.
/// - **The target's line endings.** A CRLF file stays CRLF; the note's own
///   breaks, whatever they were, are rewritten to match. A target with no
///   line break at all says nothing, and gets LF.
/// - **A final line break**, always, so the next append starts from a file
///   that ends the way a text file should.
///
/// The note contributes its BODY: a frontmatter block describes the note it
/// opens, and pasted into the middle of another file it is no longer
/// frontmatter, just a rule and some keys. Blank lines around the body are
/// dropped so the spacing is this type's, but the first line's indentation
/// is kept, because four leading spaces are an indented code block.
public enum NoteAppend {
    /// The heading an append made at `date` goes under, in the reader's own
    /// time zone: `## 2026-11-01 10:42`.
    ///
    /// The calendar and locale are pinned, because `dateFormat` is otherwise
    /// read against the USER's calendar, and under a Japanese or Buddhist one
    /// `yyyy` is the era year.
    public static func heading(for date: Date, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = timeZone
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return "## \(f.string(from: date))"
    }

    /// The part of `note` an append carries, or nil when there is none: the
    /// body under any frontmatter, without the blank lines around it, with
    /// LF line breaks.
    public static func body(of note: String) -> String? {
        let lf = normalizedToLF(Frontmatter.split(note).body)
        var lines = lf.components(separatedBy: "\n")
        while let first = lines.first, isBlank(first) { lines.removeFirst() }
        while let last = lines.last, isBlank(last) { lines.removeLast() }
        guard !lines.isEmpty else { return nil }
        // Trailing spaces on the last line would be the only whitespace left
        // at the end, and a final line break follows them; dropping them keeps
        // the file's end the same shape whatever the note's was.
        lines[lines.count - 1] = String(lines[lines.count - 1].reversed().drop { $0 == " " || $0 == "\t" }.reversed())
        return lines.joined(separator: "\n")
    }

    /// The bytes to add after `target` to append `note` under `heading`, or
    /// nil when the note has no body to append.
    public static func suffix(after target: String, note: String, heading: String) -> String? {
        guard let body = body(of: note) else { return nil }
        let breaks = trailingLineBreaks(of: target)
        let lead: String
        if target.isEmpty {
            // Nothing to be separated from: the heading opens the file.
            lead = ""
        } else {
            lead = String(repeating: "\n", count: max(0, 2 - breaks))
        }
        let lf = lead + heading + "\n\n" + body + "\n"
        return usesCRLF(target) ? lf.replacingOccurrences(of: "\n", with: "\r\n") : lf
    }

    /// `target` with the note appended: `target` itself, then `suffix`.
    public static func compose(target: String, note: String, heading: String) -> String? {
        suffix(after: target, note: note, heading: heading).map { target + $0 }
    }

    // MARK: where it goes

    /// Where an append to `target` has to land.
    public enum Destination: Equatable, Sendable {
        /// The target is the note being appended. Refused: a note under a
        /// heading inside itself is nothing anybody asks for on purpose.
        case thisNote
        /// The target is open in the window at this index, which holds its own
        /// copy of it. The append goes into that copy and nowhere else: a
        /// write to the file underneath it is two buffers over one path, and
        /// whichever is written second loses the other's bytes.
        case tab(Int)
        /// Nothing holds a copy of the target, so the file is the only one.
        case file
    }

    /// One open window, as the routing reads it.
    public struct Window: Equatable, Sendable {
        public let file: URL
        /// Whether the window holds the copy of its file that matters: false
        /// for one whose page will read the file when it loads, or whose note
        /// is missing or unreadable.
        public let holdsBuffer: Bool
        public init(file: URL, holdsBuffer: Bool) {
            self.file = file
            self.holdsBuffer = holdsBuffer
        }
    }

    /// Where an append from the note bound to `source` to `target` lands,
    /// over the windows as they stand. `sameFile` is injected so a test can
    /// name files that do not exist; the app takes `FileIdentity.sameFile`,
    /// which sees through a symlink or a second path to one file.
    ///
    /// A window over the target that holds no copy of it does not take the
    /// append: it reads the file when its page loads, so the file written now
    /// is what it will show.
    public static func destination(target: URL, source: URL, windows: [Window],
                                   sameFile: (URL, URL) -> Bool = FileIdentity.sameFile) -> Destination {
        if sameFile(target, source) { return .thisNote }
        if let index = windows.firstIndex(where: { $0.holdsBuffer && sameFile($0.file, target) }) {
            return .tab(index)
        }
        return .file
    }

    // MARK: reading the target's tail

    /// Whether the target's line breaks are CRLF, judged by its first one.
    ///
    /// Walked over unicode scalars because Swift makes `\r\n` ONE character,
    /// so a character-wise search for `\n` never finds it in a CRLF file.
    static func usesCRLF(_ text: String) -> Bool {
        var previous: Unicode.Scalar?
        for scalar in text.unicodeScalars {
            if scalar == "\n" { return previous == "\r" }
            previous = scalar
        }
        return false
    }

    /// How many line breaks the whitespace at the end of `text` holds. Two or
    /// more means the text already ends in a blank line.
    static func trailingLineBreaks(of text: String) -> Int {
        var count = 0
        for scalar in text.unicodeScalars.reversed() {
            switch scalar {
            case "\n": count += 1
            case "\r", " ", "\t": continue
            default: return count
            }
        }
        return count
    }

    private static func normalizedToLF(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    }

    private static func isBlank(_ line: String) -> Bool {
        line.allSatisfy { $0 == " " || $0 == "\t" }
    }
}
