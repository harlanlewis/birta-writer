import XCTest
@testable import BirtaWriterCore

/// The arms of where a file opened from outside lands, in the order they
/// outrank each other.
final class OpenRoutingTests: XCTestCase {
    private let same: (String, String) -> Bool = { $0 == $1 }
    private let inside: (String, String) -> Bool = { file, root in file.hasPrefix(root + "/") }

    private func route(_ file: String, _ windows: [OpenRouting.Window], inTab: Bool = false) -> OpenRouting.Destination {
        OpenRouting.destination(for: file, windows: windows, looseFilesOpenInTab: inTab, sameFile: same, isInside: inside)
    }

    func testALooseFileShouldOpenAsATabBesideTheFrontWindowWhenTheSettingSaysTab() {
        let windows = [OpenRouting.Window(file: "/a.md"), OpenRouting.Window(file: "/notes/b.md", root: "/notes")]
        XCTAssertEqual(route("/elsewhere/c.md", windows, inTab: true), .tabBeside(1), "the window in front is last")
        XCTAssertEqual(route("/elsewhere/c.md", windows, inTab: false), .newWindow)
    }

    func testTheTabSettingShouldNotOutrankARootOrAVacantFront() {
        XCTAssertEqual(route("/notes/c.md", [OpenRouting.Window(file: "/notes/a.md", root: "/notes")], inTab: true), .tabIn(0))
        XCTAssertEqual(route("/c.md", [OpenRouting.Window(file: "/gone.md", isVacant: true)], inTab: true), .vacantFront)
        XCTAssertEqual(route("/c.md", [], inTab: true), .newWindow, "a tab needs a window to sit beside")
    }

    func testAFileAlreadyOpenShouldFrontItsWindowWhateverElseIsOpen() {
        let windows = [OpenRouting.Window(file: "/notes/a.md", root: "/notes"),
                       OpenRouting.Window(file: "/other/b.md", isVacant: true)]
        XCTAssertEqual(route("/notes/a.md", windows), .existing(0),
                       "open already, so neither the root nor the vacant front gets it")
    }

    func testAFileUnderAnOpenRootShouldBecomeATabThere() {
        let windows = [OpenRouting.Window(file: "/loose.md"),
                       OpenRouting.Window(file: "/notes/a.md", root: "/notes")]
        XCTAssertEqual(route("/notes/sub/c.md", windows), .tabIn(1))
    }

    func testTwoWindowsRootedOverTheFileShouldGiveItToTheMostRecentlyFronted() {
        let windows = [OpenRouting.Window(file: "/notes/a.md", root: "/notes"),
                       OpenRouting.Window(file: "/notes/b.md", root: "/notes")]
        XCTAssertEqual(route("/notes/c.md", windows), .tabIn(1), "most recently fronted is last")
    }

    func testAVacantFrontWindowShouldTakeTheFileOver() {
        let windows = [OpenRouting.Window(file: "/a.md"), OpenRouting.Window(file: "/gone.md", isVacant: true)]
        XCTAssertEqual(route("/new.md", windows), .vacantFront)
    }

    func testAVacantWindowNotInFrontShouldBeLeftAlone() {
        let windows = [OpenRouting.Window(file: "/gone.md", isVacant: true), OpenRouting.Window(file: "/a.md")]
        XCTAssertEqual(route("/new.md", windows), .newWindow,
                       "only the window in front is asked; a vacant one behind would open the file where nobody looks")
    }

    func testARootShouldOutrankAVacantFront() {
        let windows = [OpenRouting.Window(file: "/notes/a.md", root: "/notes"),
                       OpenRouting.Window(file: "/gone.md", isVacant: true)]
        XCTAssertEqual(route("/notes/c.md", windows), .tabIn(0))
    }

    func testWithNoWindowsTheAnswerIsANewWindow() {
        XCTAssertEqual(route("/x.md", []), .newWindow)
    }

