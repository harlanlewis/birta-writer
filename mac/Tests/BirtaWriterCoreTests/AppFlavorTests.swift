import XCTest
@testable import BirtaWriterCore

final class AppFlavorTests: XCTestCase {
    func testTheDevelopmentIdShouldNotSitInTheReaperScratchNamespace() {
        // `mac/scripts/reap.sh` clears every defaults domain strictly under
        // `com.birtalabs.birta-writer.`, which is what keeps a checking run from
        // leaving scratch settings on the machine. A development build parked
        // there would have its settings deleted at the end of every session,
        // and the failure would look like the app forgetting things at random.
        XCTAssertFalse(AppFlavor.devBundleID.hasPrefix(AppFlavor.releaseBundleID + "."),
                       "\(AppFlavor.devBundleID) is inside the namespace reap.sh clears")
        XCTAssertNotEqual(AppFlavor.devBundleID, AppFlavor.releaseBundleID)
    }

    func testEachFlavourShouldBeNamedByItsOwnBundleId() {
        XCTAssertEqual(AppFlavor.forBundle(AppFlavor.releaseBundleID), .release)
        XCTAssertEqual(AppFlavor.forBundle(AppFlavor.devBundleID), .dev)
        for flavour in AppFlavor.allCases {
            XCTAssertEqual(AppFlavor.forBundle(flavour.bundleID), flavour)
        }
    }

    /// Anything unrecognised is the release, so an id nobody expected gets the
    /// careful behaviour rather than the permissive one.
    func testAnUnknownBundleIdShouldBeTreatedAsTheRelease() {
        for id in [nil, "", "com.example.other", "com.birtalabs.birta-writer.measure.123"] {
            XCTAssertEqual(AppFlavor.forBundle(id), .release, String(describing: id))
        }
    }

    /// Every collision the two builds could have, enumerated from the type so
    /// a flavour added later cannot quietly share one of them.
    func testNoTwoFlavoursShouldShareAnythingThatWouldMakeThemCollide() {
        let ids = AppFlavor.allCases.map(\.bundleID)
        let names = AppFlavor.allCases.map(\.displayName)
        let suffixes = AppFlavor.allCases.map(\.nameSuffix)
        let hotkeys = AppFlavor.allCases.map(\.defaultHotkey.spelling)
        XCTAssertEqual(Set(ids).count, AppFlavor.allCases.count)
        XCTAssertEqual(Set(names).count, AppFlavor.allCases.count)
        XCTAssertEqual(Set(suffixes).count, AppFlavor.allCases.count)
        XCTAssertEqual(Set(hotkeys).count, AppFlavor.allCases.count)
        XCTAssertGreaterThanOrEqual(AppFlavor.allCases.count, 2)
    }

    /// The release keeps every existing install exactly where it is: an empty
    /// suffix is what makes the note path unchanged for everybody.
    func testTheReleaseShouldAddNothingToTheNoteName() {
        XCTAssertEqual(AppFlavor.release.nameSuffix, "")
        XCTAssertEqual(AppFlavor.release.displayName, ScratchpadLocation.productName)
        XCTAssertFalse(AppFlavor.dev.nameSuffix.isEmpty)
    }

    /// The two builds must not open one file, which is two writers autosaving
    /// over somebody's writing.
    func testTheTwoFlavoursShouldResolveToDifferentNotesInBothHomes() {
        let root = URL(fileURLWithPath: "/tmp/root")
        for home in [ScratchpadLocation.local, .iCloud] {
            let release = home.url(root: root, nameSuffix: AppFlavor.release.nameSuffix)
            let dev = home.url(root: root, nameSuffix: AppFlavor.dev.nameSuffix)
            XCTAssertNotEqual(release, dev, String(describing: home))
        }
    }

    /// The suffix reaches the folder in iCloud Drive and not in Documents, and
    /// the asymmetry is deliberate: the iCloud folder is named after the APP,
    /// so a second app wants a second folder, and the local one is named after
    /// the product line, where a suffix would claim a whole development suite.
    func testOnlyTheICloudFolderShouldCarryTheFlavourSuffix() {
        let root = URL(fileURLWithPath: "/tmp/root")
        let localFolder = { (f: AppFlavor) in
            ScratchpadLocation.local.url(root: root, nameSuffix: f.nameSuffix).deletingLastPathComponent()
        }
        XCTAssertEqual(localFolder(.release), localFolder(.dev))
        let iCloudFolder = { (f: AppFlavor) in
            ScratchpadLocation.iCloud.url(root: root, nameSuffix: f.nameSuffix).deletingLastPathComponent()
        }
        XCTAssertNotEqual(iCloudFolder(.release), iCloudFolder(.dev))
    }

    /// A development build replacing itself would delete the change somebody
    /// built it to look at.
    func testOnlyTheReleaseShouldUpdateItself() {
        XCTAssertTrue(AppFlavor.release.updatesItself)
        XCTAssertFalse(AppFlavor.dev.updatesItself)
    }
}
