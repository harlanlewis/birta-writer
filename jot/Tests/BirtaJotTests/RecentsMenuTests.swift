import AppKit
import XCTest
@testable import BirtaJot
@testable import BirtaJotCore

/// The recents menu as AppKit ends up holding it.
///
/// `RecentFilesTests` already covers the model, so nothing here re-asserts an
/// order or a title. What only the built menu can answer is whether the rows
/// were ever added, whether a row will actually DO anything when it is picked
/// (a nil `representedObject` or a target that pins the click off the responder
/// chain both look fine in a screenshot), and whether the menu notices that the
/// list changed under it, which is the way this feature goes quietly stale.
@MainActor
final class RecentsMenuTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    private func url(_ path: String) -> URL { URL(fileURLWithPath: path) }
    private func many(_ n: Int) -> [URL] { (0..<n).map { url("/notes/note\($0).md") } }

    /// A menu over a list this test controls, with every file present.
    private func menu(_ list: [URL]) -> RecentsMenu {
        RecentsMenu(source: { list }, exists: { _ in true })
    }

    private func titles(of menu: NSMenu) -> [String] {
        menu.items.map { $0.isSeparatorItem ? "-" : $0.title }
    }

    func testAShortListShouldBeRowsThenClearMenuAndNoMore() {
        let m = menu([url("/a/one.md"), url("/a/two.md")])
        XCTAssertEqual(titles(of: m), ["one.md", "two.md", "-", "Clear Menu"])
    }

    func testALongListShouldPutItsTailBehindMore() throws {
        let m = menu(many(RecentFiles.capacity))
        let more = try XCTUnwrap(m.items.first { $0.title == "More" })
        XCTAssertEqual(m.items.filter { $0.representedObject is URL }.count, RecentFiles.firstPage)
        XCTAssertEqual(more.submenu?.items.count, RecentFiles.morePage)
        // More is the last thing before the rule, so the twenty are reached
        // from the bottom of the ten rather than from the middle of them.
        XCTAssertEqual(Array(titles(of: m).suffix(3)), ["More", "-", "Clear Menu"])
    }

    func testAnEmptyListShouldSayItIsEmptyRatherThanShowOneLiveRow() {
        let m = menu([])
        XCTAssertEqual(titles(of: m), ["No Recent Files", "-", "Clear Menu"])
        // Dead because it has no action. Writing `isEnabled` instead would be
        // overwritten by AppKit's own validation the next time it is shown.
        XCTAssertNil(m.items[0].action)
    }

    func testEveryFileRowShouldCarryItsFileAndLeaveTheClickOnTheResponderChain() throws {
        let m = menu([url("/a/one.md"), url("/a/two.md")])
        let rows = m.items.filter { $0.representedObject != nil }
        XCTAssertEqual(rows.count, 2)
        for row in rows {
            XCTAssertEqual(row.action, #selector(AppDelegate.menuOpenRecentDocument(_:)))
            XCTAssertNil(row.target, "a target pins the click to one object and leaves the chain")
            XCTAssertNotNil(row.representedObject as? URL, "the row knows what to open")
        }
        XCTAssertEqual(rows.map { ($0.representedObject as? URL)?.path }, ["/a/one.md", "/a/two.md"])
        // The path is what tells apart two files the title cannot.
        XCTAssertEqual(rows.first?.toolTip, "/a/one.md")
    }

    func testARowBehindMoreShouldWorkTheSameWayAsOneOnTheMenu() throws {
        // The tail is where a second, quieter code path would go unnoticed:
        // twenty rows nobody clicks until the week they need one.
        let m = menu(many(RecentFiles.capacity))
        let sub = try XCTUnwrap(m.items.first { $0.title == "More" }?.submenu)
        let row = try XCTUnwrap(sub.items.first)
        XCTAssertEqual(row.action, #selector(AppDelegate.menuOpenRecentDocument(_:)))
        XCTAssertNil(row.target)
        XCTAssertNotNil(row.representedObject as? URL)
    }

    func testTheMenuShouldRebuildItselfWhenTheListHasChanged() {
        // The failure this is for: the menu bar is built once at launch, so a
        // menu whose rows were decided then looks right for the whole session
        // and is wrong from the second file opened onward.
        var list = [url("/a/one.md")]
        let m = RecentsMenu(source: { list }, exists: { _ in true })
        XCTAssertEqual(titles(of: m).first, "one.md")
        list = [url("/a/two.md"), url("/a/one.md")]
        m.menuNeedsUpdate(m)
        XCTAssertEqual(Array(titles(of: m).prefix(2)), ["two.md", "one.md"])
    }

    func testTheMenuShouldBeItsOwnDelegateSoNobodyElseHasToRememberToFillIt() {
        // Two surfaces raise this menu and neither builds it. If the filling
        // were the caller's, one of them would eventually be the caller that
        // forgot, and it would show yesterday's list.
        let m = menu([url("/a/one.md")])
        XCTAssertTrue(m.delegate === m)
        XCTAssertEqual(m.identifier, JotMenu.recentsMenuIdentifier)
    }

    func testAMissingFileShouldNotBeOfferedAtAll() {
        let m = RecentsMenu(source: { [self.url("/a/here.md"), self.url("/a/gone.md")] },
                            exists: { $0.lastPathComponent == "here.md" })
        XCTAssertEqual(titles(of: m), ["here.md", "-", "Clear Menu"])
    }

    func testPickingARowShouldReachTheDelegateWithTheFileItNames() {
        // The claim every check above stops short of: a row with the right
        // selector, the right (nil) target and the right file still does
        // nothing unless the click finds something at the end of the responder
        // chain. Nil target is what puts it there, and nil target is also what
        // makes the failure silent, so this is the arm that has to exist.
        let spy = RecentsSpy()
        let previous = NSApp.delegate
        NSApp.delegate = spy
        defer { NSApp.delegate = previous }

        let m = menu([url("/a/one.md"), url("/a/two.md")])
        m.performActionForItem(at: 1)
        XCTAssertEqual(spy.opened.map(\.path), ["/a/two.md"])

        m.performActionForItem(at: m.indexOfItem(withTitle: "Clear Menu"))
        XCTAssertEqual(spy.cleared, 1)
    }

    func testTheMenuTheFileRowOpensShouldBeTheSameOneTheButtonOpens() {
        // One implementation, two surfaces. The File menu attaches a
        // `RecentsMenu` and the titlebar button pops one; a check that only
        // read the built menu bar would pass with the button popping something
        // else entirely.
        let nsMenu = NSMenu(title: "File")
        JotMenu.add(.file, to: nsMenu, target: self)
        let attached = nsMenu.items.first { $0.title == "Open Recent" }?.submenu
        XCTAssertTrue(attached is RecentsMenu)
    }
}

/// Stands in for the application's delegate, so a pick that leaves the menu can
/// be seen arriving somewhere. Named by what it carried rather than counted,
/// because "a row fired" is true of the wrong row too.
@MainActor
private final class RecentsSpy: NSObject, NSApplicationDelegate {
    var opened: [URL] = []
    var cleared = 0
    @objc func menuOpenRecentDocument(_ sender: NSMenuItem) {
        if let url = sender.representedObject as? URL { opened.append(url) }
    }
    @objc func menuClearRecentDocuments() { cleared += 1 }
}
