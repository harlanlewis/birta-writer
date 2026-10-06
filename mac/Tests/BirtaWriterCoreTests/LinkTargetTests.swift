import XCTest
@testable import BirtaWriterCore

/// Following a link the page asked to open: the fragment split, the file the
/// link names, and the heading line it lands on.
final class LinkTargetTests: XCTestCase {
    // MARK: split

    func testAMarkdownLinkWithANumericFragmentShouldLandOnThatLine() {
        XCTAssertEqual(LinkTarget.split("notes/a.md#27", wiki: false), .init(path: "notes/a.md", line: 27))
        XCTAssertEqual(LinkTarget.split("a.md#27-30", wiki: false), .init(path: "a.md", line: 27))
    }

    func testAWikilinkFragmentShouldAlwaysBeAHeadingEvenWhenItIsDigits() {
        XCTAssertEqual(LinkTarget.split("Page#2024", wiki: true), .init(path: "Page", heading: "2024"))
    }

    func testANonNumericFragmentShouldBeAHeadingAndNoFragmentShouldBeNeither() {
        XCTAssertEqual(LinkTarget.split("a.md#set-up", wiki: false), .init(path: "a.md", heading: "set-up"))
        XCTAssertEqual(LinkTarget.split("a.md#27-", wiki: false), .init(path: "a.md", heading: "27-"))
        XCTAssertEqual(LinkTarget.split("a.md", wiki: false), .init(path: "a.md"))
        XCTAssertEqual(LinkTarget.split("a.md#", wiki: false), .init(path: "a.md"))
    }

    // MARK: resolve

    private let root = "/vault"
    private let files = ["/vault/Home.md",
                         "/vault/Daily/🗓️ 2025-04-10 Thursday April 10.md",
                         "/vault/Projects/Plan.md",
                         "/vault/Projects/diagram.png"]
    private let nothingOnDisk: (String) -> Bool = { _ in false }

    func testAWikilinkShouldResolveByNameAnywhereUnderTheRootInAnyCase() {
        XCTAssertEqual(LinkTarget.resolve("🗓️ 2025-04-10 Thursday April 10", wiki: true, from: "/vault/Home.md",
                                          root: root, files: files, exists: nothingOnDisk),
                       "/vault/Daily/🗓️ 2025-04-10 Thursday April 10.md")
        XCTAssertEqual(LinkTarget.resolve("plan", wiki: true, from: "/vault/Home.md",
                                          root: root, files: files, exists: nothingOnDisk),
                       "/vault/Projects/Plan.md")
    }

    func testAMarkdownLinkShouldResolveRelativeToTheNotePercentEncodingIncluded() {
        XCTAssertEqual(LinkTarget.resolve("Projects/Plan.md", wiki: false, from: "/vault/Home.md",
                                          root: root, files: files, exists: nothingOnDisk),
                       "/vault/Projects/Plan.md")
        XCTAssertEqual(LinkTarget.resolve("../Daily/%F0%9F%97%93%EF%B8%8F%202025-04-10%20Thursday%20April%2010.md",
                                          wiki: false, from: "/vault/Projects/Plan.md",
                                          root: root, files: files, exists: nothingOnDisk),
                       "/vault/Daily/🗓️ 2025-04-10 Thursday April 10.md")
    }

    func testALinkToAFileThatIsNotANoteShouldStillResolve() {
        XCTAssertEqual(LinkTarget.resolve("diagram.png", wiki: false, from: "/vault/Projects/Plan.md",
                                          root: root, files: files, exists: nothingOnDisk),
                       "/vault/Projects/diagram.png")
    }

    func testAMarkdownLinkOutsideTheWalkShouldFallBackToTheDiskAndAWikilinkShouldNot() {
        let onDisk: (String) -> Bool = { $0 == "/elsewhere/b.md" }
        XCTAssertEqual(LinkTarget.resolve("../elsewhere/b.md", wiki: false, from: "/vault/a.md",
                                          root: "/vault", files: ["/vault/a.md"], exists: onDisk),
                       "/elsewhere/b.md")
        XCTAssertNil(LinkTarget.resolve("b", wiki: true, from: "/vault/a.md",
                                        root: "/vault", files: ["/vault/a.md"], exists: { _ in true }))
    }

    func testALinkThatNamesNothingShouldResolveToNil() {
        XCTAssertNil(LinkTarget.resolve("Missing.md", wiki: false, from: "/vault/Home.md",
                                        root: root, files: files, exists: nothingOnDisk))
        XCTAssertNil(LinkTarget.resolve("Missing", wiki: true, from: "/vault/Home.md",
                                        root: root, files: files, exists: nothingOnDisk))
    }

    // MARK: headingLine

    private let note = """
    ---
    title: x
    # a comment, not a heading
    ---
    # Set Up

    ```sh
    # Install
    ```

    ## Install `pnpm`

    ## Install pnpm

    Notes
    -----

    ### [Linked](https://a.b) Section
    """

