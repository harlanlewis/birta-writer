import XCTest
@testable import BirtaWriterCore

/// The rule that keeps the app reachable without its hotkey: either surface
/// alone is enough, both is fine, neither is refused.
///
/// Every case is enumerated over the state space `Surface.allCases` spans
/// rather than over the four combinations written out by hand, and each sweep
/// asserts what it actually reached, because a sweep that reached nothing
/// passes exactly like one that reached everything.
///
/// `flags` is the one hand-written thing here, adapting a state to the two
/// labelled parameters the API takes, and it is hand-written deliberately: a
/// third surface makes `isShown`'s switch non-exhaustive and every call site a
/// compile error, which is a louder failure than a set-shaped API that would
/// quietly ignore one.
final class AppPresenceTests: XCTestCase {
    private typealias Surface = AppPresence.Surface

    /// Every combination of surfaces, built from the type.
    private var states: [Set<Surface>] {
        var result: [Set<Surface>] = [[]]
        for surface in Surface.allCases {
            let grown = result.map { $0.union([surface]) }
            result += grown
        }
        return result
    }

    private func flags(_ on: Set<Surface>) -> (menuBar: Bool, dock: Bool) {
        (on.contains(.menuBar), on.contains(.dock))
    }

    private func isOnlyWayIn(_ surface: Surface, _ state: Set<Surface>) -> Bool {
        let f = flags(state)
        return AppPresence.isOnlyWayIn(surface, menuBar: f.menuBar, dock: f.dock)
    }

    private func isReachable(_ state: Set<Surface>) -> Bool {
        let f = flags(state)
        return AppPresence.isReachable(menuBar: f.menuBar, dock: f.dock)
    }

    /// The instrument, before anything is asked of it. A state space that lost
    /// a combination would make every sweep below quietly narrower.
    func testTheStateSpaceShouldHoldEveryCombinationOfSurfacesExactlyOnce() {
        XCTAssertEqual(states.count, 1 << Surface.allCases.count)
        XCTAssertEqual(Set(states).count, states.count, "a combination is repeated")
        XCTAssertEqual(Surface.allCases.count, 2,
                       "a third surface needs a case in isShown, not just here")
    }

    func testExactlyOneStateShouldLeaveTheAppUnreachable() {
        let unreachable = states.filter { !isReachable($0) }

        XCTAssertEqual(unreachable, [[]],
                       "only showing nothing at all should be unreachable")
    }

    /// The definition, held against every state rather than the two that are
    /// interesting, and asserting that both verdicts were actually produced:
    /// a predicate that never said no would pass a sweep that only checked it
    /// said yes.
    func testASurfaceShouldBeTheLastWayInExactlyWhenItIsTheOnlyOneShown() {
        var said: Set<Bool> = []
        for state in states {
            for surface in Surface.allCases {
                let verdict = isOnlyWayIn(surface, state)
                said.insert(verdict)
                XCTAssertEqual(verdict, state == [surface],
                               "\(surface.rawValue) in \(state.map(\.rawValue).sorted())")
            }
        }

        XCTAssertEqual(said, [true, false],
                       "the sweep should reach both verdicts, or it discriminates nothing")
    }

    /// A surface that is off is never the last way in, which is what keeps its
    /// switch live so it can be turned back ON. The row's operability is the
    /// negation of `isOnlyWayIn` in both directions, and this is the half that
    /// would strand somebody if it were wrong.
    func testASurfaceThatIsAlreadyOffShouldNeverBeTheLastWayIn() {
        var checked = 0
        for state in states {
            for surface in Surface.allCases where !state.contains(surface) {
                checked += 1
                XCTAssertFalse(isOnlyWayIn(surface, state))
            }
        }

        XCTAssertEqual(checked, states.count * Surface.allCases.count / 2)
    }

    /// The theorem the rule exists for: from any state the app is reachable
    /// in, every move the rows PERMIT leaves it reachable. That is what makes
    /// the forbidden state unreachable from every direction at once, rather
    /// than from whichever direction somebody thought to guard.
    func testNoPermittedMoveShouldEverLeaveTheAppUnreachable() {
        var permitted = 0
        var refused = 0
        for state in states where isReachable(state) {
            for surface in Surface.allCases {
                guard !isOnlyWayIn(surface, state) else { refused += 1; continue }
                permitted += 1
                let next = state.contains(surface)
                    ? state.subtracting([surface])
                    : state.union([surface])
                XCTAssertTrue(isReachable(next),
                              "turning \(surface.rawValue) "
                                + (state.contains(surface) ? "off" : "on")
                                + " from \(state.map(\.rawValue).sorted()) stranded the app")
            }
        }

        XCTAssertGreaterThan(permitted, 0, "no move was examined")
        // Without a refusal the theorem is vacuous: it would hold of a rule
        // that permitted everything, which is the rule this one replaces.
        XCTAssertEqual(refused, Surface.allCases.count,
                       "each surface should be refused in exactly the state where it is alone")
    }

    /// "You cannot turn this off" is half an answer. The sentence has to name
    /// the move that makes it possible, and there is exactly one.
    func testTheLastWayInShouldNameTheOtherSurface() {
        for surface in Surface.allCases {
            let reason = surface.lastWayInReason
            XCTAssertFalse(reason.contains(surface.name),
                           "\(surface.rawValue) names itself rather than the way out")
            for other in Surface.allCases where other != surface {
                XCTAssertTrue(reason.contains(other.name),
                              "\(surface.rawValue) should point at \(other.name)")
            }
        }
    }

    /// The adapter the settings rows actually read. Blocked exactly where the
    /// rule says blocked, and carrying the sentence rather than a bare dead
    /// switch.
    func testTheRowShouldBeBlockedExactlyWhereTheSurfaceIsTheLastWayIn() {
        var blocked = 0
        for state in states where isReachable(state) {
            let f = flags(state)
            for surface in Surface.allCases {
                let row = RowAvailability.appPresence(surface, menuBar: f.menuBar, dock: f.dock)
                XCTAssertEqual(row.isEnabled, !isOnlyWayIn(surface, state))
                guard !row.isEnabled else { continue }
                blocked += 1
                XCTAssertEqual(row.note, surface.lastWayInReason)
                XCTAssertTrue(row.isProblem, "a dead switch needs the ink that says so")
            }
        }

        XCTAssertEqual(blocked, Surface.allCases.count)
    }
}
