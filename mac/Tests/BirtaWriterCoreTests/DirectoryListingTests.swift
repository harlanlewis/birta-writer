import XCTest
@testable import BirtaWriterCore

/// A folder as the page is told about it, over a temp tree this test builds
/// and removes, and the root questions the routing asks.
final class DirectoryListingTests: XCTestCase {
    private var root: URL!
    private let accepts: (URL) -> Bool = { ["md", "markdown", "mdx"].contains($0.pathExtension.lowercased()) }

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("directory-listing-\(UUID().uuidString)", isDirectory: true)
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("zeta"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent("alpha"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent(".git"), withIntermediateDirectories: true)
        for name in ["note 10.md", "note 2.md", "Readme.MD", "photo.png", ".hidden.md", "alpha/inner.md"] {
            try Data("x".utf8).write(to: root.appendingPathComponent(name))
        }
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    // MARK: entries

    func testEntriesShouldListFoldersFirstThenFilesInFinderOrder() throws {
        let entries = try DirectoryListing.entries(of: root, accepts: accepts)
        XCTAssertEqual(entries.map(\.name),
                       [".git", "alpha", "zeta", ".hidden.md", "note 2.md", "note 10.md", "photo.png", "Readme.MD"],
                       "folders first, dotfolder among them; 'note 2' before 'note 10'; case-insensitive")
        XCTAssertEqual(entries.count, 8, "the enumeration reached the whole folder")
    }

    func testEntriesShouldMarkWhatOpensAndWhatIsHidden() throws {
        let entries = try DirectoryListing.entries(of: root, accepts: accepts)
        let byName = Dictionary(uniqueKeysWithValues: entries.map { ($0.name, $0) })
        XCTAssertEqual(byName["alpha"]?.kind, .dir)
        XCTAssertFalse(byName["alpha"]!.openable, "a folder is opened by the tree, not the editor")
        XCTAssertTrue(byName["Readme.MD"]!.openable, "case-insensitive, as the Finder hands it over")
        XCTAssertFalse(byName["photo.png"]!.openable, "listed, not openable")
        XCTAssertTrue(byName[".hidden.md"]!.hidden)
        XCTAssertTrue(byName[".git"]!.hidden)
        XCTAssertFalse(byName["note 2.md"]!.hidden)
    }

    func testEntriesShouldListOneLevelOnly() throws {
        let names = try DirectoryListing.entries(of: root, accepts: accepts).map(\.name)
        XCTAssertFalse(names.contains("inner.md"), "a listing never walks into a subfolder")
    }

    func testAMissingFolderShouldThrowRatherThanListNothing() {
        XCTAssertThrowsError(try DirectoryListing.entries(of: root.appendingPathComponent("nope"), accepts: accepts))
    }

    func testEntryJSONShouldCarryTheFourFieldsThePageReads() {
        let json = DirectoryListing.Entry(name: "a.md", kind: .file, openable: true, hidden: false).jsonObject
        XCTAssertEqual(json["name"] as? String, "a.md")
        XCTAssertEqual(json["kind"] as? String, "file")
        XCTAssertEqual(json["openable"] as? Bool, true)
        XCTAssertEqual(json["hidden"] as? Bool, false)
    }

    // MARK: paths against the root

    func testIsInsideShouldRefuseASiblingWhoseNameSharesThePrefix() throws {
        let sibling = URL(fileURLWithPath: root.path + "-archive/x.md")
        XCTAssertFalse(DirectoryListing.isInside(sibling, root: root))
        XCTAssertTrue(DirectoryListing.isInside(root.appendingPathComponent("alpha/inner.md"), root: root))
    }

    func testRelativePathShouldBePosixAndRootRelative() {
        XCTAssertEqual(DirectoryListing.relativePath(of: root.appendingPathComponent("alpha/inner.md"), in: root),
                       "alpha/inner.md")
        XCTAssertNil(DirectoryListing.relativePath(of: URL(fileURLWithPath: "/elsewhere/x.md"), in: root))
    }

    /// A change IN the root arrives from the watcher as the root's own path,
    /// spelled with a trailing slash and through `/private`; it has to come
    /// back as `""`, the page's name for the root, or the page is never told
    /// its top level changed.
    func testTheRootItselfShouldBeTheEmptyPath() {
        XCTAssertEqual(DirectoryListing.relativePath(of: root, in: root), "")
        let withSlash = URL(fileURLWithPath: root.path + "/", isDirectory: true)
        XCTAssertEqual(DirectoryListing.relativePath(of: withSlash, in: root), "")
        let viaPrivate = URL(fileURLWithPath: "/private" + root.resolvingSymlinksInPath().path
                                .replacingOccurrences(of: "/private", with: ""), isDirectory: true)
        XCTAssertEqual(DirectoryListing.relativePath(of: viaPrivate, in: root), "")
    }

    func testResolveShouldRefuseAnythingThatLeavesTheRoot() {
        XCTAssertEqual(DirectoryListing.resolve("", in: root)?.standardizedFileURL, root.standardizedFileURL)
        XCTAssertEqual(DirectoryListing.resolve("alpha/inner.md", in: root)?.lastPathComponent, "inner.md")
        XCTAssertNil(DirectoryListing.resolve("../x.md", in: root))
        XCTAssertNil(DirectoryListing.resolve("alpha/../../x.md", in: root))
        XCTAssertNil(DirectoryListing.resolve("/etc/passwd", in: root))
    }

    func testResolveShouldRefuseALinkThatPointsOutOfTheRoot() throws {
        let outside = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("outside-\(UUID().uuidString).md")
        try Data("o".utf8).write(to: outside)
        defer { try? FileManager.default.removeItem(at: outside) }
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("link.md"), withDestinationURL: outside)
        XCTAssertNil(DirectoryListing.resolve("link.md", in: root), "a link out of the root is a path out of the root")
    }

