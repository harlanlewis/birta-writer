import AppKit
import BirtaWriterCore
import XCTest
@testable import BirtaWriter

/// Shift+Cmd+N: a window with no file in it, in the empty state Move to Trash
/// leaves (No File Open, with Browse and Open Recent).
///
/// The state itself is driven live, on a window with no page, because what
/// matters about it is what the window says of itself: vacant, so a file
/// opened from it takes it over; empty, so a folder opened from it replaces
/// it; and nothing written to the free name it is bound to. The ordering
/// inside `start`, which mounts a page, is held as source text, the shape
/// `NewFolderTabTests` uses for the same reason.
@MainActor
final class NewWindowTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        _ = NSApplication.shared
        folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("NewWindowTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
        try super.tearDownWithError()
    }

    // MARK: live

    /// The empty window is vacant and empty, offers nothing to trash, and
    /// leaves no file behind. The same window not asked to be empty, on the
    /// same absent path, is none of those: that is an ordinary first note.
    func testAnEmptyWindowShouldBeVacantAndWriteNothing() {
        let name = folder.appendingPathComponent("Untitled.md")
        let ordinary = Coordinator(boundTo: name, slot: nil, remembersFrame: false, frame: nil, explorerRoot: nil)
        defer { ordinary.tearDown() }
        XCTAssertFalse(ordinary.isEmptyState)
        XCTAssertFalse(ordinary.isVacant, "an absent path alone is not a vacant window")

        let empty = Coordinator(boundTo: name, slot: nil, remembersFrame: false, frame: nil, explorerRoot: nil)
        defer { empty.tearDown() }
        empty.enterEmptyState()
        XCTAssertTrue(empty.isEmptyState)
        XCTAssertTrue(empty.isVacant, "a file opened from the empty window must take it over")
        XCTAssertFalse(empty.hasUnwrittenBytes)
        XCTAssertFalse(empty.canMoveBoundFileToTrash)
        XCTAssertFalse(FileManager.default.fileExists(atPath: name.path), "the empty window must make no file")
    }

    // MARK: the wiring, as text

    private func source(_ file: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Sources/\(file)")
        return try XCTUnwrap(try? String(contentsOf: url, encoding: .utf8),
                             "could not read \(url.path); if it moved, this guard must follow it")
    }

    private func body(of signature: String, in text: String) throws -> String {
        let lines = text.components(separatedBy: "\n")
        let start = try XCTUnwrap(lines.firstIndex { $0.contains(signature) },
                                  "\(signature) is gone or renamed, and this guard names it")
        var depth = 0
        var body: [String] = []
        for index in start..<lines.count {
            let line = lines[index]
            body.append(line)
            depth += line.filter { $0 == "{" }.count - line.filter { $0 == "}" }.count
            if depth <= 0, index > start { break }
        }
        return body.joined(separator: "\n")
    }

    /// `startWatching` clears the missing flag the empty state stands on, so
    /// the state is entered after it, never before.
    func testStartShouldEnterTheEmptyStateAfterWatching() throws {
        let start = try body(of: "    func start() {", in: try source("BirtaWriter/Coordinator.swift"))
        let watching = try XCTUnwrap(start.range(of: "startWatching()"))
        let entered = try XCTUnwrap(start.range(of: "enterEmptyState()"), "start no longer enters the empty state")
        XCTAssertLessThan(watching.lowerBound, entered.lowerBound)
    }

    /// New Window makes no file and takes no slot; it asks for the empty
    /// state before the window is started.
    func testNewWindowShouldMakeNoFileAndAskForTheEmptyStateBeforeOpening() throws {
        let made = try body(of: "func newEmptyWindow()", in: try source("BirtaWriter/WindowSet.swift"))
        XCTAssertFalse(made.contains("makeNoteFile"), "New Window must not make a note on disk")
        XCTAssertTrue(made.contains("slot: nil"), "New Window must take no slot")
        let ask = try XCTUnwrap(made.range(of: "openEmpty()"))
        let open = try XCTUnwrap(made.range(of: "open(made"))
        XCTAssertLessThan(ask.lowerBound, open.lowerBound)
    }

    /// A folder opened from an empty window replaces it, and only an empty
    /// one: the check is made again when the folder's window is up.
    func testAFolderOpenedFromAnEmptyWindowShouldRetireIt() throws {
        let open = try body(of: "func openDirectory(at folder: URL", in: try source("BirtaWriter/WindowSet.swift"))
        XCTAssertTrue(open.contains("$0.isEmptyState ? $0 : nil"))
        XCTAssertTrue(open.contains("emptied.isEmptyState else { return }"))
        XCTAssertTrue(open.contains("self.retire([emptied])"))
    }
}
