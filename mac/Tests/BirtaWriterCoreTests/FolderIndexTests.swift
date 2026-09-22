import XCTest
@testable import BirtaWriterCore

/// The folder edge index over a temp tree this test builds and removes: the
/// three kinds of reference, the ways one dangles, the cap and its flag, and
/// what a rebuild re-reads.
final class FolderIndexTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("folder-index-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("Vault", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root.deletingLastPathComponent())
        try super.tearDownWithError()
    }

    private func write(_ rel: String, _ text: String) throws {
        let url = root.appendingPathComponent(rel)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }

    private func edges(_ index: FolderIndex, from: String) -> [FolderIndex.Edge] {
        index.edges.filter { $0.from == from }
    }

    func testAllThreeKindsOfReferenceShouldBecomeEdgesBetweenNotes() throws {
        try write("hub.md", """
        ---
        title: The Hub
        type: concept
        tags: [a, b]
        sources:
          - resource: notes/origin.md
            title: Where it came from
        ---
        See [the spoke](notes/spoke.md) and [[Spoke]].
        """)
        try write("notes/spoke.md", "Back to [[hub]].\n")
        try write("notes/origin.md", "# Origin\n")
        let index = FolderIndexer(root: root).build()

        XCTAssertEqual(index.rootName, "Vault")
        XCTAssertEqual(index.nodes.map(\.path), ["hub.md", "notes/origin.md", "notes/spoke.md"])
        let hub = try XCTUnwrap(index.nodes.first { $0.path == "hub.md" })
        XCTAssertEqual(hub.name, "The Hub", "the frontmatter title names the node")
        XCTAssertEqual(hub.type, "concept")
        XCTAssertEqual(hub.tags, ["a", "b"])
        XCTAssertEqual(index.nodes.first { $0.path == "notes/spoke.md" }?.name, "spoke", "no title: the file name")

        let out = edges(index, from: "hub.md")
        XCTAssertEqual(out.map(\.kind), [.source, .link, .wiki])
        XCTAssertEqual(out.map(\.to), ["notes/origin.md", "notes/spoke.md", "notes/spoke.md"])
        XCTAssertEqual(out.map(\.line), [6, 9, 9])
        XCTAssertEqual(out[0].text, "Where it came from")
        XCTAssertEqual(edges(index, from: "notes/spoke.md").first?.to, "hub.md", "a wikilink matches a name case-insensitively")
        XCTAssertFalse(index.truncated)
    }

    func testAReferenceThatResolvesToNoNoteShouldDangleAndOneToAnotherFileShouldBeDropped() throws {
        try write("a.md", """
        [gone](missing.md) [[Nobody]] [above](../outside.md) [pic](img/p.png) [site](https://example.com) [here](#top)
        """)
        try write("img/p.png", "")
        let index = FolderIndexer(root: root).build()
        let out = edges(index, from: "a.md")
        XCTAssertEqual(out.map(\.target), ["missing.md", "Nobody", "../outside.md"],
                       "the image is not a note, and a URL or a fragment is not a reference at all")
        XCTAssertEqual(out.map(\.to), [nil, nil, nil], "kept, with nothing to point at")
    }

    func testTheCapShouldStopTheWalkAndSaySoAndExactlyTheCapShouldNot() throws {
        for i in 0..<4 { try write("n\(i).md", "[[n3]]\n") }
        let exact = FolderIndexer(root: root, cap: 4).build()
        XCTAssertEqual(exact.nodes.count, 4)
        XCTAssertFalse(exact.truncated, "a folder holding exactly the cap is complete")

        let cut = FolderIndexer(root: root, cap: 3).build()
        XCTAssertEqual(cut.nodes.count, 3)
        XCTAssertTrue(cut.truncated)
        // A note past the cap is not in the index, so a reference to it
        // cannot land on it: it dangles rather than pointing outside the nodes.
        let nodePaths = Set(cut.nodes.map(\.path))
        XCTAssertTrue(cut.edges.allSatisfy { $0.to.map(nodePaths.contains) ?? true })
    }

    func testANoteThatCannotBeReadShouldStayANodeWithNoReferences() throws {
        try write("ok.md", "[[broken]]\n")
        try write("broken.md", "[[ok]]\n")
        let index = FolderIndexer(root: root, read: { $0.hasSuffix("broken.md") ? nil : try? String(contentsOfFile: $0, encoding: .utf8) }).build()
        XCTAssertEqual(index.nodes.map(\.name), ["broken", "ok"])
        XCTAssertEqual(index.edges.map(\.from), ["ok.md"])
        XCTAssertEqual(index.edges.first?.to, "broken.md")
    }

    func testARebuildShouldReReadOnlyTheNoteThatChanged() throws {
        try write("a.md", "[[b]]\n")
        try write("b.md", "plain\n")
        try write("c.md", "plain\n")
        let indexer = FolderIndexer(root: root)
        _ = indexer.build()
        XCTAssertEqual(indexer.lastReadCount, 3)
        _ = indexer.build()
        XCTAssertEqual(indexer.lastReadCount, 0, "nothing changed, nothing read")

        try write("c.md", "now [[a]], and longer\n")
        let index = indexer.build()
        XCTAssertEqual(indexer.lastReadCount, 1)
        XCTAssertEqual(edges(index, from: "c.md").first?.to, "a.md", "the changed note's reading is the new one")
    }

    func testANoteCreatedLaterShouldResolveTheReferenceThatWasWaitingForIt() throws {
        try write("a.md", "[[Later]] and [l](later.md)\n")
        let indexer = FolderIndexer(root: root)
        XCTAssertEqual(edges(indexer.build(), from: "a.md").map(\.to), [nil, nil])
        try write("later.md", "here now\n")
        XCTAssertEqual(edges(indexer.build(), from: "a.md").map(\.to), ["later.md", "later.md"],
                       "a new file empties the resolutions the old list made")
    }

    func testHiddenFoldersShouldNotBeWalked() throws {
        try write(".obsidian/x.md", "[[a]]\n")
        try write("a.md", "a\n")
        XCTAssertEqual(FolderIndexer(root: root).build().nodes.map(\.path), ["a.md"])
    }

    func testDependenciesShouldNotBeWalkedAtAnyDepth() throws {
        try write("node_modules/pkg/README.md", "[[a]]\n")
        try write("web/node_modules/other/CHANGELOG.md", "x\n")
        try write("web/notes.md", "n\n")
        try write("a.md", "a\n")
        XCTAssertEqual(FolderIndexer(root: root).build().nodes.map(\.path), ["a.md", "web/notes.md"])
    }

    func testTheWireFormShouldCarryEveryFieldTheTypeScriptTypeDeclares() throws {
        try write("a.md", "---\nstatus: draft\n---\n[[b]]\n")
        let index = FolderIndexer(root: root).build()
        let json = index.jsonObject
        XCTAssertEqual(Set(json.keys), ["rootName", "nodes", "edges", "truncated"])
        let node = try XCTUnwrap((json["nodes"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(node.keys), ["path", "name", "type", "tags", "status", "trust", "staleAfter"])
        XCTAssertEqual(node["status"] as? String, "draft")
        XCTAssertTrue(node["type"] is NSNull, "an absent field is null, not missing")
        let edge = try XCTUnwrap((json["edges"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(edge.keys), ["from", "to", "target", "kind", "text", "line"])
        XCTAssertTrue(edge["to"] is NSNull)
        XCTAssertEqual(edge["kind"] as? String, "wiki")
        XCTAssertTrue(JSONSerialization.isValidJSONObject(json))
    }

    func testAFileShouldBeNamedByItsIndexPathOnlyWhenTheIndexHoldsIt() throws {
        try write("sub/a.md", "a\n")
        try write("sub/b.txt", "b\n")
        let index = FolderIndexer(root: root).build()
        XCTAssertEqual(index.path(of: root.appendingPathComponent("sub/a.md"), root: root), "sub/a.md")
        XCTAssertNil(index.path(of: root.appendingPathComponent("sub/b.txt"), root: root))
    }
}
