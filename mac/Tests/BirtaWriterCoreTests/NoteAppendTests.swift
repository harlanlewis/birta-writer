import XCTest
@testable import BirtaWriterCore

/// What an append adds to a file, over every shape a target's end can take.
///
/// The target's tail is enumerated rather than sampled: each line-ending style
/// against each count of trailing breaks, with and without trailing spaces on
/// the blank lines, and every case is held to the same invariants. Those are
/// what the feature promises, so they are asserted directly rather than as
/// expected strings: the target survives as an exact prefix, exactly one blank
/// line separates it from the heading (or more only where the target already
/// had them), the line endings are the target's, and the file ends in one
/// line break.
final class NoteAppendTests: XCTestCase {
    private let heading = "## 2026-11-01 10:42"

    // MARK: the enumeration

    private struct Target {
        let text: String
        let crlf: Bool
        /// Line breaks already at the end, which is what decides the lead.
        let breaks: Int
    }

    /// Every target end this suite holds the invariants over. Its size is
    /// asserted, so a change that empties it cannot pass by checking nothing.
    private var targets: [Target] {
        var out: [Target] = []
        for crlf in [false, true] {
            let nl = crlf ? "\r\n" : "\n"
            for breaks in 0...4 {
                for padding in ["", "  "] {
                    // The padding goes on each blank line, which is what a
                    // trailing "blank" line full of spaces looks like.
                    var text = "# Inbox\(nl)\(nl)- first"
                    for i in 0..<breaks { text += (i == 0 ? "" : padding) + nl }
                    out.append(Target(text: text, crlf: crlf, breaks: breaks))
                }
            }
        }
        return out
    }

    func testEveryTargetEndShouldKeepTheTargetAndSeparateTheHeadingByOneBlankLine() throws {
        let cases = targets
        XCTAssertEqual(cases.count, 20, "the enumeration reached fewer target ends than it was written for")
        var checked = 0
        for target in cases {
            let name = "\(target.crlf ? "CRLF" : "LF"), \(target.breaks) trailing \(target.text.debugDescription)"
            let out = try XCTUnwrap(NoteAppend.compose(target: target.text, note: "The note.\n", heading: heading), name)

            // Compared as bytes, not characters: a CR at the target's end and
            // an LF at the suffix's start would merge into one character.
            XCTAssertTrue(Array(out.utf8).starts(with: target.text.utf8), "the target's bytes moved: \(name)")
            let suffix = String(decoding: Array(out.utf8).dropFirst(target.text.utf8.count), as: UTF8.self)
            let lf = suffix.replacingOccurrences(of: "\r\n", with: "\n")
            XCTAssertFalse(lf.contains("\r"), "a bare CR was added: \(name)")
            if target.crlf {
                XCTAssertEqual(suffix.components(separatedBy: "\r\n").joined().contains("\n"), false,
                               "a CRLF target was given an LF: \(name)")
            } else {
                XCTAssertFalse(suffix.contains("\r"), "an LF target was given CRLF: \(name)")
            }

            // One blank line before the heading, counting what the target
            // already had: never fewer, and more only where the target had
            // more of its own.
            let total = target.breaks + lf.prefix { $0 == "\n" }.count
            XCTAssertEqual(total, max(2, target.breaks), "wrong separation before the heading: \(name)")
            XCTAssertEqual(lf.drop { $0 == "\n" }, "\(heading)\n\nThe note.\n", name)
            checked += 1
        }
        XCTAssertEqual(checked, cases.count)
    }

    // MARK: the target

    func testAnEmptyTargetShouldOpenWithTheHeading() {
        XCTAssertEqual(NoteAppend.compose(target: "", note: "Note", heading: heading),
                       "\(heading)\n\nNote\n")
    }

    /// A target with nothing in it but a byte-order mark or white space has
    /// nothing to be separated from either, so it opens with the heading as
    /// an empty one does. Its bytes stay, the mark included, and the heading
    /// starts the line after them.
    func testATargetWithNoTextShouldOpenWithTheHeadingAndKeepItsBytes() {
        let cases: [(target: String, expected: String)] = [
            ("\u{FEFF}", "\u{FEFF}\(heading)\n\nNote\n"),
            ("\n", "\n\(heading)\n\nNote\n"),
            ("\n\n\n", "\n\n\n\(heading)\n\nNote\n"),
            ("  \n \t\n", "  \n \t\n\(heading)\n\nNote\n"),
            ("   ", "   \n\(heading)\n\nNote\n"),
            ("\u{FEFF}\n", "\u{FEFF}\n\(heading)\n\nNote\n"),
            ("\r\n", "\r\n\(heading)\r\n\r\nNote\r\n"),
        ]
        for c in cases {
            XCTAssertEqual(NoteAppend.compose(target: c.target, note: "Note", heading: heading), c.expected,
                           c.target.debugDescription)
        }
    }

    func testAByteOrderMarkShouldStayWhereItWas() {
        let target = "\u{FEFF}Inbox\n"
        let out = NoteAppend.compose(target: target, note: "Note", heading: heading)
        XCTAssertEqual(out, "\u{FEFF}Inbox\n\n\(heading)\n\nNote\n")
    }

    /// Judged by the FIRST break, and a CRLF file with one stray LF in it is
    /// still a CRLF file.
    func testTheFirstLineBreakShouldDecideTheStyle() {
        XCTAssertTrue(NoteAppend.usesCRLF("a\r\nb\nc"))
        XCTAssertFalse(NoteAppend.usesCRLF("a\nb\r\nc"))
        XCTAssertFalse(NoteAppend.usesCRLF("no breaks at all"))
    }

