import XCTest
@testable import BirtaWriter
import BirtaWriterCore

/// Which host capabilities a page is offered, decided per window.
///
/// `Prefs.bootConfig` restates the Mac profile as a literal and then withdraws
/// what THIS window cannot provide. The drift guard in
/// `shared/__tests__/hostProfile.test.ts` holds the literal against the
/// profile; what it cannot see is the filter, which runs at runtime, so the
/// filter's two arms are held here. `hostProfile.ts` says why the explorer's
/// capability is per window: the declaration is what puts the explorer's
/// button on the bar, and a window on a loose file must show none of it.
@MainActor
final class BootConfigTests: XCTestCase {
    func testAWindowOnALooseFileShouldNotBeOfferedTheExplorer() {
        let capabilities = Prefs.bootConfig(viewState: nil, explorerRoot: nil).hostCapabilities
        XCTAssertFalse(capabilities.contains("projectFiles"))
        XCTAssertFalse(capabilities.contains("folderIndex"), "no root, so no folder to index")
        XCTAssertTrue(capabilities.contains("toc"), "the rest of the profile is untouched")
    }

    func testAWindowRootedAtAFolderShouldBeOfferedTheExplorer() {
        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        let capabilities = Prefs.bootConfig(viewState: nil, explorerRoot: root).hostCapabilities
        XCTAssertTrue(capabilities.contains("projectFiles"))
        XCTAssertTrue(capabilities.contains("folderIndex"))
    }

    func testTheOrderShouldBeTheProfilesWithOnlyTheWithdrawnEntriesMissing() {
        // The guard compares the literal in order; the filter must remove and
        // never reorder, or a page could read a different profile than the
        // one the guard blessed.
        let full = Prefs.bootConfig(viewState: nil, explorerRoot: URL(fileURLWithPath: NSTemporaryDirectory())).hostCapabilities
        let loose = Prefs.bootConfig(viewState: nil, explorerRoot: nil).hostCapabilities
        XCTAssertEqual(loose, full.filter { $0 != "projectFiles" && $0 != "folderIndex" })
    }
}
