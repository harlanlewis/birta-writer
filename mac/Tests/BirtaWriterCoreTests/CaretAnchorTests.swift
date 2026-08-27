import XCTest
@testable import BirtaWriterCore

final class CaretAnchorTests: XCTestCase {
    // A caret near the TOP of the view, which is the case that discriminates:
    // a y-flip applied when it should not be sends this to the bottom, and the
    // popover still appears, so only the number says which happened.
    private let nearTop = (left: 120.0, top: 100.0, bottom: 118.0)
    private let viewHeight = 800.0

    func testAFlippedViewShouldTakeThePagesCoordinatesUnchanged() {
        let rect = CaretAnchor.rect(left: nearTop.left, top: nearTop.top, bottom: nearTop.bottom,
                                    viewHeight: viewHeight, isFlipped: true)
        XCTAssertEqual(rect.origin.x, 120)
        XCTAssertEqual(rect.origin.y, 100)
        XCTAssertEqual(rect.height, 18)
    }

    func testAnUnflippedViewShouldMirrorTheCaretAboutTheViewsHeight() {
        let rect = CaretAnchor.rect(left: nearTop.left, top: nearTop.top, bottom: nearTop.bottom,
                                    viewHeight: viewHeight, isFlipped: false)
        XCTAssertEqual(rect.origin.y, 682)
    }

    /// The shipped defect, stated as a difference. Flipping a flipped view puts
    /// a caret 100pt from the top 682pt from the top instead, which is the
    /// bottom of the window, and that is the whole of what was wrong.
    func testTheTwoConventionsShouldDisagreeForACaretAwayFromTheMiddle() {
        let flipped = CaretAnchor.rect(left: nearTop.left, top: nearTop.top, bottom: nearTop.bottom,
                                       viewHeight: viewHeight, isFlipped: true)
        let unflipped = CaretAnchor.rect(left: nearTop.left, top: nearTop.top, bottom: nearTop.bottom,
                                         viewHeight: viewHeight, isFlipped: false)
        XCTAssertNotEqual(flipped.origin.y, unflipped.origin.y)
        XCTAssertEqual(unflipped.origin.y - flipped.origin.y, 582)
    }

    func testACaretReportingNoHeightShouldStillAnchorSomething() {
        let rect = CaretAnchor.rect(left: 10, top: 250, bottom: 250,
                                    viewHeight: viewHeight, isFlipped: true)
        XCTAssertEqual(rect.height, 1)
        XCTAssertEqual(rect.origin.y, 250)
    }

    func testTheAnchorShouldBeACaretWideAndNotAWordWide() {
        let rect = CaretAnchor.rect(left: 42, top: 0, bottom: 20,
                                    viewHeight: viewHeight, isFlipped: true)
        XCTAssertEqual(rect.width, 1)
        XCTAssertEqual(rect.origin.x, 42)
    }
}