    func testARootPrefixThatIsNotAFolderBoundaryShouldNotCapture() {
        let windows = [OpenRouting.Window(file: "/notes/a.md", root: "/notes")]
        XCTAssertEqual(route("/notes-archive/c.md", windows), .newWindow,
                       "the caller's isInside decides the boundary; this one is strict about it")
    }
}

/// Where a row of the explorer sends its file: into the tab it was clicked
/// in, unless a new tab was asked for or the tab holds text that only lives
/// in it; never into another window.
final class ExplorerRoutingTests: XCTestCase {
    private let same: (String, String) -> Bool = { $0 == $1 }
    /// Two tabs of one folder window, then a loose window on a file of that
    /// folder, then the clicked window's group again at the front.
    private let windows = [OpenRouting.Window(file: "/notes/a.md", root: "/notes", group: "g1"),
                           OpenRouting.Window(file: "/notes/b.md", root: "/notes", group: "g1"),
                           OpenRouting.Window(file: "/notes/loose.md")]

    private func route(_ file: String, here: Int = 0, inNewTab: Bool = false, unsaved: Bool = false) -> OpenRouting.ExplorerDestination {
        OpenRouting.explorerDestination(for: file, windows: windows, here: here, inNewTab: inNewTab,
                                        hereHoldsUnsavedText: unsaved, sameFile: same)
    }

    func testAPlainClickShouldReplaceTheFileInTheClickedTab() {
        XCTAssertEqual(route("/notes/c.md"), .replaceHere)
    }

    func testAClickAskingForANewTabShouldOpenOneBeside() {
        XCTAssertEqual(route("/notes/c.md", inNewTab: true), .tabHere)
    }

    func testAFileOpenAsAnotherTabOfThisWindowShouldFrontThatTab() {
        XCTAssertEqual(route("/notes/b.md"), .existing(1))
        XCTAssertEqual(route("/notes/b.md", inNewTab: true), .existing(1),
                       "a second tab on one file in one window is two writers over one path")
    }

    func testAFileOpenInAnotherWindowShouldFrontThatWindowRatherThanOpenASecondBuffer() {
        XCTAssertEqual(route("/notes/loose.md"), .existing(2),
                       "two buffers over one path lose the earlier edits when the later one writes")
        XCTAssertEqual(route("/notes/loose.md", inNewTab: true), .existing(2),
                       "a new-tab ask is not a licence for a second writer over one path")
    }

    func testThisWindowsOwnTabShouldStillOutrankAnotherWindowHoldingTheSameFile() {
        // The clicked window's group holds b.md and so does a loose window
        // elsewhere: the reader stays where they clicked.
        let both = windows + [OpenRouting.Window(file: "/notes/b.md")]
        XCTAssertEqual(OpenRouting.explorerDestination(for: "/notes/b.md", windows: both, here: 0, inNewTab: false,
                                                       hereHoldsUnsavedText: false, sameFile: same),
                       .existing(1))
    }

    func testAWindowWithNoTabsShouldMatchOnlyItself() {
        XCTAssertEqual(route("/notes/loose.md", here: 2), .existing(2))
        XCTAssertEqual(route("/notes/c.md", here: 2), .replaceHere, "a nil group is no group, not a shared one")
        XCTAssertEqual(route("/notes/a.md", here: 2), .existing(0),
                       "the file is open in another window, so that window is fronted, not the nil group matched")
    }

    func testTwoWindowsThatReadAlikeShouldStillBeTwoWindows() {
        // Two folder windows on the same root and the same file, neither with
        // tabs: a click on that file in the second must front the second.
        let twins = [OpenRouting.Window(file: "/notes/a.md", root: "/notes"),
                     OpenRouting.Window(file: "/notes/a.md", root: "/notes")]
        XCTAssertEqual(OpenRouting.explorerDestination(for: "/notes/a.md", windows: twins, here: 1, inNewTab: false,
                                                       hereHoldsUnsavedText: false, sameFile: same),
                       .existing(1))
    }

    func testATabWithUnsavedTextShouldBeLeftAloneAndTheFileOpenedBesideIt() {
        XCTAssertEqual(route("/notes/c.md", unsaved: true), .tabHere)
    }
}
