import Foundation
import XCTest
@testable import BirtaWriter

/// A setting that is gone takes its stored value with it.
///
/// `Prefs.reset` walks `Prefs.Key`, so a key that left the type would
/// otherwise outlive every reset in the person's defaults domain. The `/ai`
/// command is the case this exists for: a shell line that can carry a home
/// path or a name.
final class RetiredPrefsTests: XCTestCase {
    /// The store `Prefs` writes to, resolved the way it resolves it.
    private var store: UserDefaults {
        if let suite = ProcessInfo.processInfo.environment["BIRTA_MAC_DEFAULTS_SUITE"], !suite.isEmpty,
           let defaults = UserDefaults(suiteName: suite) { return defaults }
        return .standard
    }

    override func tearDown() {
        for key in Prefs.retiredKeys { store.removeObject(forKey: key) }
        super.tearDown()
    }

    func testARetiredKeyShouldBeForgotten() {
        XCTAssertEqual(Set(Prefs.retiredKeys), ["agentCommand", "agentEnabled"])
        store.set("claude -p {prompt}", forKey: "agentCommand")
        store.set(true, forKey: "agentEnabled")
        // The arm that proves the write landed, so the absence below is the
        // cleanup's doing rather than a store that was never written.
        XCTAssertNotNil(store.object(forKey: "agentCommand"))

        Prefs.forgetRetiredKeys()

        for key in Prefs.retiredKeys {
            XCTAssertNil(store.object(forKey: key), "\(key) survived")
        }
    }

    /// A retired key is not a case of `Key`, or something could still read it.
    func testNoRetiredKeyShouldStillBeASetting() {
        let live = Set(Prefs.Key.allCases.map(\.rawValue))
        XCTAssertTrue(live.isDisjoint(with: Prefs.retiredKeys))
    }
}
