import BirtaWriterCore
import XCTest
@testable import BirtaWriter

/// A new install shows its Dock icon; an install from before that default
/// keeps the icon it had. The second half is the one that is easy to lose:
/// the old default was never written down, so without the migration every
/// install that never touched the switch would gain an icon on update.
@MainActor
final class DockDefaultTests: XCTestCase {
    private var suite: String!
    private var store: UserDefaults!

    override func setUpWithError() throws {
        suite = "com.birtalabs.birta-writer.tests.dock.\(UUID().uuidString)"
        store = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDown() {
        store.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    private var stored: Any? { store.object(forKey: Prefs.Key.showInDock.rawValue) }

    func testAFirstLaunchShouldWriteNothingAndTakeTheNewDefault() {
        Prefs.keepExistingDockChoice(in: store)
        XCTAssertNil(stored, "a first launch had its Dock choice written for it")
    }

    /// The launch after a first one is not a first launch, so the absent key
    /// it would otherwise find reads as an install from before the change.
    /// Each launch is played in the order `Entry` and `App` run it.
    func testANewInstallShouldStillShowItsIconOnItsSecondLaunch() {
        for _ in 0..<2 {
            Prefs.keepExistingDockChoice(in: store)
            let first = Prefs.isFirstLaunch(in: store)
            Prefs.recordNewInstallDock(firstLaunch: first, in: store)
            store.set(true, forKey: Prefs.Key.hasSeenWelcome.rawValue)
        }
        XCTAssertEqual(stored as? Bool, true, "a new install lost its Dock icon on the second launch")
    }

    func testRecordingShouldWriteNothingOutsideAFirstLaunchOrOverAChoice() {
        Prefs.recordNewInstallDock(firstLaunch: false, in: store)
        XCTAssertNil(stored)
        store.set(false, forKey: Prefs.Key.showInDock.rawValue)
        Prefs.recordNewInstallDock(firstLaunch: true, in: store)
        XCTAssertEqual(stored as? Bool, false)
    }

    func testAnExistingInstallThatNeverChoseShouldKeepItsIconOff() {
        store.set(false, forKey: Prefs.Key.hasSeenWelcome.rawValue)
        Prefs.keepExistingDockChoice(in: store)
        XCTAssertEqual(stored as? Bool, false, "an existing install gained a Dock icon on update")
    }

    func testAChoiceAlreadyMadeShouldBeLeftAlone() {
        store.set(true, forKey: Prefs.Key.hasSeenWelcome.rawValue)
        store.set(true, forKey: Prefs.Key.showInDock.rawValue)
        Prefs.keepExistingDockChoice(in: store)
        XCTAssertEqual(stored as? Bool, true)
    }

    /// The accessor's own default, read through the process's store: nothing
    /// stored reads as ON.
    func testAMissingKeyShouldReadAsOn() {
        let defaults = UserDefaults.standard
        let key = Prefs.Key.showInDock.rawValue
        let saved = defaults.object(forKey: key)
        defer { defaults.set(saved, forKey: key) }
        defaults.removeObject(forKey: key)
        XCTAssertTrue(Prefs.showInDock)
        Prefs.showInDock = false
        XCTAssertFalse(Prefs.showInDock)
    }
}
