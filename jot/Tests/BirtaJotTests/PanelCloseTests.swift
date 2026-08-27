import AppKit
import XCTest
@testable import BirtaJot

/// What a close MEANS, which stopped being one answer the day there could be
/// more than one window.
///
/// The close button and Cmd+W both reach `JotPanel.close`, and the app decides:
/// with several windows this one closes, and with one it hides, so the editor
/// stays mounted and the next summon is immediate rather than a cold start.
/// `JotPanel` carries that as a request while anybody is listening for one, and
/// falls through to a real close when nobody is.
///
/// The fall-through is the half worth a check, because it did not exist while
/// nothing could close a window and its absence is silent. A window only
/// ordered out stays in `NSApp.windows`, which is the list AppKit builds the
/// Window menu from, so a note you closed would go on being listed as open.
///
/// Nothing is shown. The window is built, asked to close, and read back;
/// `willCloseNotification` is what makes that observable without ever ordering
/// it on screen.
@MainActor
final class PanelCloseTests: XCTestCase {
    override func setUp() {
        super.setUp()
        // AppKit wants its application object to exist before a window does.
        _ = NSApplication.shared
    }

    /// `remembersFrame: false` throughout: the frame autosave writes to the
    /// app's standard defaults whatever `BIRTA_JOT_DEFAULTS_SUITE` says, so a
    /// panel built here that named itself would hand the person running the
    /// suite back a window the size of whatever a test finished on.
    private func panel() -> JotPanel { JotPanel(remembersFrame: false) }

    /// Watch for a real close while `body` runs.
    private func closed(during body: () -> Void) -> Bool {
        var closed = false
        let token = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: nil, queue: nil
        ) { _ in closed = true }
        defer { NotificationCenter.default.removeObserver(token) }
        body()
        return closed
    }

    func testACloseShouldBeAskedAboutWhileTheAppIsListening() {
        let window = panel()
        var asked = 0
        window.onHideRequest = { asked += 1 }

        let reallyClosed = closed { window.close() }

        XCTAssertEqual(asked, 1, "the app was not asked what a close should mean")
        XCTAssertFalse(reallyClosed, "the window closed itself instead of asking")
    }

    /// The teardown path. Clearing the handler is how a caller says it means
    /// this one, and the window has to take it: there is otherwise no way to
    /// close this window from any code path at all.
    func testAWindowWithNobodyListeningShouldActuallyClose() {
        let window = panel()
        window.onHideRequest = nil

        XCTAssertTrue(closed { window.close() },
                      "a torn-down window never closed, so it stays in NSApp.windows "
                        + "and stays listed in the Window menu")
    }

    /// The two arms have to be the same window doing different things, or the
    /// pair proves only that two windows exist.
    func testTheSameWindowShouldAskThenCloseOnceNobodyIsListening() {
        let window = panel()
        var asked = 0
        window.onHideRequest = { asked += 1 }

        XCTAssertFalse(closed { window.close() })
        window.onHideRequest = nil
        XCTAssertTrue(closed { window.close() })
        XCTAssertEqual(asked, 1, "the handler ran again after it was cleared")
    }
}
