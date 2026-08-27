import XCTest
@testable import BirtaWriterCore

final class WindowTitleTests: XCTestCase {
    // MARK: runs

    func testAnUneditedDocumentShouldBeOneRunAndNoSuffix() {
        let runs = WindowTitle.runs(name: "Scratchpad.md", edited: false)
        XCTAssertEqual(runs, [.init(text: "Scratchpad.md", secondary: false)])
    }

    func testAnEditedDocumentShouldAppendTheSuffixAsOneSecondaryRun() {
        let runs = WindowTitle.runs(name: "Scratchpad.md", edited: true)
        XCTAssertEqual(runs, [
            .init(text: "Scratchpad.md", secondary: false),
            .init(text: " — Edited", secondary: true),
        ])
    }

    /// The separator belongs to the quiet half. Splitting it off is how the
    /// dash ends up drawn in the loud ink, which is not what macOS does.
    func testTheSeparatorShouldTravelWithTheSuffixRatherThanTheName() {
        let runs = WindowTitle.runs(name: "Note.md", edited: true)
        XCTAssertFalse(runs[0].text.contains(WindowTitle.separator))
        XCTAssertTrue(runs[1].text.hasPrefix(WindowTitle.separator))
        XCTAssertTrue(runs[1].secondary)
    }

    /// The edited flag has to be the only thing that changes the title, or a
    /// title that says Edited is not evidence that anything is unwritten.
    func testTheOnlyDifferenceBetweenTheTwoStatesShouldBeTheSuffix() {
        let clean = WindowTitle.runs(name: "Note.md", edited: false)
        let dirty = WindowTitle.runs(name: "Note.md", edited: true)
        XCTAssertEqual(Array(dirty.prefix(clean.count)), clean)
        XCTAssertEqual(dirty.count, clean.count + 1)
    }

    // MARK: ancestry

    // MARK: truncation
    //
    // One point per character, so a ceiling is a character count and the
    // arithmetic in a case is readable. A real font kerns and this does not,
    // which is exactly why `runs(fitting:measure:)` asks the measurer about
    // whole candidate strings rather than adding up glyph widths.
    private let perCharacter: (String) -> Double = { Double($0.count) }

    func testANameThatFitsShouldBeLeftExactlyAlone() {
        let runs = WindowTitle.runs(name: "Note.md", edited: false,
                                    fitting: 100, measure: perCharacter)
        XCTAssertEqual(runs, [WindowTitle.Run(text: "Note.md", secondary: false)])
    }

    func testANameThatDoesNotFitShouldEndInAnEllipsis() {
        let runs = WindowTitle.runs(name: "Note 2026-08-20 2.md", edited: false,
                                    fitting: 10, measure: perCharacter)
        let line = runs.map(\.text).joined()
        XCTAssertTrue(line.hasSuffix(WindowTitle.ellipsis), line)
        XCTAssertEqual(line.count, 10)
    }

    /// The defect this whole path exists for: a clipped name is the same
    /// LENGTH as a truncated one at the same ceiling, so a check on width
    /// cannot tell them apart. The ellipsis is the only thing that can.
    func testAClippedNameAndATruncatedOneDifferOnlyInTheEllipsis() {
        let name = "Birta Writer.md"
        let runs = WindowTitle.runs(name: name, edited: false,
                                    fitting: 8, measure: perCharacter)
        XCTAssertEqual(runs.map(\.text).joined(), "Birta W" + WindowTitle.ellipsis)
        XCTAssertNotEqual(runs.map(\.text).joined(), String(name.prefix(8)))
    }

    /// A name with a space in it is the case that used to WRAP rather than
    /// truncate, and one without is the case that could never have caught it.
    func testANameWithNoSpaceShouldTruncateTheSameWayAsOneWithSpaces() {
        let spaced = WindowTitle.runs(name: "aaa bbb ccc.md", edited: false,
                                      fitting: 6, measure: perCharacter)
        let solid = WindowTitle.runs(name: "aaabbbccc.md", edited: false,
                                     fitting: 6, measure: perCharacter)
        XCTAssertEqual(spaced.map(\.text).joined().count, 6)
        XCTAssertEqual(solid.map(\.text).joined().count, 6)
        XCTAssertTrue(spaced[0].text.hasSuffix(WindowTitle.ellipsis))
        XCTAssertTrue(solid[0].text.hasSuffix(WindowTitle.ellipsis))
    }

    /// The reason the truncation is here and not in the cell. A whole-line
    /// tail truncation eats `Edited` first, and `Edited` is the half being
    /// scanned for.
    func testTheNameShouldGiveWayAndTheEditedSuffixShouldSurvive() {
        let runs = WindowTitle.runs(name: "a very long note indeed.md", edited: true,
                                    fitting: 20, measure: perCharacter)
        XCTAssertEqual(runs.count, 2)
        XCTAssertTrue(runs[0].text.hasSuffix(WindowTitle.ellipsis))
        XCTAssertEqual(runs[1].text, WindowTitle.separator + WindowTitle.editedSuffix)
        XCTAssertTrue(runs[1].secondary)
        XCTAssertEqual(runs.map(\.text).joined().count, 20)
    }

