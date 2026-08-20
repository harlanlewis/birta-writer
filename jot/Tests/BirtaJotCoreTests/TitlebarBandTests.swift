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

    // MARK: titleTextCeiling

    /// The tie that makes this a ceiling rather than a number someone liked:
    /// take exactly it and the strip after the title is the narrowest one the
    /// app will still show, take a point more and there is no strip at all.
    ///
    /// Checked against `draggableSpan` itself, over a swept space rather than
    /// a handful of chosen cases, because the two functions are the same
    /// arithmetic read from opposite ends and the only failure worth catching
    /// is them disagreeing. A table of expected widths could not see that: it
    /// would agree with whichever of the two it was written from.
    ///
    /// Both regimes are counted and both floors asserted, because a sweep that
    /// fell entirely into one of them would pass having tested half of this.
    func testTheCeilingShouldBeTheWidestTextThatStillLeavesAStripToGrab() {
        var roomy = 0, cramped = 0
        for windowWidth in stride(from: 200.0, through: 2000.0, by: 37.0) {
            for originX in [0.0, 78.0, 166.5] {
                for chrome in [0.0, 23.0, 40.5] {
                    for controls in [0.0, 90.0, 347.5] {
                        let ceiling = TitlebarBand.titleTextCeiling(
                            windowWidth: windowWidth,
                            titleOriginX: originX,
                            titleChromeWidth: chrome,
                            trailingControlsWidth: controls)
                        let leading = originX + chrome + ceiling
                        let span = TitlebarBand.draggableSpan(
                            windowWidth: windowWidth,
                            leading: leading,
                            trailingControlsWidth: controls)
                        let over = TitlebarBand.draggableSpan(
                            windowWidth: windowWidth,
                            leading: leading + 1,
                            trailingControlsWidth: controls)
                        if ceiling > 0 {
                            roomy += 1
                            XCTAssertEqual(span?.width ?? -1, 8, accuracy: 0.001,
                                           "a title at the ceiling should leave exactly the minimum strip")
                            XCTAssertNil(over, "a title one point over the ceiling should leave no strip")
                        } else {
                            cramped += 1
                            // Nothing was clamped away that a strip could have
                            // used: the window had no room for a title AND a
                            // strip, so there is no strip either way.
                            XCTAssertNil(span, "a window with no room for a title should have none for a strip")
                        }
                    }
                }
            }
        }
        XCTAssertGreaterThan(roomy, 100, "the sweep never reached a window with room to spare")
        XCTAssertGreaterThan(cramped, 10, "the sweep never reached a window too narrow to title")
    }

    /// The property a constant cannot have, and the whole of why the old one
    /// was wrong in a wide window: more window is more room for the name.
    /// Strictly more, so a ceiling that merely stopped falling would fail too.
    func testAWiderWindowShouldRaiseTheCeiling() {
        var previous = -1.0
        for windowWidth in stride(from: 400.0, through: 2000.0, by: 100.0) {
            let ceiling = TitlebarBand.titleTextCeiling(
                windowWidth: windowWidth, titleOriginX: 78,
                titleChromeWidth: 23, trailingControlsWidth: 90)
            XCTAssertGreaterThan(ceiling, previous)
            previous = ceiling
        }
    }

    /// The other direction, and the whole of why the old constant was wrong in
    /// a narrow window: controls the page has taken are room the title has not
    /// got, whatever the window's width.
    func testControlsTakingMoreOfTheBandShouldLowerTheCeiling() {
        var previous = Double.greatestFiniteMagnitude
        for controls in stride(from: 0.0, through: 400.0, by: 25.0) {
            let ceiling = TitlebarBand.titleTextCeiling(
                windowWidth: 768, titleOriginX: 78,
                titleChromeWidth: 23, trailingControlsWidth: controls)
            XCTAssertLessThan(ceiling, previous)
            previous = ceiling
        }
    }

    /// A window with less room than the title's own furniture needs yields no
    /// text at all, never a negative width. The caller draws nothing; a
    /// negative would have it draw the name backwards from the chevron.
    func testAWindowWithNoRoomShouldYieldNoTextRatherThanANegativeWidth() {
        XCTAssertEqual(TitlebarBand.titleTextCeiling(
            windowWidth: 200, titleOriginX: 78,
            titleChromeWidth: 23, trailingControlsWidth: 150), 0)
    }

    func testNonsenseCeilingInputsShouldBeClampedRatherThanTrusted() {
        XCTAssertEqual(TitlebarBand.titleTextCeiling(
            windowWidth: 500, titleOriginX: -40,
            titleChromeWidth: -10, trailingControlsWidth: -10), 492)
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
