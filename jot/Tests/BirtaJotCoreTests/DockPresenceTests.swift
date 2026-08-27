import XCTest
@testable import BirtaJotCore

/// What moving the Show in Dock switch has to do.
///
/// Three answers rather than two, and the third is the one the app was missing:
/// leaving `.regular` deactivates the app, so the window somebody is looking at
/// goes behind everything else at the moment they touch the switch.
///
/// The sweep is over the whole input space rather than a hand-written list of
/// interesting cases, because the space is three booleans: eight rows is the
/// entire behaviour, and a case a later change forgets cannot hide in it.
final class DockPresenceTests: XCTestCase {
    private func action(_ showInDock: Bool, _ isRegular: Bool, _ keeping: Bool) -> DockPresence.Action {
        DockPresence.action(showInDock: showInDock, isRegular: isRegular, keepingFrontmost: keeping)
    }

    func testAPolicyThatAlreadyMatchesShouldNotBeSetAgain() {
        // Not a tidying. Setting the policy is what deactivates the app, so
        // setting it to the value it already has buys a window going behind
        // everything else in exchange for no change at all.
        for keeping in [false, true] {
            XCTAssertEqual(action(true, true, keeping), .nothing)
            XCTAssertEqual(action(false, false, keeping), .nothing)
        }
    }

    func testTurningTheDockIconOffFromASwitchShouldPutTheWindowBack() {
        // The case this exists for, and the only one that restores.
        XCTAssertEqual(action(false, true, true), .change(regular: false, restoreFrontmost: true))
    }

    func testTurningTheDockIconOffAtLaunchShouldTakeNoActivation() {
        // Launch and the first-run screen. There is no window somebody is
        // looking at, and an accessory app that grabbed focus at login would be
        // the worse bug.
        XCTAssertEqual(action(false, true, false), .change(regular: false, restoreFrontmost: false))
    }

    func testTurningTheDockIconOnShouldNeverTakeActivation() {
        // Going TO `.regular` does not deactivate, so there is nothing to put
        // back and an activation here is one nobody asked for. Both callers,
        // because the toggle is the one that would plausibly be given it.
        for keeping in [false, true] {
            XCTAssertEqual(action(true, false, keeping), .change(regular: true, restoreFrontmost: false))
        }
    }

    /// Every combination, and what it decides. The rows above name the ones
    /// worth arguing about; this is the arm that says nothing else is hiding
    /// in the space, and that the sweep really covered all of it.
    func testTheWholeInputSpaceShouldBeAccountedFor() {
        var seen: [String: DockPresence.Action] = [:]
        for showInDock in [false, true] {
            for isRegular in [false, true] {
                for keeping in [false, true] {
                    seen["\(showInDock)-\(isRegular)-\(keeping)"] = action(showInDock, isRegular, keeping)
                }
            }
        }
        XCTAssertEqual(seen.count, 8)
        // Exactly one of the eight restores, and it is the live toggle that
        // turns the Dock icon off.
        let restoring = seen.filter { $0.value == .change(regular: false, restoreFrontmost: true) }
        XCTAssertEqual(Array(restoring.keys), ["false-true-true"])
        // ...and exactly half of them do nothing, which is every row where the
        // setting and the policy already agree.
        XCTAssertEqual(seen.values.filter { $0 == .nothing }.count, 4)
    }
}
