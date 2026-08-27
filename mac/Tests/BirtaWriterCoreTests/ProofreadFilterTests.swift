import XCTest
@testable import BirtaWriterCore

/// `shared/__tests__/proofreadFilter.test.ts`, case for case.
///
/// The mirroring is the point rather than the coverage: two ports of one rule
/// agree today and drift the first time a case is added to one of them, and
/// what makes that visible is that the suites read the same. `AgentRequestTests`
/// and `AgentReferenceTests` are the same arrangement.
final class ProofreadFilterTests: XCTestCase {
    /// The span of `target` in `text`, in the page's own units.
    private func span(_ text: String, _ target: String) -> (Int, Int) {
        let ns = text as NSString
        let range = ns.range(of: target)
        return (range.location, range.location + range.length)
    }

    private func isTech(_ text: String, _ target: String) -> Bool {
        let (start, end) = span(text, target)
        return ProofreadFilter.isTechSpan(text, start: start, end: end)
    }

    func testAPlainProseWordShouldNotBeTech() {
        XCTAssertFalse(isTech("This is a sentance with a typo.", "sentance"))
    }

    func testAWordInsideAFilePathShouldBeTech() {
        let text = "Open src/utils/lineMap.ts and check."
        XCTAssertTrue(isTech(text, "src"))
        XCTAssertTrue(isTech(text, "ts"))
    }

    func testACamelCaseIdentifierShouldBeTech() {
        XCTAssertTrue(isTech("The getEditorView helper returns the view.", "getEditorView"))
    }

    func testAnAllCapsTokenShouldBeTech() {
        XCTAssertTrue(isTech("The VSCode API uses this.", "VSCode"))
    }

    func testATokenWithDigitsShouldBeTech() {
        XCTAssertTrue(isTech("Use es2020 syntax here.", "es2020"))
    }

    func testADomainShouldBeTechEvenWithTrailingSentencePunctuation() {
        let text = "Visit exmaple.com. This ends."
        XCTAssertTrue(isTech(text, "exmaple"))
        XCTAssertFalse(isTech(text, "ends"))
    }

    func testAChunkContainingAnInlineNodePlaceholderShouldBeTech() {
        XCTAssertTrue(isTech("before \u{FFFC}word end", "word"))
    }

    func testACapitalizedSentenceStartWordShouldNotBeTech() {
        XCTAssertFalse(isTech("Recieve the goods.", "Recieve"))
    }

    func testAMultiWordSpanShouldNotBeVetoedByTheIdentifierTest() {
        XCTAssertFalse(isTech("this are a grammar error here.", "this are"))
    }

    // MARK: the port's own hazard, which the TypeScript has no reason to cover

    func testOffsetsShouldBeCountedTheWayThePageCountsThem() {
        // A JavaScript string is UTF-16, so an emoji ahead of the span moves it
        // by TWO. Counted in Swift's own Characters this passes for ASCII and
        // silently reads the wrong span the moment anybody writes an emoji,
        // which is the failure a port like this one is for.
        let text = "🙂 Open src/utils/lineMap.ts now."
        XCTAssertTrue(isTech(text, "src"))
        XCTAssertFalse(isTech("🙂 This is a sentance here.", "sentance"))
        // The fixture really does put a surrogate pair in front of the span, or
        // this is an ASCII case wearing an emoji: two units for the emoji, one
        // for the space, five for "Open ".
        XCTAssertEqual((text as NSString).range(of: "src").location, 2 + 1 + 5)
        XCTAssertEqual(text.distance(from: text.startIndex, to: text.range(of: "src")!.lowerBound),
                       1 + 1 + 5, "and Swift's own Characters count it differently, which is the point")
    }

    func testAnOutOfRangeSpanShouldBeRefusedRatherThanCrash() {
        // The spans arrive over a bridge from another process. A stale one is a
        // wrong answer at worst and a trap at best, and Swift's slicing traps.
        XCTAssertFalse(ProofreadFilter.isTechSpan("short", start: 0, end: 99))
        XCTAssertFalse(ProofreadFilter.isTechSpan("short", start: 3, end: 3))
        XCTAssertFalse(ProofreadFilter.isTechSpan("short", start: -1, end: 2))
    }
}
