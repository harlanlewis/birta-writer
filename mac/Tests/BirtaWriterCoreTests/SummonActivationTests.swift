import XCTest
@testable import BirtaWriterCore

/// Which Space change belongs to a summon.
///
/// The defect this decides for is a window-server race no test can stage: the
/// hotkey pressed from inside another application's full screen switches Space,
/// and the tail of that switch undoes the activation the summon issued, so the
/// window is drawn for a moment and somebody else's application ends up in
/// front. The answer is to issue the activation again when the switch lands,
/// and the only part of that which is decidable is the question below.
///
/// Both directions are asserted throughout, because a rule that answered every
/// Space change would pass a suite testing only the case it must answer, and
/// dragging a reader back to a window they did not ask for is the worse of the
/// two failures: the one this fixes costs a keystroke, and that one takes the
/// screen away from whatever they moved to.
final class SummonActivationTests: XCTestCase {
    func testAChangeInsideTheIntervalShouldBeTheSummonsToAnswer() {
        var activation = SummonActivation()
        activation.summoned(at: 100)
        XCTAssertTrue(activation.spaceChanged(at: 100.2))
    }

    func testAChangePastTheIntervalShouldBeTheReadersOwn() {
        var activation = SummonActivation()
        activation.summoned(at: 100)
        XCTAssertFalse(
            activation.spaceChanged(at: 100 + SummonActivation.settleInterval + 0.1))
    }

    /// The boundary itself, so the interval has a real edge rather than one the
    /// assertions above straddle without ever touching.
    func testAChangeAtTheEdgeOfTheIntervalShouldBeTheReadersOwn() {
        var activation = SummonActivation()
        activation.summoned(at: 100)
        XCTAssertFalse(activation.spaceChanged(at: 100 + SummonActivation.settleInterval))
    }

    func testAChangeWithNoSummonShouldBeAnsweredByNothing() {
        var activation = SummonActivation()
        XCTAssertFalse(activation.isArmed)
        XCTAssertFalse(activation.spaceChanged(at: 100))
    }

    /// A summon switches Space once. The second change is the reader moving
    /// themselves, and it arrives inside the same window, so only the arm being
    /// spent tells the two apart.
    func testTheSecondChangeAfterOneSummonShouldBeTheReadersOwn() {
        var activation = SummonActivation()
        activation.summoned(at: 100)
        XCTAssertTrue(activation.spaceChanged(at: 100.2))
        XCTAssertFalse(activation.isArmed)
        XCTAssertFalse(activation.spaceChanged(at: 100.4))
    }

    /// Dismissal is the reader saying they are done, and it can arrive before
    /// the switch has landed.
    func testAChangeAfterADismissalShouldBeAnsweredByNothing() {
        var activation = SummonActivation()
        activation.summoned(at: 100)
        activation.disarm()
        XCTAssertFalse(activation.spaceChanged(at: 100.2))
    }

    /// A summon that caused no switch at all leaves the arm standing, and the
    /// reader's own next Space change is the first thing to reach it. That
    /// change is refused, and it must also clear the arm rather than leave it
    /// for whatever comes next to read again.
    func testAnExpiredArmShouldBeClearedByTheChangeThatRefusesIt() {
        var activation = SummonActivation()
        activation.summoned(at: 100)
        XCTAssertFalse(activation.spaceChanged(at: 200))
        XCTAssertFalse(activation.isArmed)
    }

    /// A second summon re-arms from its own moment rather than inheriting the
    /// first one's, which is what makes a hotkey pressed twice behave like a
    /// hotkey pressed once.
    func testASecondSummonShouldStartTheIntervalAgain() {
        var activation = SummonActivation()
        activation.summoned(at: 100)
        activation.summoned(at: 200)
        // Inside the first summon's window and nowhere near the second's, so a
        // second summon that failed to move the arm would answer this.
        XCTAssertFalse(activation.spaceChanged(at: 101))
    }
}
