import XCTest
@testable import BirtaWriterCore

/// The Mac app's half of the frontmatter contract.
///
/// `Frontmatter` is a port, so the cases below are `shared/__tests__/
/// contentTransform.test.ts`'s cases, mirrored rather than reinvented: the two
/// surfaces open the same files, and a file the extension calls frontmatter and
/// this side does not is a file whose bytes move when it is opened here.
final class FrontmatterTests: XCTestCase {
    private func split(_ content: String) -> (frontmatter: String, body: String) {
        let s = Frontmatter.split(content)
        return (s.frontmatter, s.body)
    }

    // MARK: the block itself

    func testStandardFrontmatterIsSeparated() {
        let out = split("---\ntitle: Test\ndate: 2024-01-01\n---\n# Hello")
        XCTAssertEqual(out.frontmatter, "---\ntitle: Test\ndate: 2024-01-01\n---\n")
        XCTAssertEqual(out.body, "# Hello")
    }

    func testNoFrontmatterLeavesTheDocumentAlone() {
        let content = "# Just a heading\n\nSome text."
        let out = split(content)
        XCTAssertEqual(out.frontmatter, "")
        XCTAssertEqual(out.body, content)
    }

    func testAnEmptyDocumentHasNeitherHalf() {
        let out = split("")
        XCTAssertEqual(out.frontmatter, "")
        XCTAssertEqual(out.body, "")
    }

    /// The pattern needs a line between the fences, so a bare pair is content.
    func testDelimitersWithNothingBetweenThemAreNotFrontmatter() {
        let content = "---\n---\n# Body"
        let out = split(content)
        XCTAssertEqual(out.frontmatter, "")
        XCTAssertEqual(out.body, content)
    }

    func testNestedYamlIsSeparated() {
        let out = split("---\nauthor:\n  name: Alice\n  email: a@b.com\ntags:\n  - md\n---\n# Doc")
        XCTAssertEqual(out.body, "# Doc")
        XCTAssertTrue(out.frontmatter.contains("author:"))
    }

    func testCrlfFrontmatterIsRecognized() {
        let out = split("---\r\ntitle: Test\r\n---\r\n# Body")
        XCTAssertEqual(out.frontmatter, "---\r\ntitle: Test\r\n---\r\n")
        XCTAssertEqual(out.body, "# Body")
    }

    /// The FIRST full closing fence ends the block; a later pair is body.
    func testTheFirstClosingFenceEndsTheBlock() {
        let out = split("---\ntitle: A\n---\n# H1\n---\nNot frontmatter\n---\n")
        XCTAssertEqual(out.frontmatter, "---\ntitle: A\n---\n")
        XCTAssertTrue(out.body.contains("# H1"))
    }

    func testABlockNotAtTheStartIsNotFrontmatter() {
        let content = "Some text\n---\ntitle: Test\n---\n"
        let out = split(content)
        XCTAssertEqual(out.frontmatter, "")
        XCTAssertEqual(out.body, content)
    }

    /// An inner line that merely STARTS with the delimiter must not close the
    /// block; if it did, a save would truncate the document at that line.
    func testAnInnerLineStartingWithTheDelimiterDoesNotClose() {
        let out = split("---\ntitle: A\n--- draft\nmore: x\n---\n# Body")
        XCTAssertEqual(out.frontmatter, "---\ntitle: A\n--- draft\nmore: x\n---\n")
        XCTAssertEqual(out.body, "# Body")
    }

    func testAnInnerLongerRuleDoesNotClose() {
        let out = split("---\ntitle: A\n----\nmore: x\n---\n# Body")
        XCTAssertEqual(out.frontmatter, "---\ntitle: A\n----\nmore: x\n---\n")
        XCTAssertEqual(out.body, "# Body")
    }

    func testAnUnclosedBlockIsAllBody() {
        let content = "---\ntitle: A\n--- draft\n# Body"
        let out = split(content)
        XCTAssertEqual(out.frontmatter, "")
        XCTAssertEqual(out.body, content)
    }

    func testAClosingFenceAtEndOfFileNeedsNoNewline() {
        let out = split("---\ntitle: A\n---")
        XCTAssertEqual(out.frontmatter, "---\ntitle: A\n---")
        XCTAssertEqual(out.body, "")
    }

    func testCrlfBlockWithAnInnerRuleFindsTheRealFence() {
        let out = split("---\r\ntitle: A\r\n--- draft\r\n---\r\n# Body")
        XCTAssertEqual(out.frontmatter, "---\r\ntitle: A\r\n--- draft\r\n---\r\n")
        XCTAssertEqual(out.body, "# Body")
    }

    // MARK: TOML

