import BirtaWriterCore
import XCTest
@testable import BirtaWriter

/// Taking and renewing the store channel's grants, with the bookmark calls
/// faked: a real security-scoped bookmark needs a sandboxed process with the
/// bookmarks entitlement, and a test process is neither. What is checked here
/// is everything around those calls; `mac/scripts/sandbox-check.sh` is where
/// the real ones are seen to renew a grant across a relaunch.
@MainActor
final class SandboxAccessTests: XCTestCase {
    private var saved: AccessGrantList!
    private var savedBookmarks: SandboxAccess.Bookmarks!
    private var made: [String] = []
    private var started: [String] = []

    override func setUp() {
        super.setUp()
        saved = Prefs.accessGrants
        savedBookmarks = SandboxAccess.bookmarks
        Prefs.accessGrants = AccessGrantList()
        SandboxAccess.resetForTesting()
        made = []
        started = []
        SandboxAccess.bookmarks = SandboxAccess.Bookmarks(
            make: { [unowned self] url in self.made.append(url.path); return Data(url.path.utf8) },
            resolve: { data in (URL(fileURLWithPath: String(decoding: data, as: UTF8.self)), false) },
            startAccessing: { [unowned self] url in self.started.append(url.path); return true })
    }

    override func tearDown() {
        Prefs.accessGrants = saved
        SandboxAccess.bookmarks = savedBookmarks
        SandboxAccess.resetForTesting()
        super.tearDown()
    }

    func testTheDirectBuildShouldTakeAndRenewNothing() {
        SandboxAccess.remember(URL(fileURLWithPath: "/notes/a.md"), distribution: .direct)
        Prefs.accessGrants = AccessGrantList().recording(.init(path: "/notes", bookmark: Data("/notes".utf8)))
        SandboxAccess.restoreAtLaunch(distribution: .direct)
        XCTAssertEqual(made, [])
        XCTAssertEqual(started, [])
    }

    func testAStoreBuildShouldRememberWhatItIsHandedAndSkipWhatAGrantCovers() {
        SandboxAccess.remember(URL(fileURLWithPath: "/notes"), distribution: .appStore)
        SandboxAccess.remember(URL(fileURLWithPath: "/notes/a.md"), distribution: .appStore)
        SandboxAccess.remember(URL(fileURLWithPath: "/elsewhere/b.md"), distribution: .appStore)
        XCTAssertEqual(made, ["/notes", "/elsewhere/b.md"], "a file inside a granted folder needs no grant of its own")
        XCTAssertEqual(Prefs.accessGrants.grants.map(\.path), ["/elsewhere/b.md", "/notes"])
    }

    func testALaunchShouldRenewEveryGrantAndDropOneThatNoLongerResolves() {
        Prefs.accessGrants = AccessGrantList()
            .recording(.init(path: "/gone.md", bookmark: Data("gone".utf8)))
            .recording(.init(path: "/notes", bookmark: Data("/notes".utf8)))
        SandboxAccess.bookmarks.resolve = { data in
            let path = String(decoding: data, as: UTF8.self)
            return path == "gone" ? nil : (URL(fileURLWithPath: path), false)
        }
        SandboxAccess.restoreAtLaunch(distribution: .appStore)
        XCTAssertEqual(started, ["/notes"])
        XCTAssertEqual(SandboxAccess.live.map(\.path), ["/notes"])
        XCTAssertEqual(Prefs.accessGrants.grants.map(\.path), ["/notes"], "a dead grant would be retried every launch")
    }

    func testAStaleBookmarkShouldBeTakenAgainWhereItStands() {
        Prefs.accessGrants = AccessGrantList()
            .recording(.init(path: "/a.md", bookmark: Data("old".utf8)))
            .recording(.init(path: "/b.md", bookmark: Data("/b.md".utf8)))
        SandboxAccess.bookmarks.resolve = { data in
            let path = String(decoding: data, as: UTF8.self)
            return path == "old" ? (URL(fileURLWithPath: "/a.md"), true) : (URL(fileURLWithPath: path), false)
        }
        SandboxAccess.restoreAtLaunch(distribution: .appStore)
        XCTAssertEqual(made, ["/a.md"])
        XCTAssertEqual(Prefs.accessGrants.grants.map(\.path), ["/b.md", "/a.md"])
        XCTAssertEqual(Prefs.accessGrants.grants.last?.bookmark, Data("/a.md".utf8))
    }

    /// A launch that came from Open With records a grant before the first
    /// launch is decided, and counting it would make that launch an existing
    /// install. The pair is what discriminates: any other key does count.
    func testAGrantAloneShouldNotMakeALaunchAnExistingInstall() throws {
        let suite = "com.birtalabs.birta-writer.tests.firstlaunch.\(UUID().uuidString)"
        let store = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { store.removePersistentDomain(forName: suite) }
        XCTAssertTrue(Prefs.isFirstLaunch(in: store))
        store.set(Data([1]), forKey: Prefs.Key.accessGrants.rawValue)
        XCTAssertTrue(Prefs.isFirstLaunch(in: store), "a grant made this launch an existing install")
        store.set(true, forKey: Prefs.Key.hasSeenWelcome.rawValue)
        XCTAssertFalse(Prefs.isFirstLaunch(in: store))
    }
}
