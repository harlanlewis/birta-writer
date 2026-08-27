import XCTest
@testable import BirtaJotCore

/// What a menu row draws of the state it toggles, decided without a menu.
final class MenuStateTests: XCTestCase {
    func testAnOptionTheReaderNeverTouchedShouldReadAsOn() {
        // The host stores only what was CHANGED, and every proofreading option
        // ships on. Reading an absent answer as off is the failure this pins:
        // it would draw a menu of unchecked rows over a document being checked,
        // and the reader's fix for that is to flip the row twice.
        let state = MenuState(proofreadOptions: ["spellCheck": false])
        XCTAssertFalse(state.isOn(.proofread("spellCheck")))
        XCTAssertTrue(state.isOn(.proofread("grammarCheck")))
        XCTAssertTrue(state.isOn(.proofread("styleCheck")))
        XCTAssertTrue(state.isOn(.proofread("proofreading")))
        XCTAssertTrue(state.isOn(.proofread("fillers")))
    }

    func testTheNoteHighlightShouldAnswerFromItsOwnFieldAndNotTheProofreadOptions() {
        // Sibling of the proofreading gate, not a child: an option map that
        // happened to hold the word must not decide it.
        let off = MenuState(proofreadOptions: ["noteHighlight": true], noteHighlight: false)
        XCTAssertFalse(off.isOn(.noteHighlight))
        XCTAssertTrue(MenuState(noteHighlight: true).isOn(.noteHighlight))
    }

    func testTheOutlinePanelShouldAnswerFromWhetherItIsOut() {
        XCTAssertTrue(MenuState(tocShown: true).isOn(.tocShown))
        XCTAssertFalse(MenuState(tocShown: false).isOn(.tocShown))
    }

    func testTheDefaultsShouldBeWhatAFirstLaunchSees() {
        // A window that has never been told anything: proofreading on,
        // markers on, outline shut. The panel's first launch is exactly this,
        // and a default that disagreed with the page would draw a menu that
        // was wrong before the reader had touched a thing.
        let fresh = MenuState()
        XCTAssertTrue(fresh.isOn(.proofread("proofreading")))
        XCTAssertTrue(fresh.isOn(.noteHighlight))
        XCTAssertFalse(fresh.isOn(.tocShown))
    }
}

/// The AppKit behaviours the app turns off before `NSApplication` exists.
///
/// What this can check is that the registration happens and reaches
/// `UserDefaults`. What it cannot is the thing it is FOR: the menu bar is drawn
/// out of process, so the row this key removes is not in any `NSMenu` an
/// XCTest can walk. `AppKitDefaults` says how to look at that, and
/// `jot/scripts/menu-bar.sh` is the instrument.
final class AppKitDefaultsTests: XCTestCase {
    func testTheFullScreenMenuItemShouldBeTurnedOff() {
        XCTAssertEqual(AppKitDefaults.values["NSFullScreenMenuItemEverywhere"] as? Bool, false)
    }

    func testRegisteringShouldReachTheDefaultsItIsGiven() {
        // A throwaway suite, so the test process's own standard defaults are
        // left alone. The registration domain is per-process either way, but a
        // check that writes into the domain the app reads is a check that has
        // changed the thing around it.
        let suite = "com.birtalabs.jot.menustatetests.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suite) else {
            return XCTFail("could not make a throwaway defaults suite")
        }
        defer {
            defaults.removePersistentDomain(forName: suite)
            // `defaults delete` leaves the plist behind because `cfprefsd`
            // writes it back; removed by exact name, never by a glob over
            // `com.birtalabs.jot.*`, which would take the user's own settings.
            try? FileManager.default.removeItem(
                at: FileManager.default.homeDirectoryForCurrentUser
                    .appendingPathComponent("Library/Preferences/\(suite).plist"))
        }
        XCTAssertNil(defaults.object(forKey: "NSFullScreenMenuItemEverywhere"),
                     "nothing has been registered yet, so this proves the arm below")
        AppKitDefaults.register(in: defaults)
        XCTAssertEqual(defaults.bool(forKey: "NSFullScreenMenuItemEverywhere"), false)
        XCTAssertNotNil(defaults.object(forKey: "NSFullScreenMenuItemEverywhere"))
    }
}
