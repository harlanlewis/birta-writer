import XCTest
@testable import BirtaJotCore

final class RecentDestinationsTests: XCTestCase {
    private func dir(_ path: String) -> URL { URL(fileURLWithPath: path, isDirectory: true) }

    func testTheNewestDestinationComesFirst() {
        var recents = RecentDestinations()

        recents.remember(dir("/notes/inbox"))
        recents.remember(dir("/notes/journal"))

        XCTAssertEqual(recents.paths, ["/notes/journal", "/notes/inbox"])
    }

    func testAFolderUsedAgainMovesToTheFrontRatherThanRepeating() {
        var recents = RecentDestinations(["/notes/journal", "/notes/inbox"])

        recents.remember(dir("/notes/inbox"))

        XCTAssertEqual(recents.paths, ["/notes/inbox", "/notes/journal"])
    }

    func testTrailingSlashesAndDotsAreTheSameFolder() {
        var recents = RecentDestinations()

        recents.remember(dir("/notes/inbox"))
        recents.remember(dir("/notes/./inbox/"))

        XCTAssertEqual(recents.paths, ["/notes/inbox"])
    }

    func testTheListStopsAtTheLimit() {
        var recents = RecentDestinations()

        for n in 1...(RecentDestinations.limit + 3) { recents.remember(dir("/notes/\(n)")) }

        XCTAssertEqual(recents.paths.count, RecentDestinations.limit)
        XCTAssertEqual(recents.paths.first, "/notes/\(RecentDestinations.limit + 3)")
        XCTAssertFalse(recents.paths.contains("/notes/1"))
    }

    func testAStoredListLongerThanTheLimitIsTrimmedOnRead() {
        // Defaults written by a future build with a larger limit, or by hand.
        let stored = (1...12).map { "/notes/\($0)" }

        XCTAssertEqual(RecentDestinations(stored).paths.count, RecentDestinations.limit)
    }

    func testTheUrlsAreDirectories() {
        let recents = RecentDestinations(["/notes/inbox"])

        XCTAssertEqual(recents.urls.first?.path, "/notes/inbox")
        XCTAssertTrue(recents.urls.first?.hasDirectoryPath ?? false)
    }
}
