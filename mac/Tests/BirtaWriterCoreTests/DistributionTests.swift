import XCTest
@testable import BirtaWriterCore

/// Which channel delivered this build, read off the sandbox, and what each
/// channel takes away. The shape follows `AppFlavorTests`: the discriminator
/// is asked directly, and every fact is enumerated from the type so a channel
/// added later has to answer each rather than be forgotten here.
final class DistributionTests: XCTestCase {
    func testASandboxedProcessShouldBeTheAppStoreBuild() {
        XCTAssertEqual(Distribution.forSandbox(true), .appStore)
        XCTAssertEqual(Distribution.forSandbox(false), .direct)
    }

    /// Presence is the test. The value is the container's id, which varies
    /// per install, and an empty value is still a sandboxed process.
    func testTheSandboxShouldBeReadOffTheVariablesPresence() {
        XCTAssertFalse(Distribution.isSandboxed([:]))
        XCTAssertFalse(Distribution.isSandboxed(["HOME": "/Users/somebody"]))
        XCTAssertTrue(Distribution.isSandboxed([Distribution.sandboxContainerVariable: "com.birtalabs.birta-writer"]))
        XCTAssertTrue(Distribution.isSandboxed([Distribution.sandboxContainerVariable: ""]))
    }

    /// The test process is never sandboxed, so this is the one arm `current`
    /// can be asked about here; the other is reached through `forSandbox`.
    /// It also pins the fact every shipped build relies on today: nothing in
    /// the tree builds a sandboxed copy yet, so the seam is inert everywhere.
    func testTheTestProcessShouldBeTheDirectBuild() {
        XCTAssertEqual(Distribution.current, .direct)
    }

    /// Every fact the sandbox takes away, and only the direct build has them.
    func testEveryFactShouldBeOfferedByTheDirectBuildAlone() {
        XCTAssertEqual(Distribution.allCases.count, 2)
        for distribution in Distribution.allCases {
            let direct = distribution == .direct
            XCTAssertEqual(distribution.offersAgent, direct, distribution.rawValue)
            XCTAssertEqual(distribution.offersTerminalCommand, direct, distribution.rawValue)
            XCTAssertEqual(distribution.updatesItself, direct, distribution.rawValue)
            XCTAssertEqual(distribution.readsInstalledEditorThemes, direct, distribution.rawValue)
            XCTAssertEqual(distribution.readsICloudDrive, direct, distribution.rawValue)
            // The one fact the STORE has and the direct build does not.
            XCTAssertEqual(distribution.keepsAccessGrants, !direct, distribution.rawValue)
        }
    }

    /// Self-update needs both answers, and the resolver is the only place the
    /// conjunction is written: a release on the store does not, and a
    /// development build downloaded directly does not either.
    func testOnlyADirectReleaseShouldUpdateItself() {
        for distribution in Distribution.allCases {
            for flavour in AppFlavor.allCases {
                XCTAssertEqual(distribution.updatesItself(flavour: flavour),
                               distribution == .direct && flavour == .release,
                               "\(distribution.rawValue) \(flavour.rawValue)")
            }
        }
    }

    /// The rows a store build omits, enumerated from the type: every row is
    /// asked, and exactly these six are taken away. A row added later is
    /// offered everywhere until somebody decides otherwise here.
    func testAStoreBuildShouldOmitExactlyTheRowsItsSandboxTakesAway() {
        let omitted = SettingsRow.allCases.filter { !Distribution.appStore.offers($0) }
        XCTAssertEqual(Set(omitted), [.agentEnabled, .agentCommand, .commandLine, .commandName, .autoUpdate,
                                      .storeInICloud])
        XCTAssertTrue(SettingsRow.allCases.allSatisfy(Distribution.direct.offers))
    }

    /// Filtering a pane drops the rows and then the cards they leave empty,
    /// and on the direct channel changes nothing at all.
    func testOfferedPanesShouldDropEmptiedCardsAndLeaveDirectUntouched() {
        for pane in SettingsForm.panes {
            XCTAssertEqual(SettingsForm.rows(of: Distribution.direct.offered(pane)), SettingsForm.rows(of: pane))
            let store = Distribution.appStore.offered(pane)
            XCTAssertTrue(store.groups.allSatisfy { !$0.rows.isEmpty }, "a store pane drew an empty card")
            XCTAssertTrue(SettingsForm.rows(of: store).allSatisfy(Distribution.appStore.offers))
        }
        // The pane that holds nothing else: its tab goes with its rows.
        XCTAssertTrue(Distribution.appStore.offered(SettingsForm.aiAgent).groups.isEmpty)
        // And the rest of Advanced survives.
        XCTAssertEqual(SettingsForm.rows(of: Distribution.appStore.offered(SettingsForm.advanced(showsWelcomeScreen: true))),
                       [.resetSettings, .welcomeScreen])
    }

    func testTheFirstRunScreenShouldNotAskAStoreBuildWhatItCannotDo() {
        let store = SettingsForm.rows(of: Distribution.appStore.offered(SettingsForm.welcome))
        XCTAssertFalse(store.contains(.autoUpdate))
        XCTAssertFalse(store.contains(.storeInICloud))
        // Location stays: on the store it is the way to any folder, iCloud
        // Drive's included.
        XCTAssertTrue(store.contains(.location))
        XCTAssertEqual(store, SettingsForm.rows(of: SettingsForm.welcome)
            .filter { $0 != .autoUpdate && $0 != .storeInICloud })
        XCTAssertEqual(SettingsForm.rows(of: Distribution.direct.offered(SettingsForm.welcome)),
                       SettingsForm.rows(of: SettingsForm.welcome))
    }
}
