import AppKit
import XCTest
@testable import BirtaJot

/// The ring beside a status message, which is the only thing telling a reader
/// how long they have before the message goes.
///
/// Two of these are about a claim the drawing makes. A ring whose animation is
/// a different length from the message's dwell is worse than no ring: it says
/// there is time left when there is not, or empties and then sits there. And a
/// ring that is not square is not a circle, whatever the path says.
@MainActor
final class StatusOverlayCountdownTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    /// Laid out at the size the panel gives it, so the constraints have
    /// actually resolved before anything is read back.
    private func laidOutOverlay() -> StatusOverlay {
        let overlay = StatusOverlay()
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 200))
        overlay.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(overlay)
        NSLayoutConstraint.activate([
            overlay.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            overlay.bottomAnchor.constraint(equalTo: host.bottomAnchor),
            overlay.heightAnchor.constraint(equalToConstant: StatusOverlay.height),
            overlay.leadingAnchor.constraint(greaterThanOrEqualTo: host.leadingAnchor),
        ])
        overlay.flash("Saved.")
        host.layoutSubtreeIfNeeded()
        return overlay
    }

    private func ring(in view: NSView) -> CountdownRing? {
        if let found = view as? CountdownRing { return found }
        for subview in view.subviews {
            if let found = ring(in: subview) { return found }
        }
        return nil
    }

    func testAMessageShouldBeShownBesideACountdown() throws {
        let overlay = laidOutOverlay()

        let ring = try XCTUnwrap(self.ring(in: overlay), "the overlay draws no countdown")

        XCTAssertGreaterThan(ring.bounds.width, 0, "the ring resolved to nothing")
        XCTAssertEqual(ring.bounds.width, ring.bounds.height, accuracy: 0.5,
                       "a countdown ring has to be square to be a circle")
    }

    /// The height of one line of the message, which is what "beside the text"
    /// means. Read off the label rather than compared against a constant, so
    /// this stays true if the font changes.
    func testTheRingShouldBeAsTallAsTheLineItSitsBeside() throws {
        let overlay = laidOutOverlay()
        let ring = try XCTUnwrap(self.ring(in: overlay))
        let label = try XCTUnwrap(overlay.subviews.compactMap { $0 as? NSTextField }.first)

        XCTAssertEqual(ring.bounds.height, label.bounds.height, accuracy: 0.5)
        XCTAssertGreaterThan(label.bounds.height, 0)
    }

    /// The ring is a drawing of the dwell, so the two cannot be separate
    /// numbers. Read off the live animation rather than off the constant it
    /// was passed, which is the difference between checking the value and
    /// checking that the value reached CoreAnimation.
    func testTheDepletionShouldRunForExactlyAsLongAsTheMessageStays() throws {
        let overlay = laidOutOverlay()
        let ring = try XCTUnwrap(self.ring(in: overlay))

        let arc = try XCTUnwrap(ring.layer?.sublayers?.compactMap { $0 as? CAShapeLayer }.last)
        let animation = try XCTUnwrap(arc.animation(forKey: CountdownRing.animationKey),
                                      "flashing a message started no countdown")
        XCTAssertEqual(animation.duration, StatusOverlay.dwell, accuracy: 0.001)
        // Linear, or the ring is lying about how much time is left.
        XCTAssertEqual((animation as? CABasicAnimation)?.timingFunction,
                       CAMediaTimingFunction(name: .linear))
    }

    /// The model value is the END state. Left at full, the ring snaps back to
    /// a complete circle for the frame after it empties.
    func testTheRingShouldRestAtEmptyRatherThanFull() throws {
        let overlay = laidOutOverlay()
        let ring = try XCTUnwrap(self.ring(in: overlay))
        let arc = try XCTUnwrap(ring.layer?.sublayers?.compactMap { $0 as? CAShapeLayer }.last)

        XCTAssertEqual(arc.strokeEnd, 0, accuracy: 0.001)
    }

    /// A second message replaces the first's countdown rather than layering a
    /// second one over it, which would run the ring at two speeds at once.
    func testASecondMessageShouldRestartTheCountdownRatherThanStackOne() throws {
        let overlay = laidOutOverlay()
        let ring = try XCTUnwrap(self.ring(in: overlay))
        let arc = try XCTUnwrap(ring.layer?.sublayers?.compactMap { $0 as? CAShapeLayer }.last)

        overlay.flash("New note.")

        XCTAssertEqual(arc.animationKeys()?.filter { $0 == CountdownRing.animationKey }.count, 1)
    }

    /// Nothing in the corner takes a click, ring included: six seconds of dead
    /// window after every save is the failure this rules out.
    func testTheCountdownShouldNotTakeThePointer() throws {
        let overlay = laidOutOverlay()
        let ring = try XCTUnwrap(self.ring(in: overlay))

        XCTAssertNil(ring.hitTest(NSPoint(x: ring.bounds.midX, y: ring.bounds.midY)))
        XCTAssertNil(overlay.hitTest(NSPoint(x: overlay.bounds.midX, y: overlay.bounds.midY)))
    }
}
