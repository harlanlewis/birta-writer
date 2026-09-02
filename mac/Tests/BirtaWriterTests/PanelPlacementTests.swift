import AppKit
import BirtaWriterCore
import XCTest
@testable import BirtaWriter

/// Where the panel lands the first time, and how big it is.
///
/// `PanelSizeTests` covers the size RULE with no window; this covers the window
/// applying it, which is a different claim and the one that broke. Growing the
/// opening height put the title bar off the top of the screen on a laptop,
/// because the placement lifts the window by a fraction of the SCREEN and the
/// window is now nearly as tall as one. Every titlebar control goes with it,
/// the close button included, and nothing on screen says where they went.
///
/// Nothing is shown. `placeIfUnplaced` is the whole of the first placement and
/// it needs no order-front, which is what lets the geometry be read back before
/// anything is on screen.
@MainActor
final class PanelPlacementTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    /// `remembersFrame: false` throughout, for the reason `PanelCloseTests`
    /// gives: a panel that names itself writes the frame autosave into the
    /// app's standard defaults whatever the throwaway suite says, and hands
    /// the person running the suite a window the size of whatever a test
    /// finished on.
    private func placed() -> AppPanel {
        let panel = AppPanel(remembersFrame: false)
        panel.placeIfUnplaced()
        return panel
    }

    /// The screen the placement will have chosen: the one under the pointer.
    /// Derived the same way rather than assumed to be `NSScreen.main`, because
    /// on a machine with two displays those are regularly not the same screen
    /// and the assertions below would then be measured against the wrong one.
    private var targetScreen: NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main
    }

    func testTheWindowShouldOpenAtTheSizeTheRuleGivesForItsScreen() throws {
        let screen = try XCTUnwrap(targetScreen)
        let panel = placed()
        let wanted = PanelSize.forScreen(visible: screen.visibleFrame.size)
        let got = panel.contentRect(forFrameRect: panel.frame).size
        XCTAssertEqual(got.width, wanted.width, accuracy: 1)
        XCTAssertEqual(got.height, wanted.height, accuracy: 1)
        // The instrument, before the verdict above is read as meaning
        // anything: a rule that answered the old 640 by 480 for every screen
        // would satisfy the equality and none of the point of it.
        XCTAssertGreaterThan(got.width, 640, "the opening size is not the historic one")
    }

    /// The window is placed by the RULE, whatever the rule says.
    ///
    /// This is what an app-level check can honestly claim here, and the
    /// distinction was learned the hard way. Asserting instead that the window
    /// lands inside the screen reads like the stronger claim and is the weaker
    /// one: whether the unclamped point overshoots depends on how tall the
    /// display running the suite is, so on a tall one that assertion passes
    /// with the clamp deleted, which is exactly what it did. The rule's own
    /// correctness is `PanelSizeTests`, over the screens it has to be right on;
    /// this is the wiring, which is the half that file cannot see.
    func testTheWindowShouldBePlacedByTheRuleRatherThanByArithmeticOfItsOwn() throws {
        let screen = try XCTUnwrap(targetScreen)
        let visible = screen.visibleFrame
        let frame = placed().frame
        let wanted = PanelSize.origin(for: frame.size, visible: visible)
        XCTAssertEqual(frame.origin.x, wanted.x, accuracy: 1)
        XCTAssertEqual(frame.origin.y, wanted.y, accuracy: 1)
    }

    /// The floor the size rule stops at is the floor the window enforces. Two
    /// properties in two files, and a rule that stopped above or below the
    /// window's own minimum would produce sizes AppKit quietly ignores.
    func testThePanelsMinimumShouldBeTheRulesFloor() {
        XCTAssertEqual(AppPanel(remembersFrame: false).minSize, PanelSize.minimum)
    }

    /// A second placement is not a placement. `placeIfUnplaced` runs from every
    /// show and a summon now shows every window at once, so a window somebody
    /// dragged somewhere must not be re-centred and re-sized under them.
    func testAWindowThatHasBeenPlacedShouldNotBeMovedAgain() {
        let panel = placed()
        let moved = NSRect(x: panel.frame.minX + 40, y: panel.frame.minY + 40,
                           width: 500, height: 400)
        panel.setFrame(moved, display: false)
        panel.placeIfUnplaced()
        XCTAssertEqual(panel.frame, moved)
    }
}
