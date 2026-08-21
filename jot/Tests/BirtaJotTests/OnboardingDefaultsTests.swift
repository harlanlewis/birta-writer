import AppKit
import XCTest
@testable import BirtaJot

/// The onboarding gate's ARMS, not its boolean.
///
/// `applyOnboardingDefaults` decides one thing and then does something
/// machine-wide, and until MAR-398 the only assertion over it was a
/// `jot-trace onboarding loginitem=` line that `jot/scripts/measure.sh` greps.
/// That script launches the real app, needs a window server and cannot run in
/// CI, so the gate was unchecked on every pull request.
///
/// What is asserted here is whether the EFFECT ran, which is the observable
/// that trace line exists to stand in for. A test over `firstLaunch &&
/// userStore` as a pure predicate would assert `&&` and would pass just as
/// happily with the `guard` below it deleted, which is the failure this file
/// is for.
///
/// Nothing here touches the real `LoginItem`. Both halves of the gate read
/// TRUE inside an xctest process (measured, not assumed: nothing sets
/// `BIRTA_JOT_DEFAULTS_SUITE`, and the runner's own standard domain holds none
/// of our keys), so calling this without injecting the effect would register a
/// login item pointing at the test runner. A login item lives in BTM rather
/// than in a plist under our domain, so `jot/scripts/reap.sh` cannot see it
/// and cannot clear it: it would survive the session that made it.
final class OnboardingDefaultsTests: XCTestCase {
    /// What the injected effect saw: one entry per call, holding its argument.
    private final class Registrar {
        private(set) var calls: [Bool] = []
        func register(_ on: Bool) { calls.append(on) }
    }

    /// The one case that ACTS: a genuine first launch, in the person's own store.
    func testAFirstLaunchInTheUsersOwnStoreShouldRegisterTheLoginItem() {
        let registrar = Registrar()
        Prefs.applyOnboardingDefaults(firstLaunch: true, userStore: true,
                                      register: registrar.register)

        XCTAssertEqual(registrar.calls, [true],
                       "a first launch in the user's own store is the case that registers")
    }

    /// A checking run: first launch, but against a throwaway defaults domain.
    ///
    /// This is the arm `isUserStore` exists for. `jot/scripts/measure.sh`
    /// launches a bundle out of `jot/build/` against a throwaway domain, so
    /// every run looks like a first launch, and without this gate each one
    /// would register a login item pointing into a build directory the next
    /// checkout replaces.
    func testAFirstLaunchUnderAThrowawayStoreShouldRegisterNothing() {
        let registrar = Registrar()
        Prefs.applyOnboardingDefaults(firstLaunch: true, userStore: false,
                                      register: registrar.register)

        XCTAssertEqual(registrar.calls, [],
                       "a throwaway defaults domain is a checking run, and must not reach BTM")
    }

    /// An existing install, which reaches the first-run screen too.
    ///
    /// `hasSeenWelcome` is absent for everybody who had Jot before that screen
    /// existed, so they see it; registering a login item for them would be
    /// reaching into something they have been living with.
    func testARepeatLaunchInTheUsersOwnStoreShouldRegisterNothing() {
        let registrar = Registrar()
        Prefs.applyOnboardingDefaults(firstLaunch: false, userStore: true,
                                      register: registrar.register)

        XCTAssertEqual(registrar.calls, [],
                       "an existing install is not a first launch, whatever screen it is shown")
    }

    /// Neither half true, which is `measure.sh` against an install that has run.
    func testNeitherHalfTrueShouldRegisterNothing() {
        let registrar = Registrar()
        Prefs.applyOnboardingDefaults(firstLaunch: false, userStore: false,
                                      register: registrar.register)

        XCTAssertEqual(registrar.calls, [])
    }
}
