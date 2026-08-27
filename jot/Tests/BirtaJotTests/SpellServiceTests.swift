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

    /// Sentences whose grammar the system checker is expected to object to.
    ///
    /// A corpus rather than one sentence, and a FLOOR rather than every one of
    /// them: which of these `NSSpellChecker` catches is the operating system's
    /// business and moves between releases, so requiring all of them would be
    /// asserting this macOS. Requiring none of them is what this replaces.
    private static let ungrammatical = [
        "This are a test of grammar.",
        "The books is on the table.",
        "She don't like it.",
        "I has a apple.",
        "Me and him goes to the park.",
    ]

    /// Grammar findings exist at all.
    ///
    /// This used to skip when the list came back empty, which is precisely the
    /// state a broken chain produces: ask for `.spelling` alone, unpack the
    /// details wrongly, or let the tech filter veto them, and the result is no
    /// grammar findings and a green suite. A skip there is a check that stands
    /// down exactly when it has something to say.
    ///
    /// The arm that keeps a red honest is the spelling one. If this machine's
    /// checker answers a misspelling and objects to none of five sentences that
    /// disagree with themselves, the checker is working and grammar is not,
    /// which is a fact about the product and worth failing over: Check Grammar
    /// is a row in the menu bar promising something.
    func testTheSystemCheckerShouldObjectToUngrammaticalSentences() throws {
        let spelling = try XCTUnwrap(
            lint([LintBlock(key: 0, text: "This sentance has a misspelling.")]).first).lints
        XCTAssertTrue(spelling.contains { $0.kind == "Spelling" },
                      "the checker answered no spelling either, so this machine's checker is off")

        var flagged = 0
        for text in Self.ungrammatical {
            let lints = try XCTUnwrap(lint([LintBlock(key: 0, text: text)]).first).lints
            if lints.contains(where: { $0.kind == "Grammar" }) { flagged += 1 }
        }
        XCTAssertGreaterThan(flagged, 0,
                             "the checker answered a misspelling and objected to none of "
                                 + "\(Self.ungrammatical.count) ungrammatical sentences, so nothing "
                                 + "the Check Grammar row offers reaches the reader")
    }

    func testAGrammarFindingShouldUnderlineTheWordRatherThanTheSentence() throws {
        // The one piece of arithmetic in this service, and it is invisible when
        // wrong in the only way that matters: the checker returns a grammar
        // result spanning the WHOLE SENTENCE, and puts the offending word in a
        // detail whose range is RELATIVE to it. Take the result's range and the
        // reader gets the entire sentence underlined; take the detail's range
        // as absolute and the underline lands somewhere else entirely.
        //
        // Every sentence the corpus offers, so the narrowing is checked on
        // whichever ones this macOS objects to rather than on one that may not
        // be among them; the count is asserted, because a sweep that narrowed
        // nothing is what the case above exists to catch.
        var narrowed = 0
        for text in Self.ungrammatical {
            let lints = try XCTUnwrap(lint([LintBlock(key: 0, text: text)]).first).lints
            let sentence = (text as NSString).length
            for hit in lints where hit.kind == "Grammar" {
                XCTAssertLessThan(hit.end - hit.start, sentence / 2,
                                  "the whole of \"\(text)\" was underlined instead of the word")
                narrowed += 1
            }
        }
        XCTAssertGreaterThan(narrowed, 0, "no grammar finding was narrowed, so this asserted nothing")
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

    // MARK: - How often the thread is handed back

    /// Lint through a service the caller keeps, so its batch counter is readable.
    private func batches(of blocks: [LintBlock], timeout: TimeInterval = 60) -> Int {
        let service = SpellService()
        let done = expectation(description: "lint")
        service.lint(blocks: blocks) { _ in done.fulfill() }
        wait(for: [done], timeout: timeout)
        return service.lastCost.batches
    }

    private func blocks(count: Int, chars: Int) -> [LintBlock] {
        // Distinct words rather than one repeated character: the checker is
        // given something sentence-shaped, and a block of "aaaa" is not a
        // realistic thing to time or to count turns over.
        (0..<count).map { i in
            var text = "Paragraph \(i)"
            while (text as NSString).length < chars { text += " and some more ordinary prose" }
            return LintBlock(key: i * 100, text: text)
        }
    }

    func testAShortNoteShouldBeCheckedWithoutHandingBackTheThread() {
        // Ten one-line blocks are a few hundred characters between them, well
        // inside one budget, and yielding for them would only make the
        // underlines crawl down the page for no benefit to anyone.
        XCTAssertEqual(batches(of: blocks(count: 10, chars: 30)), 1)
    }

    func testTheSameBlockCountShouldYieldMoreOftenWhenTheBlocksAreLonger() {
        // THE assertion. A budget counted in BLOCKS cannot tell these two apart:
        // forty blocks is forty blocks, and it would hand the thread back the
        // same number of times for four hundred characters as for thirty-six
        // thousand. The document that made the caret stutter was the second
        // shape, unwrapped paragraphs, and this is the only check that
        // distinguishes the two budgets.
        let short = batches(of: blocks(count: 40, chars: 10))
        let long = batches(of: blocks(count: 40, chars: 900))
        XCTAssertGreaterThan(long, short * 4,
                             "same block count, \(short) turns for short blocks and "
                             + "\(long) for long ones: the budget is not counting characters")
    }

    func testABlockLongerThanTheWholeBudgetShouldStillBeChecked() {
        // A budget that could refuse a batch's first block would hand the run
        // loop back forever and never answer. One block, however long, is one
        // turn and one result.
        let huge = blocks(count: 1, chars: 20_000)
        XCTAssertEqual(batches(of: huge), 1)
        XCTAssertEqual(lint(huge, timeout: 60).count, 1)
    }

    func testAnEmptyRequestShouldStillAnswerInOneTurn() {
        // The page holds its request open until it hears back, so the answer
        // has to arrive for nothing as well as for something.
        XCTAssertEqual(batches(of: []), 1)
    }
}
