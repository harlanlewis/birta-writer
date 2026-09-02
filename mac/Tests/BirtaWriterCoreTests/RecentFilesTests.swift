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

    // MARK: the menu, once there can be more than one window

    private let here = URL(fileURLWithPath: "/notes/here.md")

    func testTheFileThisWindowIsOnShouldAppearInNeitherGroup() {
        let menu = RecentFiles.menu(stored: urls(["/notes/here.md", "/notes/old.md"]),
                                    openElsewhere: [], here: here, exists: all)
        XCTAssertEqual(menu.recent.map(\.url.path), ["/notes/old.md"])
        XCTAssertTrue(menu.elsewhere.isEmpty)
    }

    func testAFileOpenInAnotherWindowShouldBeInTheGroupAndNowhereElse() {
        // Listed twice it would be two rows doing the same thing, with only
        // the heading saying so.
        let two = URL(fileURLWithPath: "/notes/two.md")
        let menu = RecentFiles.menu(stored: urls(["/notes/two.md", "/notes/old.md"]),
                                    openElsewhere: [two], here: here, exists: all)
        XCTAssertEqual(menu.elsewhere.map(\.url.path), ["/notes/two.md"])
        XCTAssertEqual(menu.recent.map(\.url.path), ["/notes/old.md"])
    }

    /// The group is what the WINDOWS hold, so a file the recents list has never
    /// heard of is still in it. That is every file currently open in its first
    /// window: the list records a file when the window rebinds or closes, and
    /// neither has happened yet.
    func testAWindowsFileShouldBeListedEvenWhenItIsNotInTheStoredList() {
        let two = URL(fileURLWithPath: "/notes/two.md")
        let menu = RecentFiles.menu(stored: urls(["/notes/old.md"]),
                                    openElsewhere: [two], here: here, exists: all)
        XCTAssertEqual(menu.elsewhere.map(\.url.path), ["/notes/two.md"])
    }

    /// ...and existence is not asked of it. A note deleted underneath a window
    /// leaves that window on screen showing the missing-file card, holding a
    /// buffer that may be the only copy of the text, and a group that dropped
    /// it would offer no way back to that window.
    func testAWindowWhoseFileHasGoneShouldStillBeAWayBackToIt() {
        let gone = URL(fileURLWithPath: "/notes/gone.md")
        let menu = RecentFiles.menu(stored: urls(["/notes/old.md"]),
                                    openElsewhere: [gone], here: here,
                                    exists: { $0.lastPathComponent != "gone.md" })
        XCTAssertEqual(menu.elsewhere.map(\.url.path), ["/notes/gone.md"])
        XCTAssertEqual(menu.recent.map(\.url.path), ["/notes/old.md"],
                       "the stored list is still filtered, which is the difference")
    }

    /// Titles are decided across BOTH groups at once. Two notes called the same
    /// thing, one open in another window and one merely recent, are exactly the
    /// collision the folder suffix exists for, and two lists disambiguated
    /// separately would each conclude its own name was unique.
    func testANameThatCollidesACROSSTheTwoGroupsShouldStillCarryItsFolder() {
        let open = URL(fileURLWithPath: "/work/notes.md")
        let menu = RecentFiles.menu(stored: urls(["/home/notes.md"]),
                                    openElsewhere: [open], here: here, exists: all)
        XCTAssertEqual(menu.elsewhere.map(\.title), ["notes.md (work)"])
        XCTAssertEqual(menu.recent.map(\.title), ["notes.md (home)"])
    }

    func testANameThatIsUniqueAcrossBothGroupsShouldStayJustAName() {
        let open = URL(fileURLWithPath: "/work/two.md")
        let menu = RecentFiles.menu(stored: urls(["/home/one.md"]),
                                    openElsewhere: [open], here: here, exists: all)
        XCTAssertEqual(menu.elsewhere.map(\.title), ["two.md"])
        XCTAssertEqual(menu.recent.map(\.title), ["one.md"])
    }

    func testTheGroupShouldKeepTheOrderItWasGiven() {
        // Most recently fronted first is the caller's ordering; what this holds
        // is that nothing here re-sorts it.
        let two = URL(fileURLWithPath: "/notes/two.md")
        let three = URL(fileURLWithPath: "/notes/three.md")
        let menu = RecentFiles.menu(stored: [], openElsewhere: [two, three],
                                    here: here, exists: all)
        XCTAssertEqual(menu.elsewhere.map(\.url.path), ["/notes/two.md", "/notes/three.md"])
    }

    /// Two windows cannot hold one file (`WindowSet.openDocument` refuses it),
    /// but a caller assembling this list is not the place to rely on that.
    func testAFileNamedTwiceInTheGroupShouldAppearOnce() {
        let two = URL(fileURLWithPath: "/notes/two.md")
        let alias = URL(fileURLWithPath: "/notes/./two.md")
        let menu = RecentFiles.menu(stored: [], openElsewhere: [two, alias],
                                    here: here, exists: all)
        XCTAssertEqual(menu.elsewhere.count, 1)
    }

    func testAMenuIsEmptyOnlyWhenBOTHGroupsAre() {
        // What the "No Recent Files" row is for. Asked of both, so it never
        // appears under a group of windows saying there is nothing here.
        XCTAssertTrue(RecentFiles.menu(stored: [], openElsewhere: [], here: here, exists: all).isEmpty)
        XCTAssertFalse(RecentFiles.menu(stored: [], openElsewhere: [URL(fileURLWithPath: "/n/two.md")],
                                        here: here, exists: all).isEmpty)
        XCTAssertFalse(RecentFiles.menu(stored: urls(["/n/old.md"]), openElsewhere: [],
                                        here: here, exists: all).isEmpty)
    }

    /// A window on no file at all is a real state, and the menu is then simply
    /// the list.
    func testAWindowOnNothingShouldExcludeNothing() {
        let menu = RecentFiles.menu(stored: urls(["/notes/a.md", "/notes/b.md"]),
                                    openElsewhere: [], here: nil, exists: all)
        XCTAssertEqual(menu.recent.count, 2)
    }
}
