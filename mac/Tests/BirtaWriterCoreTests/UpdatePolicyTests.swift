import XCTest
@testable import BirtaWriterCore

/// When the app asks about a new version, and what it says.
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
    /// The app writes on the way out either way, because quitting flushes, so
    /// wording that implied Cancel was the safe choice would be false in the
    /// direction that matters: somebody would decline an update to protect
    /// bytes that were never at risk.
    func testTheDetailShouldPromiseAWriteWithoutPromisingThatCancelSavesAnything() {
        let dirty = UpdatePolicy.detail(hasUnwrittenBytes: true, staged: false)
        let clean = UpdatePolicy.detail(hasUnwrittenBytes: false, staged: false)
        XCTAssertTrue(dirty.contains("written to disk first"))
        XCTAssertFalse(clean.contains("unsaved"))
        // Every arm of both axes, so a wording change to one of the four
        // cannot quietly reintroduce the claim these rule out.
        for unwritten in [true, false] {
            for staged in [true, false] {
                let text = UpdatePolicy.detail(hasUnwrittenBytes: unwritten, staged: staged)
                XCTAssertFalse(text.lowercased().contains("lose"), text)
                XCTAssertFalse(text.lowercased().contains("cancel"), text)
            }
        }
    }

    /// The sheet must not say a download is coming when the bytes are already
    /// on the disk, and must not imply they are here when they are not.
    ///
    /// Both halves matter and they fail in opposite directions. Claiming a
    /// download that already happened makes a restart look slower than it is,
    /// which is what somebody weighs the button against. Claiming the update
    /// is ready when it is still arriving makes a restart look instant, and
    /// then the app sits there.
    func testTheDetailShouldSayWhetherTheBytesHaveAlreadyArrived() {
        let coming = UpdatePolicy.detail(hasUnwrittenBytes: false, staged: false)
        let here = UpdatePolicy.detail(hasUnwrittenBytes: false, staged: true)
        XCTAssertNotEqual(coming, here)
        XCTAssertTrue(coming.contains("will download"), coming)
        XCTAssertTrue(here.contains("already downloaded"), here)
        XCTAssertFalse(here.contains("will download"), here)
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

    // MARK: whether anybody is there

    /// The shape every arm below is checked against: nobody at the window.
    private var away: UpdatePolicy.Attendance {
        UpdatePolicy.Attendance(anyWindowVisible: false,
                                hasUnwrittenBytes: false,
                                idle: UpdatePolicy.unattendedIdle)
    }

    /// The control. Without it every arm below could be passing because the
    /// predicate refuses everything, which is a predicate that discriminates
    /// nothing and would still satisfy each of them.
    func testAnEmptyMachineAtTheIdleFloorShouldBeUnattended() {
        XCTAssertTrue(UpdatePolicy.isUnattended(away))
    }

    func testAWindowOnScreenShouldStopTheSwapHoweverIdleTheMachineLooks() {
        // A person reading is a person who did not touch the keyboard, so idle
        // time alone says nothing about whether the app is being used.
        var reading = away
        reading.anyWindowVisible = true
        reading.idle = UpdatePolicy.unattendedIdle * 100
        XCTAssertFalse(UpdatePolicy.isUnattended(reading))
    }

    func testUnwrittenBytesShouldStopTheSwap() {
        // Quitting flushes, so this is not about losing the words. It is a
        // sentence somebody was in the middle of, and the app disappearing and
        // coming back around it is the interruption, not the risk.
        var midSentence = away
        midSentence.hasUnwrittenBytes = true
        XCTAssertFalse(UpdatePolicy.isUnattended(midSentence))
    }

    func testAPauseShouldNotCountAsHavingLeft() {
        var paused = away
        paused.idle = UpdatePolicy.unattendedIdle - 1
        XCTAssertFalse(UpdatePolicy.isUnattended(paused))
        paused.idle = 0
        XCTAssertFalse(UpdatePolicy.isUnattended(paused))
    }

    /// A clock that moved backwards produces a negative idle time, and the
    /// bias on this whole path is that anything unreadable refuses. A refusal
    /// costs a day; a wrong go ahead costs somebody the app they were using.
    func testAnImpossibleIdleTimeShouldRefuseRatherThanCountAsForever() {
        var wrong = away
        wrong.idle = -1
        XCTAssertFalse(UpdatePolicy.isUnattended(wrong))
    }

    // MARK: saying what happened

    func testTheNoticeShouldNameTheVersionAndSayNobodyWasAsked() {
        let said = UpdatePolicy.installedNotice(appName: "Birta Writer", tag: "v2026.902.0")
        XCTAssertEqual(said, "Birta Writer updated to v2026.902.0 in the background.")
    }

    /// Past tense, because by the time it is read the swap is done and the app
    /// in front of the reader is the new one. A sentence promising something
    /// still to come would send them looking for a restart to perform.
    func testTheNoticeShouldNotSoundLikeSomethingIsStillToHappen() {
        let said = UpdatePolicy.installedNotice(appName: "Birta Writer", tag: "v2026.902.0")
        for pending in ["will ", "restart", "downloading", "installing", "…"] {
            XCTAssertFalse(said.lowercased().contains(pending), said)
        }
    }

    // MARK: whether the swap may go in at all

    /// The one state in which the app replaces itself with nobody asked.
    private var clear: UpdatePolicy.UnattendedInstall {
        UpdatePolicy.UnattendedInstall(isStaged: true,
                                       autoUpdate: true,
                                       wasDeclined: false,
                                       offerOnScreen: false,
                                       workInFlight: false,
                                       attendance: away)
    }

    /// The control, and the thing every arm below is measured against: this
    /// predicate does say yes to something.
    func testTheOneClearStateShouldBeAllowed() {
        XCTAssertTrue(UpdatePolicy.mayInstallUnattended(clear))
    }

    /// Every field, flipped on its own, must refuse.
    ///
    /// Written as a sweep rather than as five separate tests because what it
    /// is really checking is that no field STOPPED being consulted. A clause
    /// dropped from the predicate is invisible to a green run, and asking each
    /// field in turn against a state that otherwise says go ahead is the only
    /// thing that finds one. The count is asserted for the same reason: a
    /// sweep that reached nothing would pass having checked none of them.
    func testFlippingAnySingleFactShouldRefuse() {
        let flips: [(String, (inout UpdatePolicy.UnattendedInstall) -> Void)] = [
            ("nothing staged", { $0.isStaged = false }),
            ("the setting off", { $0.autoUpdate = false }),
            ("the version declined", { $0.wasDeclined = true }),
            ("the offer on screen", { $0.offerOnScreen = true }),
            ("work in flight", { $0.workInFlight = true }),
            ("a window up", { $0.attendance.anyWindowVisible = true }),
            ("unwritten bytes", { $0.attendance.hasUnwrittenBytes = true }),
            ("somebody just typed", { $0.attendance.idle = 0 }),
        ]
        // Counted off the TYPES rather than restated as a number, so a fact
        // added to either struct fails here until the sweep flips it. A
        // hand-written number beside a hand-written list agrees with itself
        // whatever the predicate does. `attendance` is subtracted because it
        // is the other struct rather than a fact of its own.
        let facts = Mirror(reflecting: clear).children.count
            + Mirror(reflecting: clear.attendance).children.count - 1
        XCTAssertEqual(flips.count, facts, "a fact was added and the sweep does not flip it")
        for (name, flip) in flips {
            var state = clear
            flip(&state)
            XCTAssertFalse(UpdatePolicy.mayInstallUnattended(state),
                           "the swap went in with \(name)")
        }
    }
}
