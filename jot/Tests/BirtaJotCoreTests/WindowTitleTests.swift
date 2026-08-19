import XCTest
@testable import BirtaJotCore

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
