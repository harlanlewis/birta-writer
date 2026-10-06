import XCTest
@testable import BirtaWriter

/// An edit posted by a page that is being replaced never reaches the file.
///
/// Every path that reloads a window in place (a file opened from the file
/// list, a setting that reloads, Back to My Notes) flushes the page, binds
/// the window to its next file, and only then loads. Between those, the old
/// page is still live: `loadPage` keeps it on screen and focused while it
/// snapshots it for the reload cover. An `update` it posts then carries the
/// OLD note's text, `guardState` would admit it, and the write would land in
/// the file the window is now bound to. So both edit handlers refuse while a
/// page is loading, which is the only time such a page can be talking.
///
/// A source-text guard, for the reason `BacklinkRevealTests` gives: a live
/// check builds a `Coordinator` and its WebKit helpers, and the moment it
/// would have to type into is a few milliseconds wide.
@MainActor
final class ReplacedPageEditsTests: XCTestCase {
    private func coordinator() -> [String] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Sources/BirtaWriter/Coordinator.swift")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            XCTFail("could not read \(url.path); if Coordinator.swift moved, this guard must follow it")
            return []
        }
        return text.components(separatedBy: "\n")
    }

    /// The first statement of the `case` whose label contains `label`.
    private func firstStatement(ofCase label: String, in lines: [String]) -> String? {
        guard let start = lines.firstIndex(where: { $0.contains(label) }) else { return nil }
        return lines[(start + 1)...].first { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            return !trimmed.isEmpty && !trimmed.hasPrefix("//")
        }?.trimmingCharacters(in: .whitespaces)
    }

    func testEveryEditHandlerShouldRefuseBeforeItAdmitsAnything() {
        let lines = coordinator()
        guard !lines.isEmpty else { return }
        for label in ["case let .update(content, base, seq):", "case let .frontmatterUpdate(frontmatter, base):"] {
            let first = firstStatement(ofCase: label, in: lines)
            XCTAssertNotNil(first, "Coordinator has no \(label); this guard needs rewriting")
            XCTAssertEqual(first, "guard acceptsEdits else {",
                           "\(label) admits an edit before asking whether its page is the one being replaced")
        }
    }

    func testEditsShouldBeRefusedExactlyWhileAPageIsLoading() {
        let lines = coordinator()
        guard !lines.isEmpty else { return }
        XCTAssertTrue(lines.contains { $0.trimmingCharacters(in: .whitespaces) == "private var acceptsEdits: Bool { state != .loading }" },
                      "acceptsEdits no longer reads the page's state, so a replaced page's edit can be admitted")
        // And the state it reads is set before the window can be rebound to
        // a page that is not up: the first thing `loadPage` does.
        guard let load = lines.firstIndex(where: { $0.contains("private func loadPage()") }) else {
            return XCTFail("Coordinator has no loadPage; this guard needs rewriting")
        }
        let opening = lines[(load + 1)...].prefix(3).map { $0.trimmingCharacters(in: .whitespaces) }
        XCTAssertTrue(opening.contains("state = .loading"),
                      "loadPage no longer marks the page loading before anything else: \(opening)")
    }
}
