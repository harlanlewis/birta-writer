import XCTest
@testable import BirtaJotCore

/// When Jot asks about a new version, and what it says.
///
/// Every rule here is about somebody's attention rather than about AppKit,
/// which is why it is a type that can be checked at all. The two that matter
/// most are the ones that decide whether a person is INTERRUPTED: how long
/// between checks, and what a no means.
final class UpdatePolicyTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_787_227_200)

    func testAnAppThatHasNeverCheckedShouldCheck() {
        XCTAssertTrue(UpdatePolicy.shouldCheck(now: now, lastCheck: nil))
    }

    func testACheckShouldWaitOutTheIntervalAndThenHappen() {
        let interval = UpdatePolicy.recheckInterval
        XCTAssertFalse(UpdatePolicy.shouldCheck(now: now, lastCheck: now))
        XCTAssertFalse(UpdatePolicy.shouldCheck(now: now, lastCheck: now.addingTimeInterval(-interval + 1)))
        XCTAssertTrue(UpdatePolicy.shouldCheck(now: now, lastCheck: now.addingTimeInterval(-interval)))
        XCTAssertTrue(UpdatePolicy.shouldCheck(now: now, lastCheck: now.addingTimeInterval(-interval * 30)))
    }

    func testAClockThatWentBackwardsShouldNotStopTheAppCheckingForever() {
        // A stamp in the future is a clock that moved, not a check that has
        // not come round. Read the other way, an app whose user corrected a
        // wrong system date would stop checking until that date came back
        // around, silently, which could be months.
        XCTAssertTrue(UpdatePolicy.shouldCheck(now: now, lastCheck: now.addingTimeInterval(60)))
        XCTAssertTrue(UpdatePolicy.shouldCheck(now: now, lastCheck: now.addingTimeInterval(86_400 * 400)))
    }

    func testAVersionAlreadyDeclinedShouldNotBeRaisedAgain() {
        XCTAssertFalse(UpdatePolicy.shouldOffer(tag: "v2026.820.0", declined: "v2026.820.0"))
    }

    func testANewerVersionShouldAskEvenAfterANo() {
        // The half that keeps the rule from becoming "asked once, never
        // again": declining one release must not opt somebody out of every
        // release after it.
        XCTAssertTrue(UpdatePolicy.shouldOffer(tag: "v2026.821.0", declined: "v2026.820.0"))
        XCTAssertTrue(UpdatePolicy.shouldOffer(tag: "v2026.820.0", declined: nil))
    }

    func testTheConfirmButtonShouldNameTheSaveOnlyWhenThereIsOneToName() {
        XCTAssertEqual(UpdatePolicy.confirmTitle(hasUnwrittenBytes: true), "Save and Restart Birta Writer")
        XCTAssertEqual(UpdatePolicy.confirmTitle(hasUnwrittenBytes: false), "Restart Birta Writer")
    }

    /// The sentence must not claim the OTHER button is what protects the work.
    ///
    /// Jot writes on the way out either way, because quitting flushes, so
    /// wording that implied Cancel was the safe choice would be false in the
    /// direction that matters: somebody would decline an update to protect
    /// bytes that were never at risk.
    func testTheDetailShouldPromiseAWriteWithoutPromisingThatCancelSavesAnything() {
        let dirty = UpdatePolicy.detail(hasUnwrittenBytes: true)
        let clean = UpdatePolicy.detail(hasUnwrittenBytes: false)
        XCTAssertTrue(dirty.contains("written to disk first"))
        XCTAssertFalse(clean.contains("unsaved"))
        for text in [dirty, clean] {
            XCTAssertTrue(text.contains("replace itself"))
            XCTAssertFalse(text.lowercased().contains("lose"))
            XCTAssertFalse(text.lowercased().contains("cancel"))
        }
    }

    func testTheTitleShouldNameTheAppAndTheVersion() {
        XCTAssertEqual(UpdatePolicy.title(appName: "Birta Writer", tag: "v2026.821.0"),
                       "Birta Writer v2026.821.0 is available.")
    }

    // MARK: saying what the wait is

    /// A dead button with nothing said about it is indistinguishable from one
    /// that does not work, and the reading somebody makes is the second.
    func testTheConfirmButtonShouldCarryTheWaitStillToGo() {
        XCTAssertEqual(UpdatePolicy.confirmTitle(hasUnwrittenBytes: false, secondsRemaining: 3),
                       "Restart Birta Writer (3)")
        XCTAssertEqual(UpdatePolicy.confirmTitle(hasUnwrittenBytes: true, secondsRemaining: 1),
                       "Save and Restart Birta Writer (1)")
    }

    /// Nothing left to say once the button works, and nothing said about a
    /// wait that has already gone negative.
    func testAnArmedButtonShouldReadExactlyAsItDidBeforeThereWasACount() {
        for seconds in [0, -1] {
            XCTAssertEqual(UpdatePolicy.confirmTitle(hasUnwrittenBytes: false,
                                                     secondsRemaining: seconds),
                           UpdatePolicy.confirmTitle(hasUnwrittenBytes: false))
            XCTAssertEqual(UpdatePolicy.confirmTitle(hasUnwrittenBytes: true,
                                                     secondsRemaining: seconds),
                           UpdatePolicy.confirmTitle(hasUnwrittenBytes: true))
        }
    }

    /// The armed title is a PREFIX of every counting one, which is what makes
    /// the widest form the one the offer opens with: a button laid out for the
    /// first title it is given has room for all of them.
    func testACountingTitleShouldOnlyEverAddToTheArmedOne() {
        for hasUnwritten in [true, false] {
            let armed = UpdatePolicy.confirmTitle(hasUnwrittenBytes: hasUnwritten)
            for seconds in 1...9 {
                let counting = UpdatePolicy.confirmTitle(hasUnwrittenBytes: hasUnwritten,
                                                         secondsRemaining: seconds)
                XCTAssertTrue(counting.hasPrefix(armed), counting)
                XCTAssertGreaterThan(counting.count, armed.count)
            }
        }
    }

    func testTheCountdownShouldRunFromTheWholeDelayDownToOne() {
        XCTAssertEqual(UpdatePolicy.countdownSteps(for: 3), [3, 2, 1])
        XCTAssertEqual(UpdatePolicy.countdownSteps(for: 1), [1])
    }

    /// Rounded UP. A button reading (1) with a fraction of a second to go is a
    /// moment's wait; one reading (0) that still cannot be clicked is the
    /// broken dialog the count exists to stop somebody seeing.
    func testAFractionOfASecondShouldStillBeASecondOnTheButton() {
        XCTAssertEqual(UpdatePolicy.countdownSteps(for: 2.4), [3, 2, 1])
        XCTAssertEqual(UpdatePolicy.countdownSteps(for: 0.2), [1])
        XCTAssertFalse(UpdatePolicy.countdownSteps(for: 3).contains(0))
    }

    /// No wait, nothing to count. This is the arm every check that arms
    /// immediately goes through, so a count of [1] here would put a number on
    /// a button that was live the whole time.
    func testADelayOfNothingShouldCountNothing() {
        XCTAssertEqual(UpdatePolicy.countdownSteps(for: 0), [])
        XCTAssertEqual(UpdatePolicy.countdownSteps(for: -1), [])
    }

    /// And the count answers how long, never why. The sentence is what says
    /// whose side the wait is on, and it must not undo what the detail above
    /// it promises: no talk of losing anything, and no claim about the other
    /// button.
    func testTheArmingNoteShouldSayWhoTheWaitIsForWithoutContradictingTheDetail() {
        let note = UpdatePolicy.armingNote
        XCTAssertTrue(note.lowercased().contains("keystroke"), note)
        XCTAssertFalse(note.lowercased().contains("cancel"), note)
        XCTAssertFalse(note.lowercased().contains("lose"), note)
    }

    func testTheArmingDelayShouldBeLongEnoughToOutlastAKeystrokeAndShortEnoughToWaitOut() {
        // The number itself is a judgement, so what is pinned is the range it
        // has to be in to do its job at all: shorter than a second and a
        // keystroke in flight still lands, longer than a few and somebody who
        // came to read the sheet is being made to wait at a dead button.
        XCTAssertGreaterThanOrEqual(UpdatePolicy.armingDelay, 1)
        XCTAssertLessThanOrEqual(UpdatePolicy.armingDelay, 5)
    }
}
