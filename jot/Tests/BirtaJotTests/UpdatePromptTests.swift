import AppKit
import BirtaJotCore
import XCTest
@testable import BirtaJot

/// The update offer as a built alert: what it says, and what its wait does.
///
/// Built rather than presented, so nothing appears on screen and both states
/// of the wait are reachable. What is worth checking here is the pair the
/// buttons are in: they have to be DEAD when the offer arrives, because it can
/// land mid-sentence and a keystroke already in flight would answer it, and
/// they have to say so, because a control that is not ready and one that does
/// not work look the same from outside.
@MainActor
final class UpdatePromptTests: XCTestCase {
    override func setUp() { super.setUp(); _ = NSApplication.shared }

    private func offer(hasUnwrittenBytes: Bool = false) -> UpdatePrompt.Offer {
        UpdatePrompt.build(tag: "v2026.826.0", hasUnwrittenBytes: hasUnwrittenBytes)
    }

    func testAFreshOfferShouldHaveNeitherButtonLiveAndNeitherKeyBound() {
        let built = offer()

        for button in built.alert.buttons {
            XCTAssertFalse(button.isEnabled, button.title)
            // A Return still bound to a disabled button is a key that does
            // nothing rather than a key that is not yet a key, and an Escape
            // left live would spend the single offer this version gets.
            XCTAssertEqual(button.keyEquivalent, "", button.title)
        }
        XCTAssertEqual(built.alert.buttons.count, 2)
    }

    func testTheOfferShouldOpenWithTheWholeWaitOnTheConfirmingButton() {
        let built = offer()
        built.armAfter(UpdatePolicy.armingDelay)

        let expected = UpdatePolicy.confirmTitle(
            hasUnwrittenBytes: false,
            secondsRemaining: UpdatePolicy.countdownSteps(for: UpdatePolicy.armingDelay).first ?? 0)
        XCTAssertEqual(built.alert.buttons.first?.title, expected)
        XCTAssertTrue(expected.contains("(3)"), expected)
        // On the confirming button and nowhere else: a count beside the pair
        // is one somebody has to go looking for.
        XCTAssertEqual(built.alert.buttons.last?.title, "Cancel")
    }

    func testTheCountShouldReachTheButtonAndComeOffWhenItArms() throws {
        let built = offer(hasUnwrittenBytes: true)
        let confirm = try XCTUnwrap(built.alert.buttons.first)

        built.count(2)
        XCTAssertEqual(confirm.title, "Save and Restart Birta Writer (2)")

        built.arm()
        XCTAssertEqual(confirm.title, "Save and Restart Birta Writer",
                       "the count outlived the wait it was counting")
    }

    func testArmingShouldGiveBackBothButtonsAndTheKeysTheyCameWith() throws {
        // What the keys ARE is AppKit's, so they are taken from a plain alert
        // rather than written down here; what this pins is that the offer
        // hands back exactly what it took.
        let plain = NSAlert()
        plain.addButton(withTitle: UpdatePolicy.confirmTitle(hasUnwrittenBytes: false))
        plain.addButton(withTitle: "Cancel")
        let expected = plain.buttons.map(\.keyEquivalent)
        XCTAssertNotEqual(expected, ["", ""], "the keys this checks the return of do not exist")

        let built = offer()
        built.arm()

        XCTAssertEqual(built.alert.buttons.map(\.keyEquivalent), expected)
        for button in built.alert.buttons { XCTAssertTrue(button.isEnabled, button.title) }
    }

    /// The wait really ends. Driven through the scheduling rather than by
    /// calling `arm` by hand, because what could break is the schedule.
    func testTheButtonsShouldComeLiveOnceTheWaitIsOver() {
        let built = offer()
        built.armAfter(0.2)
        XCTAssertFalse(built.alert.buttons[0].isEnabled, "the offer arrived already armed")

        let armed = expectation(description: "the buttons come live")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { armed.fulfill() }
        wait(for: [armed], timeout: 5)

        for button in built.alert.buttons { XCTAssertTrue(button.isEnabled, button.title) }
        XCTAssertEqual(built.alert.buttons.first?.title,
                       UpdatePolicy.confirmTitle(hasUnwrittenBytes: false))
    }

    /// The countdown has to hold the offer up on its own.
    ///
    /// `NSAlert` does not retain the thing that built it, and the call that
    /// presents the sheet returns immediately, so an offer held only by that
    /// call is gone before its first tick. What that leaves is not a missing
    /// count: it is a sheet whose buttons never come live at all, and the only
    /// way out of it is Escape, which is also dead.
    ///
    /// Made inside a function that returns only the alert, which is the shape
    /// `present` has.
    func testTheCountdownShouldKeepTheOfferAliveAfterTheCallThatMadeItReturns() {
        func startAndWalkAway() -> NSAlert {
            let built = offer()
            built.armAfter(0.2)
            return built.alert
        }
        let alert = startAndWalkAway()
        XCTAssertFalse(alert.buttons[0].isEnabled, "the offer arrived already armed")

        let armed = expectation(description: "the buttons come live")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { armed.fulfill() }
        wait(for: [armed], timeout: 5)

        for button in alert.buttons {
            XCTAssertTrue(button.isEnabled, "\(button.title) is dead for good")
        }
        XCTAssertEqual(alert.buttons.first?.title,
                       UpdatePolicy.confirmTitle(hasUnwrittenBytes: false))
    }

    /// A delay of nothing arms at once and puts no number on a button that was
    /// live the whole time.
    func testNoWaitShouldMeanNoCountAndNoDeadButton() {
        let built = offer()
        built.armAfter(0)

        XCTAssertEqual(built.alert.buttons.first?.title,
                       UpdatePolicy.confirmTitle(hasUnwrittenBytes: false))
        for button in built.alert.buttons { XCTAssertTrue(button.isEnabled, button.title) }
    }

    /// And the offer says why there is a wait at all, under what it says the
    /// update will do.
    func testTheOfferShouldSayWhyTheButtonsAreHeld() {
        let built = offer(hasUnwrittenBytes: true)

        let said = built.alert.informativeText
        XCTAssertTrue(said.contains(UpdatePolicy.detail(hasUnwrittenBytes: true)), said)
        XCTAssertTrue(said.contains(UpdatePolicy.armingNote), said)
        XCTAssertTrue(said.hasSuffix(UpdatePolicy.armingNote),
                      "the reason for the wait comes after what the update does")
    }

    func testTheOfferShouldNameTheAppAndTheVersionItIsAbout() {
        XCTAssertEqual(offer().alert.messageText,
                       UpdatePolicy.title(appName: AppFlavor.current.displayName,
                                          tag: "v2026.826.0"))
    }
}