    // MARK: the first file

    func testTheFirstFileShouldBeTheMostRecentInsideTheRoot() {
        let inside = root.appendingPathComponent("alpha/inner.md")
        let elsewhere = URL(fileURLWithPath: "/elsewhere/newer.md")
        XCTAssertEqual(DirectoryListing.firstToOpen(in: root, recents: [elsewhere, inside], accepts: accepts), inside,
                       "a recent outside the root does not count, however recent")
    }

    func testARecentTheCallerRefusesShouldGiveWayToTheNextCandidate() throws {
        // `WindowSet.openDirectory` refuses a file open in another window
        // through `accepts`; the rule then falls to the next recent, then to
        // the newest at the top, then to nil, and never back to the refused one.
        let open = root.appendingPathComponent("alpha/inner.md")
        let next = root.appendingPathComponent("note 2.md")
        let accepts = self.accepts
        let refusing: (URL) -> Bool = { accepts($0) && $0.lastPathComponent != "inner.md" }
        XCTAssertEqual(DirectoryListing.firstToOpen(in: root, recents: [open, next], accepts: refusing), next)
        let atTop = DirectoryListing.firstToOpen(in: root, recents: [open], accepts: refusing)
        XCTAssertNotNil(atTop)
        XCTAssertNotEqual(atTop, open)
        XCTAssertNil(DirectoryListing.firstToOpen(in: root, recents: [open], accepts: { _ in false }),
                     "with every file refused the folder gets a new note instead")
    }

    func testWithNoRecentInsideTheFirstFileShouldBeTheNewestOpenableAtTheTop() throws {
        let newest = root.appendingPathComponent("note 2.md")
        try FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: newest.path)
        for other in ["note 10.md", "Readme.MD"] {
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -3600)],
                                                  ofItemAtPath: root.appendingPathComponent(other).path)
        }
        XCTAssertEqual(DirectoryListing.firstToOpen(in: root, recents: [], accepts: accepts)?.lastPathComponent,
                       "note 2.md")
    }

    /// The caller's `accepts` stats every open window's file per call, so it is
    /// asked newest-first and only until one passes, never of the whole folder.
    func testAcceptsShouldBeAskedOnlyUntilTheNewestOpenableIsFound() throws {
        let flat = root.appendingPathComponent("zeta")
        let fm = FileManager.default
        for i in 0..<50 {
            let file = flat.appendingPathComponent("n\(i).md")
            try Data("x".utf8).write(to: file)
            try fm.setAttributes([.modificationDate: Date(timeIntervalSinceNow: Double(-3600 - i))], ofItemAtPath: file.path)
        }
        let newest = flat.appendingPathComponent("newest.md")
        try Data("x".utf8).write(to: newest)
        try fm.setAttributes([.modificationDate: Date()], ofItemAtPath: newest.path)
        var asked = 0
        let counting: (URL) -> Bool = { [accepts] url in asked += 1; return accepts(url) }
        XCTAssertEqual(DirectoryListing.firstToOpen(in: flat, recents: [], accepts: counting)?.lastPathComponent, "newest.md")
        XCTAssertEqual(asked, 1, "a folder of 51 candidates asked its newest alone")

        asked = 0
        let refusingNewest: (URL) -> Bool = { url in asked += 1; return url.lastPathComponent != "newest.md" }
        XCTAssertEqual(DirectoryListing.firstToOpen(in: flat, recents: [], accepts: refusingNewest)?.lastPathComponent, "n0.md",
                       "a refused newest falls to the next newest, not to an arbitrary file")
        XCTAssertEqual(asked, 2)
    }

    func testAFolderWithNothingOpenableShouldAnswerNil() throws {
        let empty = root.appendingPathComponent("zeta")
        XCTAssertNil(DirectoryListing.firstToOpen(in: empty, recents: [], accepts: accepts))
    }

    // MARK: itemCount

    func testItemCountShouldCountEveryEntryAtAnyDepthHiddenIncluded() {
        // zeta, alpha, .git, five files at the top and alpha/inner.md.
        let counted = DirectoryListing.itemCount(in: root)
        XCTAssertEqual(counted.items, 9)
        XCTAssertFalse(counted.capped)
    }

    func testItemCountShouldLeaveOutTheFindersOwnFileAndCountAPackageOnce() throws {
        let fm = FileManager.default
        try Data().write(to: root.appendingPathComponent(".DS_Store"))
        try Data().write(to: root.appendingPathComponent("alpha/.DS_Store"))
        let package = root.appendingPathComponent("Tool.app/Contents", isDirectory: true)
        try fm.createDirectory(at: package, withIntermediateDirectories: true)
        try Data().write(to: package.appendingPathComponent("Info.plist"))
        XCTAssertEqual(DirectoryListing.itemCount(in: root).items, 10)
    }

    func testItemCountShouldStopAtItsCapAndSaySo() {
        let counted = DirectoryListing.itemCount(in: root, cap: 4)
        XCTAssertEqual(counted.items, 4)
        XCTAssertTrue(counted.capped)
        XCTAssertFalse(DirectoryListing.itemCount(in: root, cap: 9).capped, "exactly the cap is the whole count")
    }

    func testAnEmptyFolderShouldCountNothing() {
        XCTAssertEqual(DirectoryListing.itemCount(in: root.appendingPathComponent("zeta")).items, 0)
    }
}
