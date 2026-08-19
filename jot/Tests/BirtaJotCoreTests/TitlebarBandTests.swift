import XCTest
@testable import BirtaJotCore

final class TitlebarBandTests: XCTestCase {
    // MARK: draggableSpan

    func testAWideWindowShouldLeaveTheMiddleOfTheBandDraggable() {
        let span = TitlebarBand.draggableSpan(
            windowWidth: 856, leading: 166.5, trailingControlsWidth: 114)
        XCTAssertEqual(span?.x, 166.5)
        XCTAssertEqual(span?.width, 575.5)
    }

    /// The strip starts where the window's own furniture ends and stops where
    /// the page's begins, so neither side is covered. Asserted as the two
    /// edges rather than as a width, because a width alone is satisfied by a
    /// strip of the right size in the wrong place.
    func testTheSpanShouldTouchNeitherTheTitleNorTheControls() {
        let span = TitlebarBand.draggableSpan(
            windowWidth: 1000, leading: 200, trailingControlsWidth: 150)
        XCTAssertEqual(span?.x, 200)
        XCTAssertEqual((span?.x ?? 0) + (span?.width ?? 0), 850)
    }

    /// A window narrow enough that the two sides meet has no middle. Nil
    /// rather than a zero-width strip: a strip of no width is a drag target
    /// that reports success and cannot be hit, which is the failure this whole
    /// mechanism exists to avoid.
    func testAWindowWithNoRoomLeftShouldYieldNoSpanAtAll() {
        XCTAssertNil(TitlebarBand.draggableSpan(
            windowWidth: 300, leading: 200, trailingControlsWidth: 150))
    }

    func testASpanThinnerThanTheMinimumShouldBeRefusedRatherThanShrunk() {
        XCTAssertNil(TitlebarBand.draggableSpan(
            windowWidth: 300, leading: 200, trailingControlsWidth: 95, minimumWidth: 8))
        XCTAssertNotNil(TitlebarBand.draggableSpan(
            windowWidth: 300, leading: 200, trailingControlsWidth: 92, minimumWidth: 8))
    }

    /// Negative inputs are not a case the caller should have to filter. A
    /// leading edge below zero would otherwise start the strip off the window.
    func testNonsenseInputsShouldBeClampedRatherThanTrusted() {
        let span = TitlebarBand.draggableSpan(
            windowWidth: 500, leading: -40, trailingControlsWidth: -10)
        XCTAssertEqual(span?.x, 0)
        XCTAssertEqual(span?.width, 500)
    }

    // MARK: double click

    /// The system default when nobody has set the key, which is the state
    /// almost every machine is in. Getting this wrong makes the gesture do
    /// nothing on a fresh install and look unimplemented.
    func testAnUnsetSettingShouldZoomTheWayMacOSDoes() {
        XCTAssertEqual(TitlebarDoubleClick.action(for: nil), .zoom)
    }

    func testTheTwoNamedActionsShouldBeHonoured() {
        XCTAssertEqual(TitlebarDoubleClick.action(for: "Maximize"), .zoom)
        XCTAssertEqual(TitlebarDoubleClick.action(for: "Minimize"), .minimize)
    }

    /// A value this app does not know is a value macOS may have added, so the
    /// answer is to do nothing rather than to guess at it.
    func testAnUnknownSettingShouldDoNothingRatherThanGuess() {
        XCTAssertEqual(TitlebarDoubleClick.action(for: "Fullscreen"), .none)
        XCTAssertEqual(TitlebarDoubleClick.action(for: ""), .none)
    }
}
