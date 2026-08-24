import AppKit
import BirtaJotCore
import XCTest
@testable import BirtaJot

/// Whether the notice can be SEEN, which is a separate question from what it
/// says and is the one the first cut of this got wrong twice.
///
/// The notice is raised from `applicationDidFinishLaunching` of an
/// `LSUIElement` app, which is not the active application at that moment even
/// when a person launched it by hand. An `NSPopover` asked to show then does
/// nothing at all and reports no error, so the notice was being asked for at
/// every launch and drawn at none. The test process is in the same state, in
/// the background with no window of its own in front, so the run is the
/// condition rather than a simulation of it: a presenter that needed the app
/// to be active would fail here exactly as it failed on the machine.
///
/// A real `NSStatusItem` is built and torn down, because the position is taken
/// from the button's own screen rectangle and a stand-in view would be
/// answering a question about itself. It is also the second thing that went
/// wrong: a status item is not laid out when a launch discovers the refusal,
/// and its button then reports a window of no height at the origin, so the
/// card was placed off the bottom of the screen. The presenter waits for the
/// item, which is why every check here pumps the run loop rather than reading
/// the window straight back.
///
/// One claim here is NOT checkable and there is deliberately no test asserting
/// it: that showing the notice never puts the app in front. `NSApp.activate`
/// does nothing in a process macOS has not made eligible to come forward, this
/// test runner included, so an assertion on `NSApp.isActive` stays green over a
/// presenter that activates on every launch. A check that cannot fail for its
/// own subject is worse than none, because it reads as cover. What holds that
/// half is the window kind pinned below: a `.nonactivatingPanel` ordered front
/// regardless has no activation to make.
@MainActor
final class SummonNoticeWindowTests: XCTestCase {
    private var statusItem: NSStatusItem?

    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    override func tearDown() {
        SummonNoticePresenter.dismissForTesting()
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        statusItem = nil
        super.tearDown()
    }

    private func makeAnchor() throws -> NSStatusBarButton {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.title = "B"
        statusItem = item
        return try XCTUnwrap(item.button)
    }

    /// Show it and turn the run loop until it is up, because the presenter
    /// waits for the status item to take its place before drawing anything.
    /// Generous enough to cover that wait and its fallback and no longer: a
    /// notice still absent after this is absent.
    @discardableResult
    private func showAndWait(_ anchor: NSStatusBarButton,
                             refused combo: HotkeyCombo = .release) throws -> SummonNoticePresenter {
        SummonNoticePresenter.show(refused: combo, from: anchor) { _ in noErr }
        let presenter = try XCTUnwrap(SummonNoticePresenter.current)
        let deadline = Date().addingTimeInterval(3)
        while !presenter.noticeWindow.isVisible, Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
        return presenter
    }

    /// What this does and does not discriminate, because the difference
    /// matters. `isVisible` fails for an `NSPopover` shown from a background
    /// app, which is the mistake that was actually made and is why the
    /// assertion is here. It does NOT tell `orderFront` from
    /// `orderFrontRegardless`: AppKit marks the window visible either way, and
    /// only the moment it reaches the glass differs. The two assertions under
    /// it carry that half instead, by pinning the window kind rather than the
    /// outcome.
    func testTheNoticeShouldBeOnScreenWithTheAppInTheBackground() throws {
        let presenter = try showAndWait(try makeAnchor())

        XCTAssertTrue(presenter.noticeWindow.isVisible,
                      "a notice nobody can see is the failure this replaces, not a fix for it")
        XCTAssertTrue(presenter.noticeWindow.styleMask.contains(.nonactivatingPanel),
                      "an ordinary window would want the app in front before it took a click")
        XCTAssertTrue(presenter.noticeWindow.canBecomeKey,
                      "the recorder in it is a control whose whole job is to be typed into")
    }

    /// Sized from its content rather than left at the zero rectangle it is
    /// built with. A window with no size is visible and holds nothing.
    func testTheNoticeShouldTakeTheSizeOfWhatItHolds() throws {
        let frame = try showAndWait(try makeAnchor()).noticeWindow.frame

        XCTAssertGreaterThan(frame.width, 200)
        XCTAssertGreaterThan(frame.height, 60)
    }

    /// Wholly on the screen, and in its upper half where the menu bar is.
    ///
    /// Deliberately an ABSOLUTE claim rather than one measured against the
    /// anchor rectangle the code itself computed. The first cut asserted the
    /// card sat below that rectangle and passed while the rectangle was the
    /// bottom left corner of the display, which is the unplaced status item
    /// described above. A test that recomputes the value under test agrees
    /// with it whatever it says.
    func testTheNoticeShouldSitWhollyOnScreenNearTheMenuBar() throws {
        let anchor = try makeAnchor()
        let screen = try XCTUnwrap(anchor.window?.screen ?? NSScreen.main)

        let frame = try showAndWait(anchor).noticeWindow.frame

        let visible = screen.visibleFrame
        XCTAssertGreaterThanOrEqual(frame.minX, visible.minX, "no part of it may run off the screen")
        XCTAssertLessThanOrEqual(frame.maxX, visible.maxX)
        XCTAssertGreaterThanOrEqual(frame.minY, visible.minY)
        XCTAssertLessThanOrEqual(frame.maxY, visible.maxY,
                                 "the card hangs below the menu bar, never over it")
        XCTAssertGreaterThan(frame.midY, visible.midY,
                             "it hangs from the menu bar, so it belongs in the top half")
    }

    /// One at a time. A second refusal replaces the first: two cards for one
    /// hotkey is two answers to a question with one.
    func testASecondNoticeShouldReplaceTheFirst() throws {
        let anchor = try makeAnchor()

        let first = try showAndWait(anchor, refused: .release)
        let second = try showAndWait(anchor, refused: .dev)

        XCTAssertFalse(first === second)
        XCTAssertFalse(first.noticeWindow.isVisible, "the one it replaced has to go")
        XCTAssertTrue(second.noticeWindow.isVisible)
    }
}
