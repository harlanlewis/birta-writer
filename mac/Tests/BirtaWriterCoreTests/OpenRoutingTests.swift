import XCTest
@testable import BirtaWriterCore

/// The four arms of where an opened file lands, in the order they outrank
/// each other.
final class OpenRoutingTests: XCTestCase {
    private let same: (String, String) -> Bool = { $0 == $1 }
    private let inside: (String, String) -> Bool = { file, root in file.hasPrefix(root + "/") }

    private func route(_ file: String, _ windows: [OpenRouting.Window]) -> OpenRouting.Destination {
        OpenRouting.destination(for: file, windows: windows, sameFile: same, isInside: inside)
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