    func testAFragmentShouldMatchAHeadingByItsSlugOrItsTextInAnyCase() {
        XCTAssertEqual(LinkTarget.headingLine(in: note, fragment: "set-up"), 5)
        XCTAssertEqual(LinkTarget.headingLine(in: note, fragment: "Set Up"), 5)
        XCTAssertEqual(LinkTarget.headingLine(in: note, fragment: "Set%20Up"), 5)
        XCTAssertEqual(LinkTarget.headingLine(in: note, fragment: "notes"), 15)
        XCTAssertEqual(LinkTarget.headingLine(in: note, fragment: "linked-section"), 18)
    }

    func testARepeatedHeadingShouldTakeItsCollisionSuffixAndFencesAndFrontmatterShouldNotCount() {
        XCTAssertEqual(LinkTarget.headingLine(in: note, fragment: "install-pnpm"), 11)
        XCTAssertEqual(LinkTarget.headingLine(in: note, fragment: "install-pnpm-1"), 13)
        XCTAssertNil(LinkTarget.headingLine(in: note, fragment: "install"))
        XCTAssertNil(LinkTarget.headingLine(in: note, fragment: "a-comment-not-a-heading"))
    }

    func testSlugifyShouldKeepLettersAndDigitsOfEveryScriptAndDropEmoji() {
        XCTAssertEqual(LinkTarget.slugify("🚀 Launch Plan!"), "-launch-plan")
        XCTAssertEqual(LinkTarget.slugify("日本語 見出し_2"), "日本語-見出し_2")
    }

    // MARK: LinkLocator

    private final class Disk {
        var files: [String]
        var clock = Date(timeIntervalSince1970: 0)
        init(_ files: [String]) { self.files = files }
    }

    private func locator(_ disk: Disk) -> LinkLocator {
        LinkLocator(maxAge: 5, now: { disk.clock }, walk: { _, _ in disk.files })
    }

    private let vault = URL(fileURLWithPath: "/vault")

    func testHoversWithinTheWindowShouldShareOneWalkAndALaterOneShouldWalkAgain() {
        let disk = Disk(["/vault/a.md", "/vault/b.md"])
        let l = locator(disk)
        XCTAssertEqual(l.locate("b", wiki: true, from: "/vault/a.md", root: vault, forOpen: false)?.path, "/vault/b.md")
        XCTAssertEqual(l.locate("b.md", wiki: false, from: "/vault/a.md", root: vault, forOpen: false)?.path, "/vault/b.md")
        XCTAssertEqual(l.walks, 1)
        disk.clock = disk.clock.addingTimeInterval(6)
        _ = l.locate("b", wiki: true, from: "/vault/a.md", root: vault, forOpen: false)
        XCTAssertEqual(l.walks, 2)
    }

    func testAnOpenShouldFindAFileMadeSinceTheKeptWalkAndAHoverShouldNot() {
        let disk = Disk(["/vault/a.md"])
        let l = locator(disk)
        XCTAssertNil(l.locate("New", wiki: true, from: "/vault/a.md", root: vault, forOpen: false))
        disk.files.append("/vault/New.md")
        XCTAssertNil(l.locate("New", wiki: true, from: "/vault/a.md", root: vault, forOpen: false))
        XCTAssertEqual(l.locate("New", wiki: true, from: "/vault/a.md", root: vault, forOpen: true)?.path, "/vault/New.md")
        XCTAssertEqual(l.walks, 2)
    }

    func testAnOpenShouldCarryTheHeadingLineAndALineFragmentAsWritten() {
        let l = locator(Disk(["/vault/a.md", "/vault/Plan.md"]))
        let read: (String) -> String? = { $0 == "/vault/Plan.md" ? "# Plan\n\n## Next Steps\n" : nil }
        XCTAssertEqual(l.locate("Plan#Next Steps", wiki: true, from: "/vault/a.md", root: vault, forOpen: true, read: read),
                       .init(path: "/vault/Plan.md", line: 3))
        XCTAssertEqual(l.locate("Plan.md#9", wiki: false, from: "/vault/a.md", root: vault, forOpen: true, read: read),
                       .init(path: "/vault/Plan.md", line: 9))
        XCTAssertEqual(l.locate("Plan#Nowhere", wiki: true, from: "/vault/a.md", root: vault, forOpen: true, read: read),
                       .init(path: "/vault/Plan.md", line: nil))
    }

    func testASamePageFragmentShouldLocateNothingAndTheDisplayShouldBeRootRelative() {
        let l = locator(Disk(["/vault/a.md"]))
        XCTAssertNil(l.locate("#Heading", wiki: true, from: "/vault/a.md", root: vault, forOpen: true))
        XCTAssertEqual(LinkLocator.display("/vault/Daily/x.md", root: vault), "Daily/x.md")
        XCTAssertEqual(LinkLocator.display("/elsewhere/x.md", root: vault), "/elsewhere/x.md")
    }

    func testAWindowWithNoFolderShouldListOnlyTheNotesOwnFolder() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("link-locator-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("sub"), withIntermediateDirectories: true)
        for name in ["a.md", "sub/b.md", ".hidden.md"] {
            try Data("x".utf8).write(to: dir.appendingPathComponent(name))
        }
        let root = dir.standardizedFileURL
        XCTAssertEqual(Set(LinkLocator.walkFolder(root, deep: false)), [root.path + "/a.md"])
        XCTAssertEqual(Set(LinkLocator.walkFolder(root, deep: true)), [root.path + "/a.md", root.path + "/sub/b.md"])
    }
}
