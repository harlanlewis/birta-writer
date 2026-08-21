import XCTest
@testable import BirtaJotCore

/// Whether `/ai` is offered, which is one question with two ways to answer no.
///
/// Pure and here rather than on `Prefs`, because the app's defaults domain is
/// the real user's: a test that wrote `agentEnabled` to exercise this would
/// change somebody's settings, and one that only read it would assert whatever
/// that machine happened to hold.
final class AgentAvailabilityTests: XCTestCase {
    func testAnEnabledSwitchWithACommandShouldOfferTheAgent() {
        XCTAssertTrue(AgentAvailability.isAvailable(enabled: true, command: "claude -p {prompt}"))
    }

    func testTheSwitchBeingOffShouldWithdrawItWhateverTheCommandSays() {
        XCTAssertFalse(AgentAvailability.isAvailable(enabled: false, command: "claude -p {prompt}"))
    }

    func testNoCommandShouldWithdrawItEvenWithTheSwitchOn() {
        // The second way to have no agent. Without this arm the capability
        // would be declared on a host whose command field is empty, and `/ai`
        // would appear in the slash menu and run nothing.
        XCTAssertFalse(AgentAvailability.isAvailable(enabled: true, command: ""))
        XCTAssertFalse(AgentAvailability.isAvailable(enabled: true, command: "   "))
        XCTAssertFalse(AgentAvailability.isAvailable(enabled: true, command: "\n\t "))
    }

    /// A default that ships off must not take `/ai` away from the people who
    /// already have it.
    ///
    /// `/ai` shipped working in 2026.819.0, so on every existing install the
    /// switch's absence means "was using it", not "declined it". Off is right
    /// only for a domain that has never held a setting at all.
    func testAnInstallThatPredatesTheSwitchShouldKeepTheAgentItAlreadyHad() {
        XCTAssertTrue(AgentAvailability.enabledForInstallThatNeverAnswered(isFirstLaunch: false))
    }

    func testAGenuinelyNewInstallShouldStartWithTheAgentOff() {
        XCTAssertFalse(AgentAvailability.enabledForInstallThatNeverAnswered(isFirstLaunch: true))
    }

    func testAPresetTemplateShouldAlwaysCountAsACommand() {
        // Derived from the presets rather than a literal, so a preset added
        // with an empty template cannot ship a menu entry that runs nothing.
        XCTAssertFalse(AgentPreset.allCases.isEmpty)
        for preset in AgentPreset.allCases {
            XCTAssertTrue(AgentAvailability.isAvailable(enabled: true, command: preset.template),
                          "\(preset.title) has no runnable template")
        }
    }
}
