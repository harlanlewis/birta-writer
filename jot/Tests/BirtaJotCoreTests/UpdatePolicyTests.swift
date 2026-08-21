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

    func testTheArmingDelayShouldBeLongEnoughToOutlastAKeystrokeAndShortEnoughToWaitOut() {
        // The number itself is a judgement, so what is pinned is the range it
        // has to be in to do its job at all: shorter than a second and a
        // keystroke in flight still lands, longer than a few and somebody who
        // came to read the sheet is being made to wait at a dead button.
        XCTAssertGreaterThanOrEqual(UpdatePolicy.armingDelay, 1)
        XCTAssertLessThanOrEqual(UpdatePolicy.armingDelay, 5)
    }
}
