import XCTest
@testable import BirtaWriterCore

/// The recents list as a model: what recording does to it, which rows a menu
/// gets, and where the More boundary falls.
///
/// Every case here injects its own existence predicate, so nothing below
/// touches a disk or depends on what happens to be in /tmp.
final class RecentFilesTests: XCTestCase {
    private func url(_ path: String) -> URL { URL(fileURLWithPath: path) }
    private func urls(_ paths: [String]) -> [URL] { paths.map(url) }
    /// A list of `n` distinct files, newest last, for the paging cases.
    private func many(_ n: Int) -> [URL] { (0..<n).map { url("/notes/note\($0).md") } }

    private let all: (URL) -> Bool = { _ in true }

    // MARK: recording

    func testARecordedFileShouldGoToTheFrontOfTheList() {
        let list = RecentFiles.recording(url("/a/new.md"), into: urls(["/a/old.md"]))
        XCTAssertEqual(list.map(\.path), ["/a/new.md", "/a/old.md"])
    }

    func testRecordingAFileAlreadyInTheListShouldMoveItRatherThanRepeatIt() {
        let list = RecentFiles.recording(url("/a/two.md"),
                                         into: urls(["/a/one.md", "/a/two.md", "/a/three.md"]))
        XCTAssertEqual(list.map(\.path), ["/a/two.md", "/a/one.md", "/a/three.md"])
    }

    func testTwoSpellingsOfOnePathShouldBeOneEntry() {
        // The same file reached two ways is one file. Without the standardize
        // it is two rows that open the same document, which is the shape a
        // recents list is most likely to fill up with.
        let list = RecentFiles.recording(url("/a/./b/../b/note.md"), into: urls(["/a/b/note.md"]))
        XCTAssertEqual(list.count, 1)
    }

    func testTheListShouldStopAtItsCapacity() {
        var list = many(RecentFiles.capacity).reversed().map { $0 }
        XCTAssertEqual(list.count, RecentFiles.capacity)
        list = RecentFiles.recording(url("/a/newest.md"), into: list)
        XCTAssertEqual(list.count, RecentFiles.capacity)
        XCTAssertEqual(list.first?.path, "/a/newest.md")
        // The one that fell off is the oldest, not an arbitrary one.
        XCTAssertFalse(list.contains(url("/notes/note0.md")))
    }

    // MARK: rows

    func testAFileThatIsGoneShouldBeLeftOutOfTheMenuAndKeptInTheList() {
        let stored = urls(["/a/here.md", "/a/gone.md", "/a/also-here.md"])
        let rows = RecentFiles.rows(from: stored, exists: { $0.lastPathComponent != "gone.md" })
        XCTAssertEqual(rows.map(\.title), ["here.md", "also-here.md"])
        // The store is the caller's and this returns rows, so nothing here can
        // prune it: a file on a volume that is not mounted this morning must
        // still be in the list this afternoon.
        XCTAssertEqual(stored.count, 3)
    }

    func testARowShouldSayJustTheFileNameWhenNothingElseSharesIt() {
        let rows = RecentFiles.rows(from: urls(["/work/plan.md", "/home/diary.md"]), exists: all)
        XCTAssertEqual(rows.map(\.title), ["plan.md", "diary.md"])
    }

    func testTwoRowsWithOneNameShouldEachNameTheirFolder() {
        let rows = RecentFiles.rows(
            from: urls(["/work/notes.md", "/home/notes.md", "/work/plan.md"]), exists: all)
        XCTAssertEqual(rows.map(\.title), ["notes.md (work)", "notes.md (home)", "plan.md"])
        // The point is that no two rows read the same; the folder is how, not
        // what. Asserted as the property too, so a different spelling of the
        // suffix does not need this case rewritten to stay meaningful.
        XCTAssertEqual(Set(rows.map(\.title)).count, rows.count)
    }

    func testARowShouldStillCarryItsOwnFileWhateverItSays() {
        // The title is disambiguation and the URL is the action. A row that
        // said the right thing and opened the wrong file would pass every
        // title check above.
        let rows = RecentFiles.rows(from: urls(["/work/notes.md", "/home/notes.md"]), exists: all)
        XCTAssertEqual(rows.map(\.url.path), ["/work/notes.md", "/home/notes.md"])
    }

    // MARK: paging

    func testAShortListShouldAllFitOnTheMenuWithNothingBehindMore() {
        let (first, more) = RecentFiles.pages(RecentFiles.rows(from: many(3), exists: all))
        XCTAssertEqual(first.count, 3)
        XCTAssertTrue(more.isEmpty, "More must not be drawn when everything fits")
    }

    func testALongListShouldFillTheMenuAndPutTheRestBehindMore() {
        let rows = RecentFiles.rows(from: many(RecentFiles.capacity), exists: all)
        let (first, more) = RecentFiles.pages(rows)
        XCTAssertEqual(first.count, RecentFiles.firstPage)
        XCTAssertEqual(more.count, RecentFiles.morePage)
        // In order, and with no row in both halves or in neither.
        XCTAssertEqual((first + more).map(\.url), rows.map(\.url))
    }

    func testTheBoundaryShouldFallExactlyAtTheFirstPage() {
        let atTheEdge = RecentFiles.pages(RecentFiles.rows(from: many(RecentFiles.firstPage), exists: all))
        XCTAssertTrue(atTheEdge.more.isEmpty)
        let oneOver = RecentFiles.pages(RecentFiles.rows(from: many(RecentFiles.firstPage + 1), exists: all))
        XCTAssertEqual(oneOver.more.count, 1)
    }

    func testTheStoredListShouldNeverBeLongerThanAMenuCanShow() {
        // The two page sizes are what the capacity is FOR, so a change to one
        // that left the other behind would strand rows nothing draws.
        XCTAssertEqual(RecentFiles.capacity, RecentFiles.firstPage + RecentFiles.morePage)
    }
}
