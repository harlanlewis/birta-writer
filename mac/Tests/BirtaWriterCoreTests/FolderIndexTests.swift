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

    func testTheCapShouldCutTheIndexAndSaySoAndExactlyTheCapShouldNot() throws {
        for i in 0..<4 { try write("n\(i).md", "[[n3]]\n") }
        let exact = FolderIndexer(root: root, cap: 4).build()
        XCTAssertEqual(exact.nodes.count, 4)
        XCTAssertFalse(exact.truncated, "a folder holding exactly the cap is complete")

        let cut = FolderIndexer(root: root, cap: 3).build()
        XCTAssertEqual(cut.nodes.map(\.path), ["n0.md", "n1.md", "n2.md"], "the smallest by path survive the cut")
        XCTAssertTrue(cut.truncated)
        // A note past the cap is not in the index, so a reference to it
        // cannot land on it: it dangles rather than pointing outside the nodes.
        XCTAssertEqual(cut.edges.map(\.to), [nil, nil, nil])
    }

    func testANoteKeptPastTheCapShouldNotDependOnTheOrderTheWalkMetIt() throws {
        // Every note names the next by index, so the text is the same in
        // every order and only the walk differs; which notes survive decides
        // which edges resolve, so a cut by walk order would move both.
        let names = (0..<12).map { "n\($0).md" }
        for (i, name) in names.enumerated() { try write(name, "[[\(names[(i + 1) % names.count].dropLast(3))]]\n") }
        let urls = names.map { root.appendingPathComponent($0) }
        let orders = [urls, urls.reversed(), urls.shuffled()]
        XCTAssertNotEqual(orders[1], orders[0])
        let indexes = orders.map { order in FolderIndexer(root: root, cap: 5).build(walk: { _, _ in FixedWalk(order) }) }
        let smallest = names.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }.prefix(5)
        XCTAssertEqual(indexes[0].nodes.map(\.path), Array(smallest), "n10 and n11 outrank n2 by path, wherever the walk met them")
        XCTAssertTrue(indexes[0].truncated)
        XCTAssertEqual(indexes[1], indexes[0])
        XCTAssertEqual(indexes[2], indexes[0])
        // n2 names n3, which the cut left out: that edge dangles rather than
        // pointing at a node the index lacks; the rest land on kept notes.
        XCTAssertEqual(indexes[0].edges.map(\.to), ["n1.md", "n2.md", "n11.md", "n0.md", nil])
    }

    /// The other list the walk cuts: the files a reference resolves against.
    /// A reference to an image is dropped when the image is among them and
    /// kept dangling when it is not, so a cut taken in walk order would draw
    /// a different graph per launch above the file cap.
    func testWhichFilesAReferenceResolvesAgainstShouldNotDependOnTheWalkOrder() throws {
        let names = (0..<6).map { "n\($0).md" }
        for name in names { try write(name, "[z](z.png)\n") }
        try write("a.png", "x")
        try write("z.png", "x")
        let urls = (["a.png"] + names + ["z.png"]).map { root.appendingPathComponent($0) }
        let orders = [urls, urls.reversed(), urls.shuffled()]
        // Seven of eight files survive by path: z.png is the one cut, in every order.
        let indexes = orders.map { order in
            FolderIndexer(root: root, cap: 10, fileCap: 7).build(walk: { _, _ in FixedWalk(order) })
        }
        XCTAssertEqual(indexes.count, 3)
        XCTAssertEqual(indexes[0].edges.map(\.to), Array(repeating: nil, count: 6),
                       "z.png is past the file cap by path, so every reference to it dangles")
        XCTAssertEqual(indexes[1], indexes[0])
        XCTAssertEqual(indexes[2], indexes[0])
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

/// A walk that returns the files it was given, in the order it was given
/// them: what `FileManager.enumerator` promises nothing about, made a fact,
/// so a build can be asked the same folder in two orders.
final class FixedWalk: FileManager.DirectoryEnumerator {
    private var pending: [URL]

    init(_ urls: [URL]) {
        pending = urls.reversed()
        super.init()
    }

    override func nextObject() -> Any? { pending.popLast() }
    override func skipDescendants() {}
}

/// The bounded selection both producers cut a large folder with, held to
/// a whole sort: the order offered decides nothing, and the order compared
/// by is UTF-16 code units, which is what the extension's `sort` uses.
final class SmallestByPathTests: XCTestCase {
    private func select(_ paths: [String], cap: Int) -> (kept: [String], truncated: Bool) {
        var selection = SmallestByPath<Int>(cap: cap)
        for (i, path) in paths.enumerated() { selection.offer(path, i) }
        let (kept, truncated) = selection.finish()
        // The value rides with its path.
        XCTAssertTrue(kept.allSatisfy { paths[$0.value] == $0.path })
        return (kept.map(\.path), truncated)
    }

    private func sortedPrefix(_ paths: [String], _ cap: Int) -> [String] {
        Array(paths.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }.prefix(cap))
    }

    func testAnyOrderOfTheSamePathsShouldKeepTheCapSmallestSortedAsAWholeSortWould() {
        let cap = 7
        let paths = (0..<(5 * cap + 3)).map { "/v/\(String($0 &* 2654435761, radix: 36)).md" }
        let oracle = sortedPrefix(paths, cap)
        var orders = 0
        for _ in 0..<40 {
            let order = paths.shuffled()
            if order == paths { continue }
            orders += 1
            let (kept, truncated) = select(order, cap: cap)
            XCTAssertEqual(kept, oracle)
            XCTAssertTrue(truncated)
        }
        XCTAssertGreaterThan(orders, 30, "the shuffles reached orders other than the given one")
    }

    func testAListingAtTheCapShouldBeKeptWholeAndOnePastItByOneShouldBeCalledTruncated() {
        let paths = ["/v/c.md", "/v/a.md", "/v/b.md"]
        XCTAssertEqual(select(paths, cap: 3).kept, ["/v/a.md", "/v/b.md", "/v/c.md"])
        XCTAssertFalse(select(paths, cap: 3).truncated)
        XCTAssertEqual(select(paths, cap: 2).kept, ["/v/a.md", "/v/b.md"])
        XCTAssertTrue(select(paths, cap: 2).truncated)
        XCTAssertEqual(select([], cap: 2).kept, [])
        XCTAssertFalse(select([], cap: 2).truncated)
    }

    func testASmallerPathArrivingAfterTheBoundIsSetShouldStillDisplaceTheLargestKept() {
        // Past twice the cap the kept list is compacted and a bound taken;
        // what arrives after it is judged against the set, not refused late.
        let late = ["/v/z9.md", "/v/z8.md", "/v/z7.md", "/v/z6.md", "/v/z5.md", "/v/z4.md", "/v/a.md"]
        XCTAssertEqual(select(late, cap: 3).kept, ["/v/a.md", "/v/z4.md", "/v/z5.md"])
    }

    func testTheOrderShouldBeUTF16CodeUnitsAsTheExtensionSortsNotCodePointsOrALocale() {
        // U+1D49C is two code units, D835 DC9C, so it precedes U+FFFD by
        // code unit and follows it by code point; a locale puts "é" by "e".
        XCTAssertEqual(select(["/v/\u{FFFD}.md", "/v/\u{1D49C}.md"], cap: 1).kept, ["/v/\u{1D49C}.md"])
        XCTAssertEqual(select(["/v/\u{E9}.md", "/v/z.md"], cap: 1).kept, ["/v/z.md"])
    }
}
