import XCTest
@testable import BirtaJotCore

final class SaveAsDecisionTests: XCTestCase {
    private var dir: URL!
    private var scratchpad: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("jot-saveas-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        scratchpad = dir.appendingPathComponent("Scratchpad.md")
        try AtomicFile.writeString("notes", to: scratchpad)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testScratchpadSavedElsewhereGraduates() throws {
        let target = dir.appendingPathComponent("Meeting.md")

        XCTAssertEqual(
            SaveAsDecision.outcome(boundURL: scratchpad, scratchpadURL: scratchpad, target: target),
            .graduate)
    }

    func testScratchpadSavedOntoItselfKeepsTheBuffer() throws {
        // Graduating here clears the buffer, and the clear is written straight
        // back to the same file: the user would be left with an empty file
        // where they had just saved their notes.
        XCTAssertEqual(
            SaveAsDecision.outcome(boundURL: scratchpad, scratchpadURL: scratchpad, target: scratchpad),
            .keepBuffer)
    }

    func testScratchpadSavedOntoItselfByAnotherNameAlsoKeepsTheBuffer() throws {
        let link = dir.appendingPathComponent("Linked.md")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: scratchpad)

        // Same file, different path. A path comparison would call this a
        // graduation and empty the scratchpad.
        XCTAssertEqual(
            SaveAsDecision.outcome(boundURL: scratchpad, scratchpadURL: scratchpad, target: link),
            .keepBuffer)
    }

    func testABoundDocumentIsNeverCleared() throws {
        let document = dir.appendingPathComponent("Report.md")
        try AtomicFile.writeString("report", to: document)
        let target = dir.appendingPathComponent("Copy.md")

        XCTAssertEqual(
            SaveAsDecision.outcome(boundURL: document, scratchpadURL: scratchpad, target: target),
            .keepBuffer)
    }

    func testABoundDocumentSavedOntoItselfIsAlsoKept() throws {
        let document = dir.appendingPathComponent("Report.md")
        try AtomicFile.writeString("report", to: document)

        XCTAssertEqual(
            SaveAsDecision.outcome(boundURL: document, scratchpadURL: scratchpad, target: document),
            .keepBuffer)
    }
}
