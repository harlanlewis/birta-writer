import XCTest
@testable import BirtaJotCore

final class NoteModelTests: XCTestCase {
    // MARK: NoteHome

    func testAChosenFolderShouldOutrankBothHomes() {
        XCTAssertEqual(NoteHome.inForce(preferICloud: true, hasChosenPath: true, iCloudAvailable: true), .chosen)
        XCTAssertEqual(NoteHome.inForce(preferICloud: false, hasChosenPath: true, iCloudAvailable: false), .chosen)
    }

    func testPreferringICloudOnAMachineThatHasItShouldLandInICloud() {
        XCTAssertEqual(NoteHome.inForce(preferICloud: true, hasChosenPath: false, iCloudAvailable: true), .iCloud)
    }

    /// The silent half of the old pairing, kept: a machine with iCloud Drive
    /// switched off falls back rather than failing. The row is what says so.
    func testPreferringICloudWithoutTheServiceShouldFallBackToDocuments() {
        XCTAssertEqual(NoteHome.inForce(preferICloud: true, hasChosenPath: false, iCloudAvailable: false), .documents)
    }

    func testNotPreferringICloudShouldLandInDocumentsWhateverTheMachineOffers() {
        XCTAssertEqual(NoteHome.inForce(preferICloud: false, hasChosenPath: false, iCloudAvailable: true), .documents)
        XCTAssertEqual(NoteHome.inForce(preferICloud: false, hasChosenPath: false, iCloudAvailable: false), .documents)
    }

    /// Enumerated rather than sampled: three booleans is eight states, and a
    /// resolver that ignored one of its inputs would still satisfy any hand
    /// picked subset of them.
    func testEveryCombinationOfTheThreeInputsShouldResolveToExactlyOneHome() {
        var seen: [NoteHome: Int] = [:]
        var count = 0
        for prefer in [true, false] {
            for chosen in [true, false] {
                for available in [true, false] {
                    let home = NoteHome.inForce(preferICloud: prefer, hasChosenPath: chosen,
                                                iCloudAvailable: available)
                    seen[home, default: 0] += 1
                    count += 1
                }
            }
        }
        XCTAssertEqual(count, 8)
        // All three reachable, so no option is dead in the popup.
        XCTAssertEqual(Set(seen.keys), Set(NoteHome.allCases))
    }

    // MARK: NoteMode

    func testEveryModeShouldBeNamedForTheMenuThatListsThem() {
        for mode in NoteMode.allCases {
            XCTAssertFalse(mode.title.isEmpty, String(describing: mode))
        }
        XCTAssertEqual(Set(NoteMode.allCases.map(\.title)).count, NoteMode.allCases.count)
    }

    // MARK: AgentPreset

    /// Derived from the type, so a preset added later is covered without this
    /// file being touched. A hand-written list of nine would not be.
    func testEveryPresetShouldCarryANameAndARunnableTemplate() {
        XCTAssertGreaterThanOrEqual(AgentPreset.allCases.count, 4)
        for preset in AgentPreset.allCases {
            XCTAssertFalse(preset.title.isEmpty, preset.rawValue)
            XCTAssertTrue(preset.template.contains(AgentRequest.promptPlaceholder),
                          "\(preset.rawValue) would append the prompt rather than place it")
            XCTAssertFalse(preset.template.hasPrefix(" "), preset.rawValue)
        }
    }

    func testNoTwoPresetsShouldShareANameOrACommand() {
        XCTAssertEqual(Set(AgentPreset.allCases.map(\.title)).count, AgentPreset.allCases.count)
        XCTAssertEqual(Set(AgentPreset.allCases.map(\.template)).count, AgentPreset.allCases.count)
    }

    /// The shipped default has to be one of the presets, so the template menu
    /// can reach the command a fresh install already holds.
    ///
    /// `Prefs.agentCommand` reads its default from `fallback.template` rather
    /// than from a second copy of that string, which is what makes this one
    /// assertion cover both.
    func testTheDefaultCommandShouldBeOneOfThePresets() {
        XCTAssertTrue(AgentPreset.allCases.contains(AgentPreset.fallback))
        XCTAssertFalse(AgentPreset.fallback.template.isEmpty)
        XCTAssertTrue(AgentPreset.fallback.template.contains("{prompt}"),
                      "the shipped command has no placeholder, so /ai would run it without the request")
    }
}