    func testTrailingWhitespaceShouldCountOnlyItsLineBreaks() {
        XCTAssertEqual(NoteAppend.trailingLineBreaks(of: "text"), 0)
        XCTAssertEqual(NoteAppend.trailingLineBreaks(of: "text  "), 0)
        XCTAssertEqual(NoteAppend.trailingLineBreaks(of: "text\n"), 1)
        XCTAssertEqual(NoteAppend.trailingLineBreaks(of: "text\r\n \t\r\n"), 2)
        XCTAssertEqual(NoteAppend.trailingLineBreaks(of: "\n\n"), 2)
    }

    // MARK: the note

    func testANoteWithCRLFShouldTakeAnLFTargetsBreaks() {
        let out = NoteAppend.compose(target: "Inbox\n", note: "one\r\ntwo\r\n", heading: heading)
        XCTAssertEqual(out, "Inbox\n\n\(heading)\n\none\ntwo\n")
    }

    func testAnLFNoteShouldTakeACRLFTargetsBreaks() {
        let out = NoteAppend.compose(target: "Inbox\r\n", note: "one\n\ntwo", heading: heading)
        XCTAssertEqual(out, "Inbox\r\n\r\n\(heading)\r\n\r\none\r\n\r\ntwo\r\n")
    }

    func testFrontmatterShouldStayWithTheNoteItDescribes() {
        let note = "---\ntitle: Scratch\n---\n\nThe body.\n"
        XCTAssertEqual(NoteAppend.compose(target: "Inbox\n", note: note, heading: heading),
                       "Inbox\n\n\(heading)\n\nThe body.\n")
    }

    func testBlankLinesAroundTheBodyShouldGoAndItsIndentationShouldStay() {
        let note = "\n  \n    code block\n\nafter  \n\n\n"
        XCTAssertEqual(NoteAppend.body(of: note), "    code block\n\nafter")
    }

    func testANoteWithNothingButFrontmatterOrSpaceShouldAppendNothing() {
        XCTAssertNil(NoteAppend.suffix(after: "Inbox\n", note: "---\ntitle: x\n---\n", heading: heading))
        XCTAssertNil(NoteAppend.suffix(after: "Inbox\n", note: " \n\t\n", heading: heading))
        XCTAssertNil(NoteAppend.suffix(after: "Inbox\n", note: "", heading: heading))
    }

    // MARK: where it goes

    private let source = URL(fileURLWithPath: "/notes/Scratch.md")
    private let inbox = URL(fileURLWithPath: "/notes/Inbox.md")
    private func path(_ a: URL, _ b: URL) -> Bool { a.standardizedFileURL.path == b.standardizedFileURL.path }

    func testAFileNoWindowHoldsShouldBeWrittenDirectly() {
        let windows = [NoteAppend.Window(file: source, holdsBuffer: true)]
        XCTAssertEqual(NoteAppend.destination(target: inbox, source: source, windows: windows, sameFile: path), .file)
    }

    func testAFileOpenInATabShouldGoThroughThatTabNeverBehindIt() {
        let windows = [NoteAppend.Window(file: source, holdsBuffer: true),
                       NoteAppend.Window(file: URL(fileURLWithPath: "/notes/Other.md"), holdsBuffer: true),
                       NoteAppend.Window(file: inbox, holdsBuffer: true)]
        XCTAssertEqual(NoteAppend.destination(target: inbox, source: source, windows: windows, sameFile: path), .tab(2))
    }

    /// A tab whose page has not read its file yet will read it when it loads,
    /// so the file is the only copy and is where the append goes.
    func testATabHoldingNoCopyShouldLeaveTheFileAsTheOnlyCopy() {
        let windows = [NoteAppend.Window(file: inbox, holdsBuffer: false)]
        XCTAssertEqual(NoteAppend.destination(target: inbox, source: source, windows: windows, sameFile: path), .file)
    }

    func testTheNoteItselfShouldBeRefusedAsATarget() {
        let windows = [NoteAppend.Window(file: source, holdsBuffer: true)]
        XCTAssertEqual(NoteAppend.destination(target: source, source: source, windows: windows, sameFile: path), .thisNote)
    }

    /// The app's own identity check, over real files: a symlink to an open
    /// file is that file, and goes through its tab.
    func testASymlinkToAnOpenFileShouldReachItsTab() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("note-append-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let real = dir.appendingPathComponent("Inbox.md")
        let link = dir.appendingPathComponent("Link.md")
        try "Inbox\n".write(to: real, atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        let windows = [NoteAppend.Window(file: real, holdsBuffer: true)]
        XCTAssertEqual(NoteAppend.destination(target: link, source: source, windows: windows), .tab(0))
    }

    // MARK: the heading

    func testTheHeadingShouldReadTheLocalTimeInTheGregorianCalendar() {
        // 2026-11-01 10:42:30 UTC.
        let date = Date(timeIntervalSince1970: 1_793_529_750)
        XCTAssertEqual(NoteAppend.heading(for: date, timeZone: TimeZone(identifier: "UTC")!), "## 2026-11-01 10:42")
        XCTAssertEqual(NoteAppend.heading(for: date, timeZone: TimeZone(identifier: "America/Los_Angeles")!),
                       "## 2026-11-01 02:42")
    }
}
