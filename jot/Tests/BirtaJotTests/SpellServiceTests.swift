import AppKit
import XCTest
@testable import BirtaJot
@testable import BirtaJotCore

/// Spelling and grammar against the REAL system checker.
///
/// Nothing here asserts a particular finding's wording: that is the operating
/// system's to choose, it is localized, and it changes between macOS releases,
/// so a test pinning it would be asserting this machine's dictionary. What is
/// ours, and what these check, is the shape of the answer: a reply for every
/// block and no others, offsets the page can slice with, the tech filter
/// applied, and the reply arriving even when there is nothing to say.
///
/// The one thing that would make all of it meaningless is a checker that found
/// nothing at all on the machine running the suite, so the first case asserts
/// the instrument before the rest lean on it.
@MainActor
final class SpellServiceTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    /// Run the service and wait, so each case reads as a straight line.
    private func lint(_ blocks: [LintBlock], timeout: TimeInterval = 10) -> [LintBlockResult] {
        let done = expectation(description: "lint")
        var out: [LintBlockResult] = []
        SpellService().lint(blocks: blocks) { results in
            out = results
            done.fulfill()
        }
        wait(for: [done], timeout: timeout)
        return out
    }

    func testTheSystemCheckerShouldFindAPlainMisspelling() throws {
        // The instrument. Everything below is about what this app DOES with a
        // finding, and would pass vacuously on a machine whose checker returned
        // nothing, so this fails first and says why.
        let results = lint([LintBlock(key: 0, text: "This sentance has a misspelling.")])
        let lints = try XCTUnwrap(results.first).lints
        XCTAssertFalse(lints.isEmpty,
                       "the system checker found nothing; every case below would pass on that")
        XCTAssertTrue(lints.contains { $0.kind == "Spelling" }, lints.map(\.kind).joined(separator: ","))
    }

    func testAFindingsOffsetsShouldSliceTheWordThePageWouldSlice() throws {
        // The offsets are the page's to slice a JavaScript string with, so what
        // matters is that they land on the flagged word in UTF-16 units. An
        // emoji ahead of it is what tells a UTF-16 count from a Character one.
        let text = "🙂 This sentance is wrong."
        let lints = try XCTUnwrap(lint([LintBlock(key: 0, text: text)]).first).lints
        let spelling = try XCTUnwrap(lints.first { $0.kind == "Spelling" })
        let ns = text as NSString
        XCTAssertEqual(ns.substring(with: NSRange(location: spelling.start,
                                                  length: spelling.end - spelling.start)),
                       "sentance")
    }

    func testATechTokenShouldNotBeOfferedAsAMisspelling() throws {
        // The filter doing its job through the real checker rather than through
        // `ProofreadFilter` directly, which its own tests already cover: a path
        // and an identifier are exactly what a note about code is full of.
        let text = "Open src/utils/lineMap.ts and call getEditorView now."
        let lints = try XCTUnwrap(lint([LintBlock(key: 0, text: text)]).first).lints
        let ns = text as NSString
        for lint in lints {
            let span = ns.substring(with: NSRange(location: lint.start, length: lint.end - lint.start))
            XCTAssertFalse(span.contains("lineMap") || span.contains("getEditorView") || span.contains("src"),
                           "\(span) is a tech token and should have been filtered")
        }
    }

    func testEveryBlockShouldBeAnsweredUnderItsOwnKey() {
        // The key is the page's map back into the document. A reply that
        // dropped one, or renumbered them, would draw the right underlines in
        // the wrong paragraph.
        let blocks = [LintBlock(key: 7, text: "This sentance is wrong."),
                      LintBlock(key: 19, text: "Clean prose here."),
                      LintBlock(key: 42, text: "Another sentance here.")]
        let results = lint(blocks)
        XCTAssertEqual(results.map(\.key).sorted(), [7, 19, 42])
    }

    func testACleanBlockShouldComeBackWithNoFindingsRatherThanNotAtAll() throws {
        let results = lint([LintBlock(key: 3, text: "Clean prose here.")])
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(try XCTUnwrap(results.first).key, 3)
        XCTAssertTrue(try XCTUnwrap(results.first).lints.isEmpty)
    }

    func testAnEmptyRequestShouldStillBeAnswered() {
        // The page holds the request open until it hears back, so silence is
        // not an option even when there is nothing to check.
        XCTAssertEqual(lint([]).count, 0)
    }

    func testAMaskedSpanShouldNeverBeOffered() throws {
        // The placeholder stands where an inline node was (an image, inline
        // code). Anything touching it is about content the reader does not see
        // as prose, whatever the checker calls it.
        let text = "The \u{FFFC}sentance thing."
        let lints = try XCTUnwrap(lint([LintBlock(key: 0, text: text)]).first).lints
        let ns = text as NSString
        for lint in lints {
            let span = ns.substring(with: NSRange(location: lint.start, length: lint.end - lint.start))
            XCTAssertFalse(span.unicodeScalars.contains { $0.value == 0xFFFC }, span)
        }
    }

    func testEveryOfferedSpanShouldBeInsideItsBlock() throws {
        // The page slices with these. A range past the end is a crash there
        // rather than a bad underline here.
        let text = "This sentance has a misspelling and anoter one."
        let lints = try XCTUnwrap(lint([LintBlock(key: 0, text: text)]).first).lints
        let length = (text as NSString).length
        XCTAssertFalse(lints.isEmpty)
        for lint in lints {
            XCTAssertGreaterThanOrEqual(lint.start, 0)
            XCTAssertGreaterThan(lint.end, lint.start)
            XCTAssertLessThanOrEqual(lint.end, length)
        }
    }
}
