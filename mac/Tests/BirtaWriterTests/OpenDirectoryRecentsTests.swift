import XCTest
@testable import BirtaWriter

/// That opening a folder records it, which is the one link in Open Recent's
/// folder support that nothing else covers.
///
/// `RecentFilesTests` holds what the list does with a folder once it is in it,
/// and `RecentsMenuTests` holds what the menu draws. Between them is the call
/// that puts it there, and it lives in `WindowSet.openDirectory`, which makes
/// a `Coordinator`, which builds a `WKWebView`. No test in this suite starts
/// WebKit, for the reasons `WindowLifetimeTests` sets out: the helper
/// processes are not children of this one and are cleaned up by
/// `mac/scripts/reap.sh` rather than by anything XCTest does.
///
/// So this is a source guard, in that file's own style, and it is worth being
/// plain about what it can and cannot say. It can see the call being deleted,
/// which is the failure that would take folders back out of Open Recent
/// silently and is what it exists for. It cannot see the call running, the
/// order it runs in, or the folder it is handed. A rename of
/// `rememberRecent` fails it, which is a true red about a stale guard rather
/// than a false one; a refactor that moves the call behind a helper fails it
/// too, and the answer there is to rewrite this, not to widen it until it
/// matches anything.
@MainActor
final class OpenDirectoryRecentsTests: XCTestCase {
    /// The body of `openDirectory`, as source lines.
    private func openDirectoryBody() -> [String] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Sources/BirtaWriter/WindowSet.swift")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            XCTFail("could not read \(url.path); if WindowSet.swift moved, this guard must follow it")
            return []
        }
        let lines = text.components(separatedBy: "\n")
        guard let start = lines.firstIndex(where: { $0.contains("func openDirectory(") }) else {
            XCTFail("WindowSet has no openDirectory; this guard needs rewriting")
            return []
        }
        guard let end = lines[(start + 1)...].firstIndex(where: { $0 == "    }" }) else {
            XCTFail("could not find the end of openDirectory")
            return []
        }
        return Array(lines[start...end])
    }

    func testOpeningAFolderShouldRecordItOnBothOfItsPaths() {
        let body = openDirectoryBody()
        // The arm that stops the count below being taken over an empty array,
        // which is what a moved function or a changed brace would leave.
        XCTAssertGreaterThan(body.count, 10, "openDirectory's body did not come back")
        let records = body.filter { $0.contains("Prefs.rememberRecent(") }
        // TWO: a folder already open is fronted and returns early, and a
        // folder being opened for the first time falls through. A single call
        // means one of those two paths stopped recording, and the one that
        // usually goes is the early return, which is every second visit to a
        // folder you keep coming back to.
        XCTAssertEqual(records.count, 2,
                       "openDirectory records the folder on the early return and on the open: \(records)")
    }
}
