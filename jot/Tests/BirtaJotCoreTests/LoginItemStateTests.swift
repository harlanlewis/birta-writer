import ServiceManagement
import XCTest
@testable import BirtaJotCore

final class LoginItemStateTests: XCTestCase {
    func testEnabledStatusShouldReadAsOn() {
        XCTAssertEqual(LoginItemState(.enabled), .on)
        XCTAssertTrue(LoginItemState.on.isOn)
        XCTAssertTrue(LoginItemState.on.isEnabled)
        XCTAssertFalse(LoginItemState.on.isWarning)
    }

    func testNotRegisteredStatusShouldReadAsOff() {
        XCTAssertEqual(LoginItemState(.notRegistered), .off)
        XCTAssertFalse(LoginItemState.off.isOn)
        XCTAssertTrue(LoginItemState.off.isEnabled)
        XCTAssertFalse(LoginItemState.off.isWarning)
    }

    /// The state the switch position is least obvious for. The registration
    /// exists and only the launch is held, so the switch stays on: snapping it
    /// back to off would tell the user their request was refused, and turning
    /// it off is a different act from the one they just performed.
    func testRequiresApprovalStatusShouldReadAsOnAndWarn() {
        XCTAssertEqual(LoginItemState(.requiresApproval), .blocked)
        XCTAssertTrue(LoginItemState.blocked.isOn)
        XCTAssertTrue(LoginItemState.blocked.isEnabled)
        XCTAssertTrue(LoginItemState.blocked.isWarning)
    }

    /// A copy the system will not register cannot be switched on, so the row is
    /// dead rather than lying about a setting that will not take.
    func testNotFoundStatusShouldReadAsUnavailableAndDisableTheRow() {
        XCTAssertEqual(LoginItemState(.notFound), .unavailable)
        XCTAssertFalse(LoginItemState.unavailable.isOn)
        XCTAssertFalse(LoginItemState.unavailable.isEnabled)
        XCTAssertTrue(LoginItemState.unavailable.isWarning)
    }

    /// Every state says something, and the two ordinary ones say the same
    /// thing: the caption describes the setting, and only changes when it has
    /// a problem to report instead.
    func testEveryStateShouldCarryACaptionAndOnlyDifferWhenWarning() {
        let all: [LoginItemState] = [.on, .off, .blocked, .unavailable]
        for state in all {
            XCTAssertFalse(state.caption.isEmpty, "\(state) has no caption")
        }
        XCTAssertEqual(LoginItemState.on.caption, LoginItemState.off.caption)
        XCTAssertNotEqual(LoginItemState.blocked.caption, LoginItemState.on.caption)
        XCTAssertNotEqual(LoginItemState.unavailable.caption, LoginItemState.blocked.caption)
    }

    /// The mapping covers the enum rather than the four cases someone thought
    /// of: a new `SMAppService.Status` falls to `off`, which is the safe end
    /// (no claim that the app will launch), and this fails if that stops
    /// holding.
    func testEveryKnownStatusShouldMapToADistinctState() {
        let statuses: [SMAppService.Status] = [.enabled, .notRegistered, .requiresApproval, .notFound]
        let states = statuses.map(LoginItemState.init)
        XCTAssertEqual(states.count, 4)
        XCTAssertEqual(Set(states.map(\.isOn)).count, 2, "on and off must both be reachable")
        XCTAssertEqual(states, [.on, .off, .blocked, .unavailable])
    }
}