    func testTomlBlockIsSeparated() {
        let out = split("+++\ntitle = \"Test\"\ndate = 2024-01-01\n+++\n# Hello")
        XCTAssertEqual(out.frontmatter, "+++\ntitle = \"Test\"\ndate = 2024-01-01\n+++\n")
        XCTAssertEqual(out.body, "# Hello")
    }

    func testTomlTableHeaderStaysInTheBlock() {
        let out = split("+++\ntitle = \"Test\"\n\n[taxonomies]\ntags = [\"a\", \"b\"]\n+++\n# Hello")
        XCTAssertEqual(out.frontmatter, "+++\ntitle = \"Test\"\n\n[taxonomies]\ntags = [\"a\", \"b\"]\n+++\n")
        XCTAssertEqual(out.body, "# Hello")
    }

    /// A mismatched pair is not frontmatter at all. Accepting one would let the
    /// panel write one dialect's fence over the other's on the next save.
    func testAMismatchedPairIsNotFrontmatter() {
        let toml = "+++\ntitle = \"A\"\n---\n# Body"
        XCTAssertEqual(split(toml).frontmatter, "")
        XCTAssertEqual(split(toml).body, toml)
        let yaml = "---\ntitle: A\n+++\n# Body"
        XCTAssertEqual(split(yaml).frontmatter, "")
        XCTAssertEqual(split(yaml).body, yaml)
    }

    func testAnInnerLineStartingWithTheTomlDelimiterDoesNotClose() {
        let out = split("+++\ntitle = \"A\"\n++++\nmore = \"x\"\n+++\n# Body")
        XCTAssertEqual(out.frontmatter, "+++\ntitle = \"A\"\n++++\nmore = \"x\"\n+++\n")
        XCTAssertEqual(out.body, "# Body")
    }

    func testAnInnerYamlFenceDoesNotCloseATomlBlock() {
        let out = split("+++\ntitle = \"A\"\n---\nmore = \"x\"\n+++\n# Body")
        XCTAssertEqual(out.frontmatter, "+++\ntitle = \"A\"\n---\nmore = \"x\"\n+++\n")
        XCTAssertEqual(out.body, "# Body")
    }

    func testATomlBlockNotAtTheStartIsNotFrontmatter() {
        let content = "Some text\n+++\ntitle = \"Test\"\n+++\n"
        XCTAssertEqual(split(content).frontmatter, "")
        XCTAssertEqual(split(content).body, content)
    }

    func testAnUnclosedTomlOpenerIsAllBody() {
        let content = "+++\ntitle = \"A\"\n# Body"
        XCTAssertEqual(split(content).frontmatter, "")
        XCTAssertEqual(split(content).body, content)
    }

    func testTomlCrlfAndEndOfFileFences() {
        XCTAssertEqual(split("+++\r\ntitle = \"Test\"\r\n+++\r\n# Body").frontmatter,
                       "+++\r\ntitle = \"Test\"\r\n+++\r\n")
        XCTAssertEqual(split("+++\ntitle = \"A\"\n+++").frontmatter, "+++\ntitle = \"A\"\n+++")
        XCTAssertEqual(split("+++\ntitle = \"A\"\n+++").body, "")
    }

    // MARK: how far the body is pushed down

    func testSourceLineCountIsTheBlocksLineTerminators() {
        XCTAssertEqual(Frontmatter.sourceLineCount(""), 0)
        XCTAssertEqual(Frontmatter.sourceLineCount("---\ntitle: A\n---\n"), 3)
        // A block ending at EOF has one fewer terminator, and the body under it
        // is empty, so the count is still exactly what it is pushed down by.
        XCTAssertEqual(Frontmatter.sourceLineCount("---\ntitle: A\n---"), 2)
    }

    /// Swift makes `\r\n` ONE Character, so the obvious count returns zero for
    /// a CRLF block and every document line the page reports comes out short by
    /// the whole block.
    func testACrlfBlockCountsItsLines() {
        XCTAssertEqual(Frontmatter.sourceLineCount("---\r\ntitle: A\r\n---\r\n"), 3)
    }

    // MARK: putting the halves back together

    func testTheBodyIsRejoinedToTheBlockItWasSplitFrom() {
        let content = "---\ntitle: A\n--- draft\n----\n---\n# Body\n"
        var doc = DocumentSplit()
        let page = doc.forPage(content)
        XCTAssertEqual(page.lineOffset, 5)
        XCTAssertEqual(doc.document(body: page.body), content)
    }

    func testAnEditedBodyKeepsTheBlockAboveIt() {
        var doc = DocumentSplit()
        _ = doc.forPage("---\ntitle: A\n---\n# Body\n")

        XCTAssertEqual(doc.document(body: "# Body\n\nmore\n"), "---\ntitle: A\n---\n# Body\n\nmore\n")
    }

