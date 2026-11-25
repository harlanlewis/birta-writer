import XCTest
@testable import BirtaWriterCore

final class ResourceRootsTests: XCTestCase {
    private var dir: URL!
    private var bundle: URL!
    private var docDir: URL!
    private var roots: ResourceRoots!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("mac-roots-\(UUID().uuidString)")
        bundle = dir.appendingPathComponent("web")
        docDir = dir.appendingPathComponent("notes")
        for d in [bundle!, docDir!, docDir.appendingPathComponent("Attachments")] {
            try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        }
        try Data("page".utf8).write(to: bundle.appendingPathComponent("index.html"))
        try Data("img".utf8).write(to: docDir.appendingPathComponent("Attachments/a.png"))
        try Data("secret".utf8).write(to: dir.appendingPathComponent("secret.txt"))
        roots = ResourceRoots(bundle: bundle, document: docDir)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testServesTheBundle() throws {
        XCTAssertEqual(roots.resolve("/index.html")?.lastPathComponent, "index.html")
    }

    func testServesAnAttachmentBesideTheDocument() throws {
        XCTAssertEqual(roots.resolve("/Attachments/a.png")?.lastPathComponent, "a.png")
    }

    func testRefusesATraversalOutOfTheDocumentFolder() throws {
        XCTAssertNil(roots.resolve("/../secret.txt"))
        XCTAssertNil(roots.resolve("/Attachments/../../secret.txt"))
    }

    func testRefusesAFileThatIsSimplyNotThere() throws {
        XCTAssertNil(roots.resolve("/Attachments/missing.png"))
    }

    func testRefusesAnEmptyPath() throws {
        XCTAssertNil(roots.resolve("/"))
        XCTAssertNil(roots.resolve(""))
    }

    func testRefusesASymlinkOutOfTheRoot() throws {
        // The traversal check is about the path; this is about the file system.
        // A document folder containing a link to somewhere else must not turn
        // the page into a reader of that somewhere else.
        try FileManager.default.createSymbolicLink(
            at: docDir.appendingPathComponent("escape.txt"),
            withDestinationURL: dir.appendingPathComponent("secret.txt"))

        XCTAssertNil(roots.resolve("/escape.txt"))
    }

