import XCTest
@testable import BirtaJotCore

final class ChuteDecisionTests: XCTestCase {
    private var dir: URL!
    private var scratchpad: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("jot-chute-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        scratchpad = dir.appendingPathComponent("Scratchpad.md")
        try AtomicFile.writeString("notes", to: scratchpad)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testTheScratchpadIsAChuteAndMayBeEmptied() throws {
        XCTAssertEqual(
            ChuteDecision.outcome(boundURL: scratchpad, scratchpadURL: scratchpad),
            .emptyBuffer)
    }

    func testTheScratchpadUnderAnotherNameIsStillTheScratchpad() throws {
        // A Preferences path through a symlinked directory, or a differently
        // cased path on a case-insensitive volume: a path comparison would call
        // this a bound document and stop clearing the scratchpad, so the chute
        // would quietly stop being one.
        let link = dir.appendingPathComponent("Linked.md")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: scratchpad)

        XCTAssertEqual(
            ChuteDecision.outcome(boundURL: link, scratchpadURL: scratchpad),
            .emptyBuffer)
    }

    func testABoundDocumentIsNeverEmptied() throws {
        let document = dir.appendingPathComponent("Report.md")
        try AtomicFile.writeString("report", to: document)

        XCTAssertEqual(
            ChuteDecision.outcome(boundURL: document, scratchpadURL: scratchpad),
            .keepBuffer)
    }

    func testABoundDocumentThatDoesNotExistYetIsStillNotTheScratchpad() throws {
        let document = dir.appendingPathComponent("Missing.md")

        XCTAssertEqual(
            ChuteDecision.outcome(boundURL: document, scratchpadURL: scratchpad),
            .keepBuffer)
    }
}