    func testAPanelEditReplacesOnlyTheBlock() {
        let content = "---\ntitle: A\n---\n# Body\n"
        var doc = DocumentSplit()
        _ = doc.forPage(content)

        let updated = doc.document(content, replacingFrontmatterWith: "---\ntitle: B\ntags: [x]\n---\n")

        XCTAssertEqual(updated, "---\ntitle: B\ntags: [x]\n---\n# Body\n")
        // The mirror moved with it, so the next body-only update rejoins the
        // block the panel is now holding rather than the one it replaced.
        XCTAssertEqual(doc.document(body: "# Body\n"), updated)
    }

    func testClearingThePanelRemovesTheBlockAndLeavesTheBody() {
        let content = "---\ntitle: A\n---\n# Body\n"
        var doc = DocumentSplit()
        _ = doc.forPage(content)

        XCTAssertEqual(doc.document(content, replacingFrontmatterWith: ""), "# Body\n")
        XCTAssertEqual(doc.frontmatter, "")
    }

    func testAddingMetadataToADocumentThatHadNoneOnlyPrepends() {
        let content = "# Body\n"
        var doc = DocumentSplit()
        _ = doc.forPage(content)

        XCTAssertEqual(doc.document(content, replacingFrontmatterWith: "---\ntitle: A\n---\n"),
                       "---\ntitle: A\n---\n# Body\n")
    }

    /// THE case the mirror exists for.
    ///
    /// A document with no frontmatter whose body opens with something that
    /// parses as a block (a rule, a line, a setext heading, all of which a
    /// person can type). Re-reading the buffer to find the block would call
    /// that body frontmatter and prepend it to itself; the mirror says the
    /// panel is holding nothing, so nothing is prepended.
    /// Reached by CLEARING the panel, which is the only way a buffer whose own
    /// first lines form a block can be one the panel holds nothing of. A
    /// document opening with two blocks: the first is frontmatter, the second
    /// is body a person typed (a rule, a line, a setext heading). Clear the
    /// panel and the buffer now opens with the second one.
    func testABodyThatLooksLikeABlockIsNotTakenForOne() {
        var doc = DocumentSplit()
        _ = doc.forPage("---\ntitle: A\n---\n---\nA heading\n---\n\nmore\n")

        let cleared = doc.document("---\ntitle: A\n---\n---\nA heading\n---\n\nmore\n",
                                   replacingFrontmatterWith: "")
        XCTAssertEqual(cleared, "---\nA heading\n---\n\nmore\n")
        XCTAssertEqual(doc.frontmatter, "")

        // The discriminating half: re-reading the buffer here finds the body's
        // own block and replaces it, losing "A heading" and its fences. The
        // mirror says the panel holds nothing, so the whole buffer is body.
        XCTAssertEqual(doc.document(cleared, replacingFrontmatterWith: "---\ntitle: B\n---\n"),
                       "---\ntitle: B\n---\n---\nA heading\n---\n\nmore\n")
        // Same for the body-only path, which rejoins against the same mirror.
        XCTAssertEqual(Frontmatter.split(cleared).frontmatter, "---\nA heading\n---\n",
                       "the case is only reachable while the pattern reads the body's opening as a block")
    }

    /// The mirror does not paper over a buffer the host replaced behind it: a
    /// block that is no longer a prefix falls back to a re-split, which is what
    /// stops a stale mirror being prepended to a document it was never in.
    func testABlockThatIsNoLongerAPrefixIsReSplit() {
        var doc = DocumentSplit()
        _ = doc.forPage("---\ntitle: A\n---\n# Body\n")

        XCTAssertEqual(doc.document("---\ntitle: Z\n---\n# Other\n",
                                    replacingFrontmatterWith: "---\ntitle: B\n---\n"),
                       "---\ntitle: B\n---\n# Other\n")
    }

    // MARK: what a panel edit tells the page about its own line numbers

    /// The page draws gutter numbers and names lines to an agent by adding this
    /// to every document line, so a panel edit that changes the block's height
    /// has a new one to send.
    func testTheOffsetFollowsTheBlockThePanelHolds() {
        var doc = DocumentSplit()
        _ = doc.forPage("---\ntitle: A\n---\n# Body\n")
        XCTAssertEqual(doc.lineOffset, 3)

        _ = doc.document("---\ntitle: A\n---\n# Body\n",
                         replacingFrontmatterWith: "---\ntitle: A\ntags: [x]\ndraft: true\n---\n")
        XCTAssertEqual(doc.lineOffset, 5)

        _ = doc.document("---\ntitle: A\ntags: [x]\ndraft: true\n---\n# Body\n",
                         replacingFrontmatterWith: "")
        XCTAssertEqual(doc.lineOffset, 0)
    }
}
