import XCTest
@testable import BirtaWriterCore

/// Link and path completion for this host, mirroring the extension's cases
/// in `linkTargetSuggestions.test.ts`, `linkTargetSuggest.test.ts` and
/// `suggestionProviders`'s path completion.
final class LinkSuggestionsTests: XCTestCase {
    private let root = "/vault"
    private let doc = "/vault/notes/today.md"
    private let files = ["/vault/notes/today.md",
                         "/vault/notes/Plan.md",
                         "/vault/Daily/2025-04-10.md",
                         "/vault/assets/diagram.png",
                         "/vault/Plan notes.markdown"]

    func testEveryFileButTheNoteShouldBeOfferedInBothForms() {
        let items = LinkSuggestions.targets(files: files, doc: doc, root: root)
        XCTAssertFalse(items.contains { $0.rootRelative == "/notes/today.md" })
        XCTAssertTrue(items.contains(.init(relative: "Plan.md", rootRelative: "/notes/Plan.md")))
        XCTAssertTrue(items.contains(.init(relative: "../Daily/2025-04-10.md", rootRelative: "/Daily/2025-04-10.md")))
        XCTAssertEqual(items.count, files.count - 1)
    }

    func testAFileOutsideTheRootShouldNotBeOffered() {
        XCTAssertTrue(LinkSuggestions.targets(files: ["/elsewhere/x.md"], doc: doc, root: root).isEmpty)
    }

    /// The extension's own answers for these inputs, recorded by running
    /// `buildLinkTargetItems` and `rankLinkTargets` over the same files: the
    /// port is held to them case for case.
    func testRankingShouldMatchTheExtensionsAnswersForTheSameFiles() {
        let recorded: [(String, [String])] = [
            ("plan", ["/notes/Plan.md", "/Plan notes.markdown"]),
            ("", ["/notes/Plan.md", "/Daily/2025-04-10.md", "/Plan notes.markdown", "/assets/diagram.png"]),
            ("../daily", ["/Daily/2025-04-10.md"]),
            ("/daily", ["/Daily/2025-04-10.md"]),
            ("Plan.md", []),
            ("./Plan", ["/notes/Plan.md", "/Plan notes.markdown"]),
        ]
        for (query, expected) in recorded {
            XCTAssertEqual(LinkSuggestions.linkTargets(query: query, files: files, doc: doc, root: root).map(\.rootRelative),
                           expected, "query \(query.debugDescription)")
        }
    }

    func testAUrlOrAnAnchorShouldGetNothing() {
        for q in ["https://example.com", "mailto:a@b.c", "#heading", "vscode:x"] {
            XCTAssertTrue(LinkSuggestions.linkTargets(query: q, files: files, doc: doc, root: root).isEmpty, q)
        }
        XCTAssertTrue(LinkSuggestions.isLocalPathQuery("notes/a.md"))
        XCTAssertTrue(LinkSuggestions.isLocalPathQuery("C++ notes.md"), "a colon-free name with + is a path")
    }

    func testTheRankingShouldBeCappedAtTwenty() {
        let many = (0..<40).map { "/vault/n\($0).md" }
        XCTAssertEqual(LinkSuggestions.linkTargets(query: "", files: many, doc: doc, root: root).count, 20)
    }

    // MARK: path completion

    private func lister(_ tree: [String: [(String, Bool)]]) -> (String) -> [(name: String, isDir: Bool)]? {
        { dir in tree[dir].map { $0.map { (name: $0.0, isDir: $0.1) } } }
    }

    func testAPathShouldOfferTheNamedFoldersChildrenFoldersFirst() {
        let list = lister(["/vault/notes": [("plan.md", false), ("archive", true), ("pic.png", false), (".DS_Store", false)]])
        let items = LinkSuggestions.pathItems(query: "./", docDir: "/vault/notes", root: root, list: list)
        XCTAssertEqual(items.map(\.path), ["./archive/", "./pic.png", "./plan.md"])
        XCTAssertEqual(items.first?.isDir, true)
    }

    func testANamePrefixShouldFilterInAnyCaseAndDropAnExactFile() {
        let list = lister(["/vault/notes": [("Plan.md", false), ("plank.md", false), ("Plans", true), ("other.md", false)]])
        XCTAssertEqual(LinkSuggestions.pathItems(query: "pl", docDir: "/vault/notes", root: root, list: list).map(\.path),
                       ["Plans/", "Plan.md", "plank.md"])
        XCTAssertEqual(LinkSuggestions.pathItems(query: "plan.md", docDir: "/vault/notes", root: root, list: list).map(\.path),
                       [])
    }

    func testParentAndRootPrefixesShouldResolveFromTheNoteAndTheRoot() {
        let list = lister(["/vault": [("Daily", true)], "/vault/assets": [("a.png", false)]])
        XCTAssertEqual(LinkSuggestions.pathItems(query: "../D", docDir: "/vault/notes", root: root, list: list).map(\.path),
                       ["../Daily/"])
        XCTAssertEqual(LinkSuggestions.pathItems(query: "@/assets/", docDir: "/vault/notes", root: root, list: list).map(\.path),
                       ["@/assets/a.png"])
    }

    func testAnEmptyQueryOrAnUnreadableFolderShouldOfferNothing() {
        let list = lister([:])
        XCTAssertTrue(LinkSuggestions.pathItems(query: "", docDir: "/vault/notes", root: root, list: list).isEmpty)
        XCTAssertTrue(LinkSuggestions.pathItems(query: "missing/", docDir: "/vault/notes", root: root, list: list).isEmpty)
    }

    func testRelativeShouldClimbOutOfTheNotesFolderAsPathRelativeDoes() {
        XCTAssertEqual(LinkSuggestions.relative(from: "/vault/notes", to: "/vault/Daily/x.md"), "../Daily/x.md")
        XCTAssertEqual(LinkSuggestions.relative(from: "/vault/notes", to: "/vault/notes/sub/x.md"), "sub/x.md")
        XCTAssertEqual(LinkSuggestions.relative(from: "/a/b/c", to: "/x.md"), "../../../x.md")
    }
}
