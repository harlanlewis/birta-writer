import AppKit
import XCTest
@testable import BirtaWriter

/// A tab added behind the one in front, as AppKit actually holds it, which is
/// what `WindowSet.open` builds on: the addition alone neither selects the new
/// tab nor puts it on screen, so the tab the reader was in stays drawn while
/// the new page builds, and `tabShowingInstead` names that tab for the wait.
/// If AppKit ever starts bringing an added tab forward, the first test goes
/// red here rather than the reader seeing paper again.
@MainActor
final class HeldTabTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    private func window() -> NSWindow {
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1024, height: 700)
        let window = NSWindow(contentRect: NSRect(x: visible.minX + 20, y: visible.minY + 20, width: 480, height: 320),
                              styleMask: [.titled, .closable, .resizable],
                              backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .preferred
        window.tabbingIdentifier = "held-tab-tests"
        return window
    }

    func testATabAddedToAGroupOnScreenShouldWaitInTheBarBehindTheOneInFront() throws {
        let front = window()
        let added = window()
        defer { added.close(); front.close() }
        front.orderFront(nil)
        XCTAssertTrue(front.isVisible, "the fixture never came on screen, so nothing below is about tabs")

        front.addTabbedWindow(added, ordered: .above)

        let group = try XCTUnwrap(front.tabGroup)
        XCTAssertEqual(group.windows.count, 2, "the tab never joined the bar, so this would pass for no reason")
        XCTAssertTrue(group.selectedWindow === front, "adding the tab took the reader's tab away before the new one was ready")
        XCTAssertTrue(front.isVisible)
        XCTAssertFalse(added.isVisible, "the new tab is on screen while its page is still being built")
        XCTAssertTrue(added.tabShowingInstead === front, "the held tab does not know what is in front of it, so nothing waits")
        XCTAssertNil(front.tabShowingInstead, "the tab in front reads as held")
    }

    func testShowingTheHeldTabShouldBringItForwardAndEndTheWait() throws {
        let front = window()
        let added = window()
        defer { added.close(); front.close() }
        front.orderFront(nil)
        front.addTabbedWindow(added, ordered: .above)

        // What `Coordinator.show` does once the page is up.
        added.makeKeyAndOrderFront(nil)

        XCTAssertTrue(front.tabGroup?.selectedWindow === added, "showing a held tab did not select it")
        XCTAssertNil(added.tabShowingInstead, "a tab in front reads as held, and would wait on itself")
    }

    func testAGroupNobodyCanSeeShouldHaveNothingInFrontToWaitBehind() throws {
        let front = window()
        let added = window()
        defer { added.close(); front.close() }
        // Never ordered in: a launch putting tabs back, or a hidden app.
        front.addTabbedWindow(added, ordered: .above)

        XCTAssertEqual(front.tabGroup?.windows.count, 2)
        XCTAssertNil(added.tabShowingInstead,
                     "a tab behind a window nobody sees would wait to replace nothing, rather than come up by itself")
    }
}
