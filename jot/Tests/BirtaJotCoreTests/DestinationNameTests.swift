import XCTest
@testable import BirtaJotCore

final class DestinationNameTests: XCTestCase {
    private let dir = URL(fileURLWithPath: "/notes", isDirectory: true)

    /// `exists` over a set of names in `dir`, so a test states its collisions
    /// as the names a user would see rather than as paths.
    private func taken(_ names: String...) -> (URL) -> Bool {
        let set = Set(names)
        return { set.contains($0.lastPathComponent) }
    }

    func testAFreeNameIsUsedAsItIs() {
        let url = DestinationName.unique("Meeting.md", in: dir, exists: taken())

        XCTAssertEqual(url.lastPathComponent, "Meeting.md")
        XCTAssertEqual(url.deletingLastPathComponent().path, dir.path)
    }

    func testATakenNameGetsTheNextNumber() {
        let url = DestinationName.unique("Meeting.md", in: dir, exists: taken("Meeting.md"))

        XCTAssertEqual(url.lastPathComponent, "Meeting 2.md")
    }

    func testARunOfTakenNamesSkipsPastAllOfThem() {
        let url = DestinationName.unique(
            "Meeting.md", in: dir,
            exists: taken("Meeting.md", "Meeting 2.md", "Meeting 3.md"))

        XCTAssertEqual(url.lastPathComponent, "Meeting 4.md")
    }

    func testTheExtensionSurvivesTheSuffix() {
        // The suffix goes on the stem, never after the extension: a
        // "Meeting.md 2" would not open as Markdown anywhere.
        let url = DestinationName.unique("Notes.todo.md", in: dir, exists: taken("Notes.todo.md"))

        XCTAssertEqual(url.lastPathComponent, "Notes.todo 2.md")
    }

    func testANameWithNoExtensionKeepsNone() {
        let url = DestinationName.unique("Meeting", in: dir, exists: taken("Meeting"))

        XCTAssertEqual(url.lastPathComponent, "Meeting 2")
    }

    func testAnEmptyNameFallsBackToTheProductName() {
        // Nothing produces this today; the point is that a note with no name
        // still lands in a file rather than in the directory itself.
        let url = DestinationName.unique("", in: dir, exists: taken())

        XCTAssertEqual(url.lastPathComponent, "Jot")
    }

    func testAnExhaustedRunStillReturnsAFreeName() {
        // Every readable candidate taken: the note must still land somewhere,
        // and the one thing it may not do is overwrite one of them.
        let everyReadableName: (URL) -> Bool = { url in
            let name = url.lastPathComponent
            guard name.hasPrefix("Meeting") else { return false }
            return !name.contains("-") // the UUID fallback is the only free one
        }

        let url = DestinationName.unique("Meeting.md", in: dir, exists: everyReadableName)

        XCTAssertFalse(everyReadableName(url))
        XCTAssertTrue(url.lastPathComponent.hasPrefix("Meeting "))
        XCTAssertEqual(url.pathExtension, "md")
    }
}
