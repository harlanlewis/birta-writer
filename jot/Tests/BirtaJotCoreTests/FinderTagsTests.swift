import XCTest
@testable import BirtaJotCore

/// Tags go through the filesystem, so these run against a real temporary file.
/// What they pin is the seam's own decisions: what an absent value means, and
/// what "no tags" writes.
final class FinderTagsTests: XCTestCase {
    private var dir: URL!
    private var file: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("jot-tags-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("Birta Writer Jot.md")
        try AtomicFile.writeString("note", to: file)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testAFreshFileHasNoTags() {
        XCTAssertEqual(FinderTags.read(file), [])
    }

    func testAMissingFileReadsAsNoTagsRatherThanThrowing() {
        // The field shows what the file has, and a file that is not there yet
        // has nothing; there is no third answer for a field to draw.
        XCTAssertEqual(FinderTags.read(dir.appendingPathComponent("gone.md")), [])
    }

    func testWrittenTagsComeBack() throws {
        try FinderTags.write(["Red", "Work"], to: file)

        XCTAssertEqual(Set(FinderTags.read(file)), ["Red", "Work"])
    }

    func testWritingReplacesRatherThanAdds() throws {
        // The popover's field holds the whole set, so a commit is the set.
        try FinderTags.write(["Red", "Work"], to: file)

        try FinderTags.write(["Work"], to: file)

        XCTAssertEqual(FinderTags.read(file), ["Work"])
    }

    func testBlankEntriesAreDropped() throws {
        // A token field hands back what was typed. An empty tag is one Finder
        // will not show and this field could not remove afterwards.
        try FinderTags.write(["Work", "   ", ""], to: file)

        XCTAssertEqual(FinderTags.read(file), ["Work"])
    }

    func testSurroundingWhitespaceIsTrimmed() throws {
        try FinderTags.write(["  Work  "], to: file)

        XCTAssertEqual(FinderTags.read(file), ["Work"])
    }

    func testClearingLeavesNoTags() throws {
        try FinderTags.write(["Work"], to: file)

        try FinderTags.write([], to: file)

        XCTAssertEqual(FinderTags.read(file), [])
    }
}
