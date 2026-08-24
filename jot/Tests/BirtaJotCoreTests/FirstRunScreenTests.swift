import XCTest
@testable import BirtaJotCore

final class FirstRunScreenTests: XCTestCase {

    /// Every combination, so a fifth arm cannot be added without this matrix
    /// having something to say about it, and the count is asserted because a
    /// sweep that enumerated nothing passes every assertion inside it.
    func testTheWholeSpaceShouldBeCoveredAndOnlyAFirstOrdinaryLaunchShouldShowIt() {
        var shown = 0
        var refused = 0
        for forced in [true, false] {
            for isUserStore in [true, false] {
                for hasSeenWelcome in [true, false] {
                    for launchedWithDocument in [true, false] {
                        let show = FirstRunScreen.shouldShow(forced: forced,
                                                             isUserStore: isUserStore,
                                                             hasSeenWelcome: hasSeenWelcome,
                                                             documentBound: launchedWithDocument)
                        // The invariant, stated once and checked over
                        // everything: forced overrides, and otherwise all three
                        // have to permit it.
                        let permitted = forced
                            || (isUserStore && !hasSeenWelcome && !launchedWithDocument)
                        XCTAssertEqual(show, permitted,
                                       "forced=\(forced) user store=\(isUserStore) seen=\(hasSeenWelcome) document=\(launchedWithDocument)")
                        if show { shown += 1 } else { refused += 1 }
                    }
                }
            }
        }
        XCTAssertEqual(shown + refused, 16)
        XCTAssertGreaterThan(shown, 0)
        XCTAssertGreaterThan(refused, 0)
    }

    /// Each refusal on its own, so a rule that stopped being consulted is
    /// visible as a named failure rather than as one row of the matrix.
    func testAnyOneRefusalShouldBeEnoughOnItsOwn() {
        XCTAssertTrue(FirstRunScreen.shouldShow(forced: false, isUserStore: true,
                                                hasSeenWelcome: false, documentBound: false))

        XCTAssertFalse(FirstRunScreen.shouldShow(forced: false, isUserStore: false,
                                                 hasSeenWelcome: false, documentBound: false),
                       "a throwaway defaults domain would meet a first launch every run")
        XCTAssertFalse(FirstRunScreen.shouldShow(forced: false, isUserStore: true,
                                                 hasSeenWelcome: true, documentBound: false),
                       "the tour is offered once")
        XCTAssertFalse(FirstRunScreen.shouldShow(forced: false, isUserStore: true,
                                                 hasSeenWelcome: false, documentBound: true),
                       "the screen is not put in front of somebody's own file")
    }

    /// The refusal has to leave the offer intact, or it is not a deferral, it
    /// is a first run somebody was skipped past. `hasSeenWelcome` is what the
    /// screen's own Continue sets, so a launch back on the app's own notes
    /// answers this the other way with nothing reset in between.
    func testDecliningForADocumentShouldLeaveTheTourOfferedOnceTheDocumentIsLeft() {
        let bound = FirstRunScreen.shouldShow(forced: false, isUserStore: true,
                                              hasSeenWelcome: false, documentBound: true)
        let left = FirstRunScreen.shouldShow(forced: false, isUserStore: true,
                                             hasSeenWelcome: false, documentBound: false)
        XCTAssertFalse(bound)
        XCTAssertTrue(left)
    }

    /// The refusal asks about the BINDING, so it survives the launch that made
    /// it. This is the whole reason it is not asked of `launchedWith`, and it
    /// is not covered by the matrix passing: a gate on the launch answers this
    /// case exactly the same way once and the wrong way every time after.
    ///
    /// What a launch-shaped gate costs is the tour itself, not just its timing.
    /// `Coordinator.finishWelcome` spends `hasSeenWelcome` before it seeds, and
    /// `FirstRunNote.shouldWrite` refuses the `document` slot, so a screen shown
    /// over a still-bound document spends the one chance to offer the tour on a
    /// note it is not allowed to write. `AppFlavor.showsWelcomeScreen` keeps
    /// Show Welcome out of a release build, so nothing gives it back.
    func testARelaunchWithTheDocumentStillBoundShouldStillRefuse() {
        // Same stored state, a launch later: nothing about the second launch
        // came from the Finder, and the panel is still on their file.
        XCTAssertFalse(FirstRunScreen.shouldShow(forced: false, isUserStore: true,
                                                 hasSeenWelcome: false, documentBound: true))
    }

    /// `BIRTA_JOT_OPEN_WELCOME=1` outranks every refusal, this one included.
    /// It is the only way anything but a person builds the screen, because the
    /// ordinary gate deliberately never fires under a throwaway domain, so a
    /// refusal it did not outrank would take the screen out of reach of the
    /// only run that checks it constructs.
    func testForcingItShouldOutrankEveryRefusal() {
        XCTAssertTrue(FirstRunScreen.shouldShow(forced: true, isUserStore: false,
                                                hasSeenWelcome: true, documentBound: true))
    }
}
