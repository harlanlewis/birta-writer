import CoreGraphics
import XCTest
@testable import BirtaWriterCore

/// The size the panel opens at with nothing remembered.
///
/// It was a constant written where the window is built, and the window is
/// built before it has a screen, so it could not have been anything else. Read
/// off the running app, that constant put several screens of first-run
/// document into a window 480 points tall on a laptop with room for far more.
final class PanelSizeTests: XCTestCase {
    /// Roughly what a 13 inch laptop leaves once the menu bar and the Dock are
    /// out. The case the report came from.
    private let laptop = CGSize(width: 1470, height: 870)

    func testALaptopShouldGetTheSizeTheAppWants() {
        let size = PanelSize.forScreen(visible: laptop)
        XCTAssertEqual(size, PanelSize.preferred,
                       "there is room for it, so nothing has to give")
    }

    /// The window is a window, not a wallpaper. Past a certain width a line of
    /// prose stops being readable, and the content column runs the full width
    /// of this one, so the extra room on a large display is not a gift.
    func testALargeDisplayShouldNotGrowThePanelPastWhatItWants() {
        let size = PanelSize.forScreen(visible: CGSize(width: 3440, height: 1400))
        XCTAssertEqual(size, PanelSize.preferred)
    }

    /// Each axis gives independently: a wide, short screen shrinks the height
    /// and leaves the width alone. Asserted as a pair, because a rule that
    /// clamped both together whenever either was tight would pass a test that
    /// only ever looked at one of them.
    func testAShortScreenShouldShrinkOnlyTheAxisThatIsShort() {
        let size = PanelSize.forScreen(visible: CGSize(width: 2000, height: 600))
        XCTAssertEqual(size.width, PanelSize.preferred.width)
        XCTAssertLessThan(size.height, PanelSize.preferred.height)
        XCTAssertLessThan(size.height, 600, "and it leaves air around itself")
    }

    /// Never past the screen, on either axis, at any of the sizes a real
    /// display comes in. A window bigger than its screen puts its own edges
    /// where nothing can reach them, which is worse than a small one.
    func testTheWindowShouldNeverBeWiderOrTallerThanTheScreen() {
        for visible in [CGSize(width: 1024, height: 640),
                        CGSize(width: 1280, height: 720),
                        CGSize(width: 1470, height: 870),
                        CGSize(width: 1710, height: 990),
                        CGSize(width: 2560, height: 1330)] {
            let size = PanelSize.forScreen(visible: visible)
            XCTAssertLessThanOrEqual(size.width, visible.width, "width on \(visible)")
            XCTAssertLessThanOrEqual(size.height, visible.height, "height on \(visible)")
        }
    }

    /// ...and never below the floor, even when the screen is smaller than it.
    /// The result is then larger than the screen, deliberately: AppKit will not
    /// honour a size under `minSize` anyway, so the choice is between a size
    /// that is refused and the one every other undersized window here gets.
    func testAScreenSmallerThanTheFloorShouldStillGiveTheFloor() {
        let size = PanelSize.forScreen(visible: CGSize(width: 200, height: 120))
        XCTAssertEqual(size, PanelSize.minimum)
    }

    /// The floor this rule stops at is the floor the window enforces. They are
    /// two properties and could be set apart, and then this rule would produce
    /// sizes AppKit silently ignores.
    func testTheFloorShouldBeTheWindowsOwnMinimum() {
        XCTAssertGreaterThan(PanelSize.minimum.width, 0)
        XCTAssertLessThan(PanelSize.minimum.width, PanelSize.preferred.width)
        XCTAssertLessThan(PanelSize.minimum.height, PanelSize.preferred.height)
    }

    // MARK: where it lands

    /// A screen is a rect rather than a size here, because the clamp is about
    /// EDGES: a second display sits at an origin that is not zero, and a rule
    /// written against a size alone is right on the main screen and wrong on
    /// every other one.
    private func screens() -> [(name: String, visible: CGRect)] {
        [("laptop", CGRect(x: 0, y: 0, width: 1470, height: 870)),
         ("small laptop", CGRect(x: 0, y: 0, width: 1280, height: 720)),
         ("tall external", CGRect(x: 0, y: 0, width: 2560, height: 1330)),
         ("second display, offset right", CGRect(x: 1470, y: 200, width: 1710, height: 990)),
         ("second display, offset left", CGRect(x: -1710, y: -400, width: 1710, height: 990))]
    }

    /// The whole window inside the screen, on every screen, on both edges of
    /// both axes.
    ///
    /// This is the arm the clamp exists for, and it is the reason the
    /// arithmetic is here rather than inside the window: the lift is a fraction
    /// of the SCREEN and the window is nearly as tall as one, so whether the
    /// unclamped point fits depends on the display. Asked of a window on a real
    /// screen, the check passes with the clamp deleted on any machine whose
    /// display is tall enough, which was true of the one it was written on.
    func testTheWholeWindowShouldLandInsideEveryScreen() {
        for (name, visible) in screens() {
            let size = PanelSize.forScreen(visible: visible.size)
            let origin = PanelSize.origin(for: size, visible: visible)
            XCTAssertGreaterThanOrEqual(origin.x, visible.minX, "\(name): left edge")
            XCTAssertGreaterThanOrEqual(origin.y, visible.minY, "\(name): bottom edge")
            XCTAssertLessThanOrEqual(origin.x + size.width, visible.maxX, "\(name): right edge")
            XCTAssertLessThanOrEqual(origin.y + size.height, visible.maxY,
                                     "\(name): top edge, which is the one the lift pushes off")
        }
    }

    /// ...and the clamp has to be doing something on at least one of them, or
    /// the arm above holds for a rule that never clamps and the whole file is
    /// decoration. The laptop is the case the window was reported on.
    func testTheLiftShouldActuallyBeClampedOnALaptop() {
        let visible = CGRect(x: 0, y: 0, width: 1470, height: 870)
        let size = PanelSize.forScreen(visible: visible.size)
        let unclamped = visible.midY - size.height / 2 + visible.height * 0.1
        XCTAssertGreaterThan(unclamped + size.height, visible.maxY,
                             "the lift does not overshoot here, so nothing below is being tested")
        XCTAssertLessThan(PanelSize.origin(for: size, visible: visible).y, unclamped)
    }

    /// Centred on the axis nothing is lifting, and lifted on the one that is.
    /// Measured on a screen with room to spare, so neither answer is the clamp.
    func testWithRoomToSpareItShouldBeCentredAndAShadeHigh() {
        let visible = CGRect(x: 0, y: 0, width: 2560, height: 1330)
        let size = PanelSize.forScreen(visible: visible.size)
        let origin = PanelSize.origin(for: size, visible: visible)
        XCTAssertEqual(origin.x, visible.midX - size.width / 2, accuracy: 0.5)
        XCTAssertGreaterThan(origin.y, visible.midY - size.height / 2,
                             "above centre, not on it")
    }

    /// A window bigger than its screen goes to the screen's own origin rather
    /// than to a negative one. Something has to overhang at that size, and the
    /// near corner is where the window buttons are.
    func testAWindowLargerThanItsScreenShouldStartAtTheScreensCorner() {
        let visible = CGRect(x: 100, y: 50, width: 200, height: 120)
        let size = PanelSize.forScreen(visible: visible.size)
        XCTAssertEqual(size, PanelSize.minimum, "the size rule gives the floor here")
        XCTAssertEqual(PanelSize.origin(for: size, visible: visible), CGPoint(x: 100, y: 50))
    }
}
