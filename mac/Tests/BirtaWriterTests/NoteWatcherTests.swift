import XCTest
@testable import BirtaWriter

/// The watcher over the bound file, with a real presenter on a real file.
///
/// The ordering the app's own Move to Trash depends on: it trashes the file
/// this window is on and rebinds in the same turn (`Coordinator.moveToTrash`),
/// so a report about the file LEFT must not reach the window afterwards and
/// mark the new file missing. It does not today, because a presenter that has
/// been unregistered is not reported to; this holds that.
@MainActor
final class NoteWatcherTests: XCTestCase {
    private var folder: URL!
    private var trashed: [URL] = []

    override func setUpWithError() throws {
        try super.setUpWithError()
        folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("note-watcher-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        for url in trashed { try? FileManager.default.removeItem(at: url) }
        try? FileManager.default.removeItem(at: folder)
        try super.tearDownWithError()
    }

    private func note(_ name: String) throws -> URL {
        let url = folder.appendingPathComponent(name)
        try Data("x".utf8).write(to: url)
        return url
    }

    private func trash(_ url: URL) throws {
        var landed: NSURL?
        try FileManager.default.trashItem(at: url, resultingItemURL: &landed)
        if let landed { trashed.append(landed as URL) }
    }

    /// The control: watched, then trashed, the delete is reported. Without it
    /// the case below passes for a watcher that never reports anything.
    func testATrashedWatchedFileShouldBeReported() throws {
        let watcher = NoteWatcher()
        let file = try note("a.md")
        let reported = expectation(description: "the delete was reported")
        watcher.onDeleted = { _ in reported.fulfill() }
        watcher.watch(file)
        try trash(file)
        wait(for: [reported], timeout: 5)
        watcher.stop()
    }

    /// Trashed, then rebound in the same turn: the report about the old file
    /// must not reach the window, which is now on the new one.
    func testAReportAboutAFileAlreadyLeftShouldNotBeDelivered() throws {
        let watcher = NoteWatcher()
        let old = try note("old.md")
        let next = try note("next.md")
        var deletes = 0
        watcher.onDeleted = { _ in deletes += 1 }
        watcher.onMoved = { _ in deletes += 1 }
        watcher.watch(old)
        try trash(old)
        watcher.watch(next)
        // Long enough for the control's report to have arrived.
        let settled = expectation(description: "settled")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { settled.fulfill() }
        wait(for: [settled], timeout: 5)
        XCTAssertEqual(deletes, 0, "a report about the file left reached the window on the new one")
        XCTAssertTrue(FileManager.default.fileExists(atPath: next.path))
        watcher.stop()
    }
}
