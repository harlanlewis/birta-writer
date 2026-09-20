import XCTest
@testable import BirtaWriterCore

final class FirstRunTests: XCTestCase {

    /// Every combination, so a fifth arm cannot be added without this matrix
    /// having something to say about it, and the count is asserted because a
    /// sweep that enumerated nothing passes every assertion inside it.
    func testTheWholeSpaceShouldBeCoveredAndOnlyAFirstOrdinaryLaunchShouldInvite() {
        var seen: [FirstRun.Opening: Int] = [:]
        for forced in [true, false] {
            for isUserStore in [true, false] {
                for hasSeenWelcome in [true, false] {
                    for documentBound in [true, false] {
                        let opening = FirstRun.opening(forced: forced,
                                                       isUserStore: isUserStore,
                                                       hasSeenWelcome: hasSeenWelcome,
                                                       documentBound: documentBound)
                        // The invariant, stated once and checked over
                        // everything: forced is the screen and outranks
                        // everything, and otherwise all three have to permit
                        // the invitation.
                        let expected: FirstRun.Opening = forced
                            ? .screen
                            : (isUserStore && !hasSeenWelcome && !documentBound
                               ? .invitation : .nothing)
                        XCTAssertEqual(opening, expected,
                                       "forced=\(forced) user store=\(isUserStore) "
                                       + "seen=\(hasSeenWelcome) document=\(documentBound)")
                        seen[opening, default: 0] += 1
                    }
                }
            }
        }
        XCTAssertEqual(seen.values.reduce(0, +), 16)
        // Every arm reached, so the matrix is not agreeing with itself about a
        // case it never produced. A three-way answer where one arm never
        // appears is a two-way answer with a dead branch.
        for opening in FirstRun.Opening.allCases {
            XCTAssertGreaterThan(seen[opening] ?? 0, 0, "\(opening) never came up")
        }
    }

    /// Each refusal on its own, so a rule that stopped being consulted is
    /// visible as a named failure rather than as one row of the matrix.
    func testAnyOneRefusalShouldBeEnoughOnItsOwn() {
        XCTAssertEqual(FirstRun.opening(forced: false, isUserStore: true,
                                        hasSeenWelcome: false, documentBound: false),
                       .invitation)

        XCTAssertEqual(FirstRun.opening(forced: false, isUserStore: false,
                                        hasSeenWelcome: false, documentBound: false),
                       .nothing,
                       "a throwaway defaults domain would meet a first launch every run")
        XCTAssertEqual(FirstRun.opening(forced: false, isUserStore: true,
                                        hasSeenWelcome: true, documentBound: false),
                       .nothing, "the tour is offered once")
        XCTAssertEqual(FirstRun.opening(forced: false, isUserStore: true,
                                        hasSeenWelcome: false, documentBound: true),
                       .nothing,
                       "nothing is put in front of somebody's own file")
    }

    /// No ordinary launch reaches the questions any more.
    ///
    /// The whole of what this issue changed, and it is the one claim the
    /// matrix above could satisfy with a rule that still showed the form to
    /// somebody: `forced` is the only argument that can produce `.screen`, so
    /// this asserts the other three cannot, over all of them.
    func testNothingButForcingItShouldEverReachTheQuestions() {
        for isUserStore in [true, false] {
            for hasSeenWelcome in [true, false] {
                for documentBound in [true, false] {
                    XCTAssertNotEqual(
                        FirstRun.opening(forced: false, isUserStore: isUserStore,
                                         hasSeenWelcome: hasSeenWelcome,
                                         documentBound: documentBound),
                        .screen,
                        "a launch is showing the form: user store=\(isUserStore) "
                        + "seen=\(hasSeenWelcome) document=\(documentBound)")
                }
            }
        }
    }

    /// The refusal has to leave the offer intact, or it is not a deferral, it
    /// is a first run somebody was skipped past. `hasSeenWelcome` is spent when
    /// the panel comes up, so a launch back on the app's own notes answers
    /// this the other way with nothing reset in between.
    func testDecliningForADocumentShouldLeaveTheTourOfferedOnceTheDocumentIsLeft() {
        XCTAssertEqual(FirstRun.opening(forced: false, isUserStore: true,
                                        hasSeenWelcome: false, documentBound: true),
                       .nothing)
        XCTAssertEqual(FirstRun.opening(forced: false, isUserStore: true,
                                        hasSeenWelcome: false, documentBound: false),
                       .invitation)
    }

    /// The refusal asks about the BINDING, so it survives the launch that made
    /// it. This is the whole reason it is not asked of `launchedWith` alone,
    /// and it is not covered by the matrix passing: a gate on the launch
    /// answers this case exactly the same way once and the wrong way every
    /// time after.
    ///
    /// What a launch-shaped gate costs is the tour itself, not just its
    /// timing. `FirstRunNote.shouldWrite` refuses the `document` slot, so an
    /// invitation offered over a still-bound document spends the one chance on
    /// a note it is not allowed to write, and `AppFlavor.showsWelcomeScreen`
    /// keeps every route back out of a release build.
    func testARelaunchWithTheDocumentStillBoundShouldStillRefuse() {
        // Same stored state, a launch later: nothing about the second launch
        // came from the Finder, and the panel is still on their file.
        XCTAssertEqual(FirstRun.opening(forced: false, isUserStore: true,
                                        hasSeenWelcome: false, documentBound: true),
                       .nothing)
    }

    /// `BIRTA_MAC_OPEN_WELCOME=1` outranks every refusal, this one included.
    /// It is the only way anything but a person builds the screen, because the
    /// ordinary gate no longer produces it at all, so a refusal it did not
    /// outrank would take the screen out of reach of the only run that checks
    /// it constructs.
    func testForcingItShouldOutrankEveryRefusal() {
        XCTAssertEqual(FirstRun.opening(forced: true, isUserStore: false,
                                        hasSeenWelcome: true, documentBound: true),
                       .screen)
    }
}
