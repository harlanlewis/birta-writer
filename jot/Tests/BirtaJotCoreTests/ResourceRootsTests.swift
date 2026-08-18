import XCTest
@testable import BirtaJotCore

final class ResourceRootsTests: XCTestCase {
    private var dir: URL!
    private var bundle: URL!
    private var docDir: URL!
    private var roots: ResourceRoots!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("jot-roots-\(UUID().uuidString)")
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
}
