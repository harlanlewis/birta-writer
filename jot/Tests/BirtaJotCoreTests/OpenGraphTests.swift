import XCTest
@testable import BirtaJotCore

/// `src/utils/openGraph.ts` is the reference implementation; these cover the
/// same ground for the Swift port. Unlike the SSRF guard, a difference here is
/// cosmetic rather than dangerous, which is why the cases are not shared: what
/// matters is that a title comes out as one clean line, not that both surfaces
/// pick the same entity table.
final class OpenGraphTests: XCTestCase {
    func testPrefersOgTitleOverTheTitleTag() {
        let html = "<head><title>Tag title</title><meta property=\"og:title\" content=\"OG title\"></head>"

        XCTAssertEqual(OpenGraph.title(in: html), "OG title")
    }

    func testFallsBackToTheTitleTag() {
        XCTAssertEqual(OpenGraph.title(in: "<head><title>Only this</title></head>"), "Only this")
    }

    func testAnEmptyOgTitleFallsThroughRatherThanEndingTheSearch() {
        let html = "<meta property=\"og:title\" content=\"   \"><title>Real one</title>"

        XCTAssertEqual(OpenGraph.title(in: html), "Real one")
    }

    func testNoTitleAtAllIsNil() {
        XCTAssertNil(OpenGraph.title(in: "<html><body>nothing here</body></html>"))
    }

    func testAcceptsNameAsWellAsProperty() {
        XCTAssertEqual(OpenGraph.title(in: "<meta name=\"og:title\" content=\"By name\">"), "By name")
    }

    func testAcceptsAnyAttributeOrderAndQuoting() {
        XCTAssertEqual(OpenGraph.title(in: "<meta content='Single quoted' property='og:title'>"), "Single quoted")
        XCTAssertEqual(OpenGraph.title(in: "<meta content=Unquoted property=og:title>"), "Unquoted")
    }

    func testDescriptionPrefersOgAndFallsBackToTheBareMeta() {
        XCTAssertEqual(OpenGraph.description(in: "<meta property=\"og:description\" content=\"OG one\">"), "OG one")
        XCTAssertEqual(OpenGraph.description(in: "<meta name=\"description\" content=\"Plain one\">"), "Plain one")
    }

    // MARK: sanitizing

    func testCollapsesNewlinesAndRunsOfSpaceIntoOneLine() {
        XCTAssertEqual(OpenGraph.sanitize("A title\n  spread   over\tlines"), "A title spread over lines")
    }

    func testDecodesNamedAndNumericEntities() {
        XCTAssertEqual(OpenGraph.sanitize("Tom &amp; Jerry"), "Tom & Jerry")
        XCTAssertEqual(OpenGraph.sanitize("It&#39;s here"), "It's here")
        XCTAssertEqual(OpenGraph.sanitize("It&#x2019;s here"), "It\u{2019}s here")
        XCTAssertEqual(OpenGraph.sanitize("Foo &mdash; Bar"), "Foo \u{2014} Bar")
    }

    func testLeavesAnUnknownEntityVerbatim() {
        XCTAssertEqual(OpenGraph.sanitize("A &frob; B"), "A &frob; B")
    }

    func testDecodesBeforeCollapsing() {
        // `&#10;` is a newline once decoded, and has to be collapsed like one.
        XCTAssertEqual(OpenGraph.sanitize("One&#10;Two"), "One Two")
    }

    func testCapsTheLength() {
        let long = String(repeating: "a", count: 400)

        XCTAssertEqual(OpenGraph.sanitize(long)?.count, OpenGraph.maxLength)
    }

    func testNothingUsableIsNil() {
        XCTAssertNil(OpenGraph.sanitize("   \n\t  "))
        XCTAssertNil(OpenGraph.sanitize(""))
    }

    func testAnOutOfRangeCodePointIsLeftAlone() {
        // Rejected rather than crashing on an invalid scalar.
        XCTAssertEqual(OpenGraph.sanitize("x &#1114112; y"), "x &#1114112; y")
    }
}
