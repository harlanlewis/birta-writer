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
                                                             launchedWithDocument: launchedWithDocument)
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
                                                hasSeenWelcome: false, launchedWithDocument: false))

        XCTAssertFalse(FirstRunScreen.shouldShow(forced: false, isUserStore: false,
                                                 hasSeenWelcome: false, launchedWithDocument: false),
                       "a throwaway defaults domain would meet a first launch every run")
        XCTAssertFalse(FirstRunScreen.shouldShow(forced: false, isUserStore: true,
                                                 hasSeenWelcome: true, launchedWithDocument: false),
                       "the tour is offered once")
        XCTAssertFalse(FirstRunScreen.shouldShow(forced: false, isUserStore: true,
                                                 hasSeenWelcome: false, launchedWithDocument: true),
                       "somebody who asked for a file asked for that file")
    }

    /// The refusal has to leave the offer intact, or it is not a deferral, it
    /// is a first run somebody was skipped past. `hasSeenWelcome` is what the
    /// screen's own Continue sets, so the next launch that did not come from a
    /// file answers this the other way with nothing reset in between.
    func testDecliningForADocumentShouldLeaveTheTourOfferedOnTheNextOrdinaryLaunch() {
        let openWith = FirstRunScreen.shouldShow(forced: false, isUserStore: true,
                                                 hasSeenWelcome: false, launchedWithDocument: true)
        let nextLaunch = FirstRunScreen.shouldShow(forced: false, isUserStore: true,
                                                   hasSeenWelcome: false, launchedWithDocument: false)
        XCTAssertFalse(openWith)
        XCTAssertTrue(nextLaunch)
    }

    /// `BIRTA_JOT_OPEN_WELCOME=1` outranks every refusal, this one included.
    /// It is the only way anything but a person builds the screen, because the
    /// ordinary gate deliberately never fires under a throwaway domain, so a
    /// refusal it did not outrank would take the screen out of reach of the
    /// only run that checks it constructs.
    func testForcingItShouldOutrankEveryRefusal() {
        XCTAssertTrue(FirstRunScreen.shouldShow(forced: true, isUserStore: false,
                                                hasSeenWelcome: true, launchedWithDocument: true))
    }
}