    func testTheBundleWinsOverTheDocumentFolder() throws {
        // A document folder that happens to hold an index.html cannot shadow
        // the page itself.
        try Data("not the page".utf8).write(to: docDir.appendingPathComponent("index.html"))

        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(roots.resolve("/index.html"))), Data("page".utf8))
    }

    func testWithNoDocumentOnlyTheBundleServes() throws {
        let bundleOnly = ResourceRoots(bundle: bundle, document: nil)

        XCTAssertNotNil(bundleOnly.resolve("/index.html"))
        XCTAssertNil(bundleOnly.resolve("/Attachments/a.png"))
    }

    func testReboundFollowsTheDocument() throws {
        let elsewhere = dir.appendingPathComponent("other")
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        try Data("other".utf8).write(to: elsewhere.appendingPathComponent("b.png"))

        let moved = roots.rebound(toDocument: elsewhere)

        XCTAssertNotNil(moved.resolve("/b.png"))
        XCTAssertNil(moved.resolve("/Attachments/a.png"), "the old document's folder is no longer served")
    }

    func testARootedWindowServesTheImageBesideANoteInASubfolder() throws {
        let note = docDir.appendingPathComponent("write/post")
        try FileManager.default.createDirectory(at: note, withIntermediateDirectories: true)
        try Data("shot".utf8).write(to: note.appendingPathComponent("shot.webp"))
        let rooted = ResourceRoots(bundle: bundle, document: note, project: docDir)

        XCTAssertEqual(rooted.resolve("/shot.webp")?.lastPathComponent, "shot.webp")
        // Root-relative references still resolve through the project root.
        XCTAssertEqual(rooted.resolve("/Attachments/a.png")?.lastPathComponent, "a.png")
        XCTAssertNil(rooted.resolve("/../secret.txt"))
    }

    func testTheNotesFolderWinsOverTheProjectRoot() throws {
        let note = docDir.appendingPathComponent("post")
        try FileManager.default.createDirectory(at: note.appendingPathComponent("Attachments"), withIntermediateDirectories: true)
        try Data("beside".utf8).write(to: note.appendingPathComponent("Attachments/a.png"))
        let rooted = ResourceRoots(bundle: bundle, document: note, project: docDir)

        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(rooted.resolve("/Attachments/a.png"))), Data("beside".utf8))
    }

    func testReboundKeepsTheProjectRoot() throws {
        let note = docDir.appendingPathComponent("post")
        try FileManager.default.createDirectory(at: note, withIntermediateDirectories: true)
        let rooted = ResourceRoots(bundle: bundle, document: docDir, project: docDir)

        let moved = rooted.rebound(toDocument: note)
        XCTAssertEqual(moved.project, docDir)
        XCTAssertEqual(moved.resolve("/Attachments/a.png")?.lastPathComponent, "a.png", "root-relative images survive a rebind")
    }

    // MARK: the document namespace

    private let origin = URL(string: "birta://app/index.html")!

    /// A rooted window over `docDir` with the note in `write/post`, an image
    /// beside it and one in a sibling folder.
    private func rootedOverSubfolder() throws -> ResourceRoots {
        let fm = FileManager.default
        try fm.createDirectory(at: docDir.appendingPathComponent("write/post"), withIntermediateDirectories: true)
        try fm.createDirectory(at: docDir.appendingPathComponent("write/shared"), withIntermediateDirectories: true)
        try Data("beside".utf8).write(to: docDir.appendingPathComponent("write/post/shot.webp"))
        try Data("sibling".utf8).write(to: docDir.appendingPathComponent("write/shared/b.png"))
        return ResourceRoots(bundle: bundle, document: docDir.appendingPathComponent("write/post"), project: docDir)
    }

    func testTheBaseOfANoteBelowTheRootNamesItsFolderFromTheRoot() throws {
        let rooted = try rootedOverSubfolder()
        XCTAssertEqual(rooted.documentBase(origin: origin),
                       DocumentBase(url: "birta://app/~doc/write/post/", scope: "birta://app/~doc/"))
    }

    func testTheBaseOfALooseNoteIsTheNamespaceItself() throws {
        XCTAssertEqual(roots.documentBase(origin: origin),
                       DocumentBase(url: "birta://app/~doc/", scope: "birta://app/~doc/"))
        XCTAssertNil(ResourceRoots(bundle: bundle, document: nil).documentBase(origin: origin))
    }

    func testTheBaseOfANoteOutsideTheRootIsItsOwnFolder() throws {
        let outside = dir.appendingPathComponent("elsewhere")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try Data("o".utf8).write(to: outside.appendingPathComponent("o.png"))
        let rooted = ResourceRoots(bundle: bundle, document: outside, project: docDir)
        XCTAssertEqual(rooted.documentBase(origin: origin)?.url, "birta://app/~doc/")
        XCTAssertEqual(rooted.resolve("/~doc/o.png")?.lastPathComponent, "o.png")
        XCTAssertNil(rooted.resolve("/~doc/Attachments/a.png"), "the root is not this note's scope")
    }

    func testAFolderNameIsPercentEncodedInTheBase() throws {
        let spaced = docDir.appendingPathComponent("my notes/ä")
        try FileManager.default.createDirectory(at: spaced, withIntermediateDirectories: true)
        let rooted = ResourceRoots(bundle: bundle, document: spaced, project: docDir)
        try Data("s".utf8).write(to: spaced.appendingPathComponent("s.png"))
        // The round trip the page and the handler make: a URL built on the
        // base, asked for by its decoded path (`URL.path`), names the file.
        // Asserted as a round trip because the file system hands the name
        // back in its own Unicode normalization.
        let base = try XCTUnwrap(rooted.documentBase(origin: origin)?.url)
        XCTAssertTrue(base.hasPrefix("birta://app/~doc/my%20notes/"), base)
        let request = try XCTUnwrap(URL(string: "s.png", relativeTo: URL(string: base)))
        XCTAssertEqual(rooted.resolve(request.path)?.lastPathComponent, "s.png")
    }

    func testANamespacePathBesideTheNoteResolves() throws {
        let rooted = try rootedOverSubfolder()
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(rooted.resolve("/~doc/write/post/shot.webp"))), Data("beside".utf8))
    }

    func testANamespacePathThatClimbedToASiblingFolderResolves() throws {
        // `../shared/b.png` from write/post, as the page resolved it.
        let rooted = try rootedOverSubfolder()
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(rooted.resolve("/~doc/write/shared/b.png"))), Data("sibling".utf8))
    }

    func testAPathWrittenRelativeToTheRootStillResolvesFromASubfolderNote() throws {
        // `Attachments/a.png` from write/post: nothing there, so the part
        // below the note's folder is tried against the root.
        let rooted = try rootedOverSubfolder()
        XCTAssertEqual(rooted.resolve("/~doc/write/post/Attachments/a.png")?.lastPathComponent, "a.png")
    }

    func testTheNamespaceIsNeverAnsweredFromTheBundleOrOutsideTheScope() throws {
        let rooted = try rootedOverSubfolder()
        XCTAssertNil(rooted.resolve("/~doc/index.html"), "the bundle is not a document root")
        XCTAssertNil(rooted.resolve("/~doc/../secret.txt"))
        XCTAssertNil(rooted.resolve("/~doc/"))
        XCTAssertNil(ResourceRoots(bundle: bundle, document: nil).resolve("/~doc/a.png"))
    }

    func testANamespacePathThroughASymlinkOutOfTheRootIsRefused() throws {
        let rooted = try rootedOverSubfolder()
        try FileManager.default.createSymbolicLink(at: docDir.appendingPathComponent("write/post/out"),
                                                   withDestinationURL: dir)
        XCTAssertNil(rooted.resolve("/~doc/write/post/out/secret.txt"))
    }

    func testARootSpelledInAnotherCaseStillHoldsTheNote() throws {
        // APFS's default is case-insensitive; a volume that is not cannot
        // spell the root this way at all, so there is nothing to assert there.
        let respelled = URL(fileURLWithPath: docDir.path.replacingOccurrences(of: "/notes", with: "/NOTES"))
        try XCTSkipUnless(FileManager.default.fileExists(atPath: respelled.path), "case-sensitive volume")
        try FileManager.default.createDirectory(at: docDir.appendingPathComponent("write/post"), withIntermediateDirectories: true)
        let fresh = ResourceRoots(bundle: bundle, document: docDir.appendingPathComponent("write/post"), project: respelled)
        XCTAssertEqual(fresh.documentBase(origin: origin)?.url, "birta://app/~doc/write/post/")
        XCTAssertEqual(fresh.resolve("/~doc/write/post/Attachments/a.png")?.lastPathComponent, "a.png",
                       "the root-relative fallback holds through the other spelling")
    }

    func testAFolderNotUnderTheRootIsNotInIt() throws {
        // A sibling whose name starts with the root's is outside it: the walk
        // compares folders, not string prefixes.
        let sibling = dir.appendingPathComponent("notes-archive")
        try FileManager.default.createDirectory(at: sibling, withIntermediateDirectories: true)
        XCTAssertNil(ResourceRoots.path(of: sibling, below: docDir))
        XCTAssertEqual(ResourceRoots.path(of: docDir, below: docDir), "")
        XCTAssertNil(ResourceRoots.path(of: docDir, below: dir.appendingPathComponent("missing")))
    }
}
