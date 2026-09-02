import AppKit
import XCTest
@testable import BirtaWriter

/// The one message in the panel that has to survive not being read.
///
/// Everything else the app says answers something the person just did, and
/// they are looking at the window when it lands. This reports a swap that
/// happened while they were somewhere else, so the properties worth pinning
/// are the ones that make it different from the status line beside it: it
/// stays, it can be dismissed, and it claims nothing is still happening.
///
/// Read off the built view rather than off a flag. What goes wrong with a
/// notice like this is never the flag: it is a card still on screen after it
/// stopped applying, or a button that is there and cannot be hit.
@MainActor
final class UpdateNoticeTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    /// In a container and laid out, because a card with no superview cannot
    /// answer whether its own button ended up inside it.
    private func shown(_ text: String = "Birta Writer updated to v2026.902.0 in the background.",
                       width: CGFloat = 520) -> UpdateNotice {
        let notice = UpdateNotice()
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 300))
        notice.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(notice)
        NSLayoutConstraint.activate([
            notice.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -14),
            notice.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -14),
            notice.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor,
                                            constant: 14),
        ])
        notice.show(text)
        container.layoutSubtreeIfNeeded()
        return notice
    }

    /// The control for everything below: with nothing to say there is no card,
    /// and it takes no room. A notice that was merely transparent would still
    /// be a patch of window nobody could click through.
    func testWithNothingToSayThereShouldBeNoCard() {
        let notice = UpdateNotice()
        XCTAssertTrue(notice.isHidden)
        XCTAssertEqual(notice.textForMeasurement, "")
    }

    func testItShouldCarryTheSentenceItWasGiven() {
        let said = "Birta Writer updated to v2026.902.0 in the background."
        XCTAssertEqual(shown(said).textForMeasurement, said)
    }

    /// The whole reason this is not a mode of the status line. Nothing in it
    /// schedules anything, so the card is still there whenever the person next
    /// looks at the window, which may be hours after the swap.
    func testItShouldStillBeThereAfterTheRunLoopHasHadItsTurn() {
        let notice = shown()
        let settled = expectation(description: "the run loop had its turn")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { settled.fulfill() }
        wait(for: [settled], timeout: 2)
        XCTAssertFalse(notice.isHidden)
        XCTAssertFalse(notice.textForMeasurement.isEmpty)
    }

    /// No spinner and no countdown, and the two are refused for different
    /// reasons. A spinner would claim something is in flight, and nothing is:
    /// by the time this is on screen the new version is what is running. A
    /// countdown is what the status line draws to say how long a message has
    /// left, and this one has no end but the button.
    func testItShouldDrawNothingThatClaimsSomethingIsStillHappening() {
        let notice = shown()
        var seen: [NSView] = []
        func walk(_ view: NSView) {
            seen.append(view)
            view.subviews.forEach(walk)
        }
        walk(notice)
        // The arm that stops this passing on an empty walk: a card with a
        // message and a button has subviews, and a sweep that found none would
        // satisfy every assertion below having looked at nothing.
        XCTAssertGreaterThan(seen.count, 2, "the walk reached nothing to check")
        XCTAssertFalse(seen.contains { $0 is NSProgressIndicator })
        XCTAssertFalse(seen.contains { $0 is CountdownRing })
    }

    func testTheButtonShouldDismissTheCardAndSaySoOnce() {
        let notice = shown()
        var dismissals = 0
        notice.onDismiss = { dismissals += 1 }
        let button = notice.dismissButtonForMeasurement
        _ = button.target?.perform(button.action, with: button)
        XCTAssertEqual(dismissals, 1)
        XCTAssertTrue(notice.isHidden)
        XCTAssertEqual(notice.textForMeasurement, "")
    }

    /// A control with no title is announced by its image alone, which is a
    /// glyph name. The card's only control has to say what pressing it does.
    func testTheButtonShouldBeNamedForSomebodyNotLookingAtIt() {
        XCTAssertEqual(shown().dismissButtonForMeasurement.accessibilityLabel(), "Dismiss")
    }

    /// The button has to be inside the card and big enough to hit. Both have
    /// gone wrong before in this codebase's chrome: a control laid out against
    /// a frame it was built at rather than the one it ended up with lands
    /// outside its own card, and nothing about the view hierarchy says so.
    func testTheButtonShouldEndUpInsideTheCardAndBeBigEnoughToHit() {
        let notice = shown()
        let button = notice.dismissButtonForMeasurement
        XCTAssertGreaterThan(notice.bounds.width, 0)
        XCTAssertTrue(notice.bounds.contains(button.frame),
                      "\(button.frame) is not inside \(notice.bounds)")
        XCTAssertGreaterThanOrEqual(button.frame.width, 18)
        XCTAssertGreaterThanOrEqual(button.frame.height, 18)
    }

    /// A narrow panel must not squeeze the card's only control out of it. The
    /// words give way first, which is what the compression priorities say and
    /// what nothing but a real layout can confirm.
    func testOnANarrowPanelTheWordsShouldGiveWayBeforeTheButtonDoes() {
        let notice = shown(width: 260)
        let button = notice.dismissButtonForMeasurement
        XCTAssertTrue(notice.bounds.contains(button.frame),
                      "\(button.frame) is not inside \(notice.bounds)")
        XCTAssertGreaterThanOrEqual(button.frame.width, 18)
    }

    /// A second announcement replaces the first rather than joining it. There
    /// is only ever one version to be told about, and two cards would be two
    /// things to dismiss for one event.
    func testASecondMessageShouldReplaceTheFirst() {
        let notice = shown()
        notice.show("Birta Writer updated to v2026.903.0 in the background.")
        XCTAssertEqual(notice.textForMeasurement,
                       "Birta Writer updated to v2026.903.0 in the background.")
    }
}