    func testACeilingTooSmallForAnythingShouldStillNotDropTheSuffix() {
        let runs = WindowTitle.runs(name: "anything.md", edited: true,
                                    fitting: 1, measure: perCharacter)
        XCTAssertEqual(runs[0].text, WindowTitle.ellipsis)
        XCTAssertEqual(runs[1].text, WindowTitle.separator + WindowTitle.editedSuffix)
    }

    func testTheLongestNameThatFitsShouldBeChosenAndNotAShorterOne() {
        // Ceiling 11, ellipsis costs 1, so ten characters of name fit exactly
        // and eleven do not. Bisection off by one lands on nine.
        let runs = WindowTitle.runs(name: "abcdefghijklmnop", edited: false,
                                    fitting: 11, measure: perCharacter)
        XCTAssertEqual(runs[0].text, "abcdefghij" + WindowTitle.ellipsis)
    }

    func testAFileShouldListItselfFirstThenEveryFolderUpToTheRoot() {
        let chain = WindowTitle.ancestry(of: URL(fileURLWithPath: "/Users/x/Notes/Scratchpad.md"))
        XCTAssertEqual(chain.map(\.path), [
            "/Users/x/Notes/Scratchpad.md",
            "/Users/x/Notes",
            "/Users/x",
            "/Users",
            "/",
        ])
    }

    func testTheRootItselfShouldBeASingleEntryRatherThanAnEndlessWalk() {
        XCTAssertEqual(WindowTitle.ancestry(of: URL(fileURLWithPath: "/")).map(\.path), ["/"])
    }

    /// `deletingLastPathComponent` leaves `..` behind on an unstandardized
    /// path, which walks upward forever. Standardizing each step is what stops
    /// it, and this is the case that proves the standardize is load-bearing.
    func testARelativelySpelledPathShouldBeStandardizedBeforeWalking() {
        let chain = WindowTitle.ancestry(of: URL(fileURLWithPath: "/Users/x/Notes/../Scratchpad.md"))
        XCTAssertEqual(chain.first?.path, "/Users/x/Scratchpad.md")
        XCTAssertEqual(chain.last?.path, "/")
        // Every step really is the previous one's parent, which is the whole
        // claim the popup makes about the list it draws.
        for (child, parent) in zip(chain, chain.dropFirst()) {
            XCTAssertEqual(child.deletingLastPathComponent().standardizedFileURL.path, parent.path)
        }
    }

    func testATrailingSlashShouldNotProduceARepeatedEntry() {
        let chain = WindowTitle.ancestry(of: URL(fileURLWithPath: "/Users/x/Notes/", isDirectory: true))
        XCTAssertEqual(chain.map(\.path), ["/Users/x/Notes", "/Users/x", "/Users", "/"])
    }

    // MARK: displayName

    func testAnOrdinaryFileShouldShowItsOwnName() throws {
        let dir = try makeTemporaryDirectory()
        let file = dir.appendingPathComponent("Scratchpad.md")
        try Data().write(to: file)
        XCTAssertEqual(WindowTitle.displayName(of: file), "Scratchpad.md")
    }

    /// The fallback exists for a path the file manager will not name. Driven
    /// through a manager that answers with nothing, because a real path that
    /// behaves this way is not one a test can rely on finding.
    func testAPathTheFileManagerWillNotNameShouldFallBackToItsLastComponent() {
        let silent = SilentFileManager()
        XCTAssertEqual(
            WindowTitle.displayName(of: URL(fileURLWithPath: "/nowhere/Scratchpad.md"), using: silent),
            "Scratchpad.md")
        XCTAssertTrue(silent.asked, "the fallback must be reached THROUGH the manager, not instead of it")
    }

    // MARK: whether the suffix is drawn at all

    func testTheSuffixIsForUnwrittenBytesWithAutosaveOff() {
        // The only case. There the word is a fact with an action behind it,
        // and the action is Cmd+S.
        XCTAssertTrue(WindowTitle.showsEdited(hasUnwrittenBytes: true, autosaveEnabled: false))
    }

    func testAutosaveOnNeverDrawsTheSuffix() {
        // Not "draws it less often". The flag still rises on a keystroke and
        // falls on the write, several times a sentence, and a word that
        // appears and vanishes on that schedule names nothing anybody can do.
        XCTAssertFalse(WindowTitle.showsEdited(hasUnwrittenBytes: true, autosaveEnabled: true))
    }

    func testACleanBufferNeverDrawsTheSuffix() {
        XCTAssertFalse(WindowTitle.showsEdited(hasUnwrittenBytes: false, autosaveEnabled: false))
        XCTAssertFalse(WindowTitle.showsEdited(hasUnwrittenBytes: false, autosaveEnabled: true))
    }

    func testTheSuffixIsDecidedByBothInputsAndNotOne() {
        // A predicate that ignored an input would agree with itself across the
        // whole table. Both must be able to change the answer on their own.
        let all = [true, false].flatMap { bytes in
            [true, false].map { auto in
                WindowTitle.showsEdited(hasUnwrittenBytes: bytes, autosaveEnabled: auto)
            }
        }
        XCTAssertEqual(all.filter { $0 }.count, 1, "exactly one of the four cases shows it")
    }

    private func makeTemporaryDirectory() throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("WindowTitleTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }
}

/// A file manager that names nothing, so the fallback is the only way out.
private final class SilentFileManager: FileManager {
    var asked = false
    override func displayName(atPath path: String) -> String {
        asked = true
        return ""
    }
}
