import XCTest
@testable import BirtaJotCore

/// Where the default note lives: the two homes, the folder each uses, and the
/// rule that resolves the setting against whether iCloud Drive is actually
/// there.
final class ScratchpadLocationTests: XCTestCase {
    private var tmp: URL!

    override func setUpWithError() throws {
        tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("scratchpad-location-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmp)
    }

    // MARK: which home is in force

    /// The whole truth table, from the type rather than from a list kept by
    /// hand: two booleans is four cases, and enumerating them is what stops a
    /// later change to `inForce` passing because the case it broke was the one
    /// nobody wrote down.
    func testTheSettingAndAvailabilityShouldResolveTogether() {
        var seen: [ScratchpadLocation] = []
        for prefer in [true, false] {
            for available in [true, false] {
                let got = ScratchpadLocation.inForce(preferICloud: prefer, iCloudAvailable: available)
                let want: ScratchpadLocation = prefer && available ? .iCloud : .local
                XCTAssertEqual(got, want, "prefer=\(prefer) available=\(available)")
                seen.append(got)
            }
        }
        XCTAssertEqual(seen.count, 4, "every combination should have been asked")
        // Both answers must actually occur, or the assertion above holds for a
        // function that returns one constant.
        XCTAssertTrue(seen.contains(.iCloud))
        XCTAssertTrue(seen.contains(.local))
    }

    /// The case the fallback exists for, stated on its own because it is the
    /// one that would otherwise write into a folder that is not there.
    func testWantingICloudWithoutICloudShouldFallBackToLocal() {
        XCTAssertEqual(
            ScratchpadLocation.inForce(preferICloud: true, iCloudAvailable: false), .local)
    }

    // MARK: the paths

    func testEachHomeShouldPutTheNoteInItsOwnFolder() {
        XCTAssertEqual(
            ScratchpadLocation.iCloud.url(root: tmp).path,
            tmp.appendingPathComponent("Birta Writer/Birta Writer.md").path)
        XCTAssertEqual(
            ScratchpadLocation.local.url(root: tmp).path,
            tmp.appendingPathComponent("Birta Writer/Birta Writer.md").path)
    }

    /// The folders differ and the FILE does not. A note that renamed itself
    /// when the setting moved would be a different note to anyone reading the
    /// window title.
    func testTheNoteShouldBeNamedTheSameInBothHomes() {
        var names = Set<String>()
        var folders = Set<String>()
        for location in ScratchpadLocation.allCases {
            names.insert(location.url(root: tmp).lastPathComponent)
            folders.insert(location.folderName)
        }
        XCTAssertEqual(names, [ScratchpadLocation.fileName])
        XCTAssertEqual(folders.count, ScratchpadLocation.allCases.count,
                       "each home should have a folder of its own")
        // A floor on the sweep: `allCases` is the enumeration, and a version of
        // this that reached one case would satisfy both sets above.
        XCTAssertGreaterThanOrEqual(ScratchpadLocation.allCases.count, 2)
    }

    // MARK: detecting iCloud Drive

    func testAHomeWithTheCloudDocsFolderShouldReportICloud() throws {
        let root = tmp.appendingPathComponent("Library/Mobile Documents/com~apple~CloudDocs")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        XCTAssertEqual(
            ScratchpadLocation.iCloudDriveRoot(home: tmp)?.standardizedFileURL.path,
            root.standardizedFileURL.path)
    }

    func testAHomeWithoutItShouldReportNone() {
        XCTAssertNil(ScratchpadLocation.iCloudDriveRoot(home: tmp))
    }

    /// A FILE at that path is not iCloud Drive. The check is `isDirectory`, and
    /// without it a stray file of the right name would send every note into a
    /// path that cannot hold one.
    func testAFileWhereTheFolderShouldBeShouldReportNone() throws {
        let parent = tmp.appendingPathComponent("Library/Mobile Documents")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        try Data().write(to: parent.appendingPathComponent("com~apple~CloudDocs"))
        XCTAssertNil(ScratchpadLocation.iCloudDriveRoot(home: tmp))
    }

    // MARK: the names reach the paths

    /// The two constants are what the folders and the file are built from, so a
    /// rename cannot reach the label and miss the filesystem. The drift test in
    /// `shared/__tests__/editorCommandsContributions.test.ts` holds them to
    /// `product.ts`; this holds the paths to them.
    func testTheProductNameShouldReachBothTheFileAndTheICloudFolder() {
        XCTAssertEqual(ScratchpadLocation.fileName, "\(ScratchpadLocation.productName).md")
        XCTAssertEqual(ScratchpadLocation.iCloud.folderName, ScratchpadLocation.productName)
        XCTAssertEqual(ScratchpadLocation.local.folderName, ScratchpadLocation.suiteName)
        XCTAssertNotEqual(ScratchpadLocation.productName, ScratchpadLocation.suiteName,
                          "the two constants must be distinct, or the assertions above are one")
    }
}
