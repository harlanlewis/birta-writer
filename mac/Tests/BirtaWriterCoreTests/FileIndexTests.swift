import XCTest
@testable import BirtaWriterCore

/// The Go to File index over a temp tree this test builds and removes.
final class FileIndexTests: XCTestCase {
    private var root: URL!
    private let accepts: (URL) -> Bool = { ["md", "markdown", "mdx"].contains($0.pathExtension.lowercased()) }

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("file-index-\(UUID().uuidString)", isDirectory: true)
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("deep/deeper"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent(".git/objects"), withIntermediateDirectories: true)
        for name in ["top.md", "deep/mid.md", "deep/deeper/bottom.md", "deep/photo.png", ".git/objects/x.md", "deep/.draft.md"] {
            try Data("x".utf8).write(to: root.appendingPathComponent(name))
        }
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    func testTheIndexShouldHoldEveryOpenableFileAtEveryDepthAsARootRelativePath() {
        let index = FileIndex.build(root: root, accepts: accepts)
        XCTAssertEqual(Set(index.paths), ["top.md", "deep/mid.md", "deep/deeper/bottom.md"])
        XCTAssertFalse(index.truncated)
    }

    func testHiddenEntriesAndWhatIsUnderThemShouldBeSkipped() {
        let paths = FileIndex.build(root: root, accepts: accepts).paths
        XCTAssertFalse(paths.contains { $0.hasPrefix(".git") }, "a hidden folder and everything under it")
        XCTAssertFalse(paths.contains("deep/.draft.md"), "a hidden file")
    }

    func testTheCapShouldKeepTheFirstFilesByPathAndSaySo() {
        let index = FileIndex.build(root: root, cap: 2, accepts: accepts)
        XCTAssertEqual(index.paths, ["deep/deeper/bottom.md", "deep/mid.md"],
                       "the cut is by path, so it is the same cut on every launch")
        XCTAssertTrue(index.truncated, "a partial list must not read as the whole folder")
    }

    /// The walk's order is the one thing that must not decide the list: the
    /// real enumerator happens to visit this fixture in an order that keeps
    /// the cut looking right, so the order is set by hand here, three ways.
    func testWhichFilesSurviveTheCapShouldNotDependOnTheWalkOrder() {
        let files = ["top.md", "deep/mid.md", "deep/deeper/bottom.md", "deep/photo.png"]
            .map { root.appendingPathComponent($0) }
        var seen: [[String]] = []
        for order in [files, files.reversed(), [files[2], files[0], files[3], files[1]]] {
            let index = FileIndex.build(root: root, cap: 2, accepts: accepts, walk: FixedWalk(order))
            XCTAssertTrue(index.truncated)
            seen.append(index.paths)
        }
        XCTAssertEqual(seen.count, 3, "every order was driven")
        XCTAssertEqual(Set(seen.map { $0 }).count, 1, "three orders, one list: \(seen)")
        XCTAssertEqual(seen[0], ["deep/deeper/bottom.md", "deep/mid.md"])
    }

    func testAMissingRootShouldBeAnEmptyIndexRatherThanACrash() {
        let index = FileIndex.build(root: root.appendingPathComponent("nope"), accepts: accepts)
        XCTAssertEqual(index, .empty)
    }
}
