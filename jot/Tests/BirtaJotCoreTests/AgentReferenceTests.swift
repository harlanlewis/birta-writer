import XCTest
@testable import BirtaJotCore

/// The same cases `src/__tests__/agentBridge.format.test.ts` runs against the
/// TypeScript. Both surfaces hand the same shape to the same tools, so a case
/// that passes on one side and not the other is the drift this pair exists to
/// catch; a change to either has to be made in both.
///
/// Jot's payload differs from the extension's in exactly one way, and it is
/// the caller's rather than this type's: the path handed in is absolute,
/// because Jot's file lives under Application Support and a workspace-relative
/// path would name nothing.
final class AgentReferenceTests: XCTestCase {
    private func caret(_ line: Int, _ column: Int) -> AgentReference.Selection {
        .init(anchor: .init(line: line, column: column),
              active: .init(line: line, column: column),
              isEmpty: true)
    }

    private func range(_ a: (Int, Int), _ b: (Int, Int)) -> AgentReference.Selection {
        .init(anchor: .init(line: a.0, column: a.1),
              active: .init(line: b.0, column: b.1),
              isEmpty: false)
    }

    // MARK: reference

    func testACaretReferencesASingleLine() {
        XCTAssertEqual(AgentReference.reference(path: "docs/note.md", selection: caret(10, 4)),
                       "docs/note.md#L10")
    }

    func testAMultiLineSelectionReferencesTheOrderedLineRange() {
        XCTAssertEqual(AgentReference.reference(path: "docs/note.md", selection: range((12, 0), (20, 6))),
                       "docs/note.md#L12-L20")
    }

    func testABackwardSelectionStillProducesAnAscendingRange() {
        XCTAssertEqual(AgentReference.reference(path: "a.md", selection: range((20, 6), (12, 0))),
                       "a.md#L12-L20")
    }

    func testAnAbsolutePathIsCarriedThroughUnchanged() {
        // Jot's whole difference from the extension, and it is nothing this
        // type does: it references whatever path it is handed.
        let path = "/Users/x/Library/Application Support/Birta Jot/Birta Jot.md"
        XCTAssertEqual(AgentReference.reference(path: path, selection: caret(3, 0)), "\(path)#L3")
    }

    // MARK: the payload

    func testACaretCopiesTheReferenceAlone() {
        XCTAssertEqual(
            AgentReference.clipboardPayload(path: "a.md", selection: caret(3, 0), source: "x\ny\nz\n"),
            "a.md#L3")
    }

    func testASelectionQuotesItsRealSourceFragment() {
        let doc = "# Title\n\n## Section\n\n- item *one*\n- item [two](x.md)\n"
        // Full-line start, mid-line end: the last line is trimmed to the
        // selection's end column, because the writer pointed at that fragment.
        XCTAssertEqual(
            AgentReference.clipboardPayload(path: "a.md", selection: range((5, 0), (6, 10)), source: doc),
            "a.md#L5-L6\n\n```markdown\n- item *one*\n- item [tw\n```")
    }

    func testAMidLineSelectionQuotesExactlyTheSelectedCharacters() {
        let doc = "The quick brown fox jumps over the lazy dog.\n"
        XCTAssertEqual(
            AgentReference.clipboardPayload(path: "a.md", selection: range((1, 4), (1, 15)), source: doc),
            "a.md#L1\n\n```markdown\nquick brown\n```")
    }

    func testASelectionEndingAtColumnZeroDropsThatLine() {
        let doc = "alpha\nbeta\ngamma\n"
        XCTAssertEqual(
            AgentReference.clipboardPayload(path: "a.md", selection: range((1, 0), (3, 0)), source: doc),
            "a.md#L1-L2\n\n```markdown\nalpha\nbeta\n```")
    }

    func testContentHoldingAFenceGetsALongerOuterFence() {
        let doc = "text\n```js\ncode\n```\nmore\n"
        let out = AgentReference.clipboardPayload(path: "a.md", selection: range((1, 0), (5, 4)), source: doc)
        XCTAssertTrue(out.contains("````markdown\n"), out)
        XCTAssertTrue(out.hasSuffix("\n````"), out)
        XCTAssertTrue(out.contains("```js\ncode\n```"), out)
    }

    func testStaleCoordinatesPastTheEndFallBackToTheReferenceAlone() {
        // The extension falls back to the selection's plain text here, which it
        // has and Jot does not: the page sends the span, and the source is the
        // buffer Jot already holds. A reference alone is the honest answer
        // rather than quoting something that is not there.
        XCTAssertEqual(
            AgentReference.clipboardPayload(path: "a.md", selection: range((90, 0), (91, 2)), source: "one\ntwo\n"),
            "a.md#L90-L91")
    }

    func testABlankLineInsideASelectionSurvivesTheQuote() {
        // `split` drops empty strings and a blank line between paragraphs is
        // content; losing it would silently join two paragraphs in the quote.
        let doc = "one\n\ntwo\n"
        XCTAssertEqual(
            AgentReference.clipboardPayload(path: "a.md", selection: range((1, 0), (3, 3)), source: doc),
            "a.md#L1-L3\n\n```markdown\none\n\ntwo\n```")
    }

    func testCRLFSourceIsQuotedWithoutTheCarriageReturns() {
        let doc = "alpha\r\nbeta\r\n"
        XCTAssertEqual(
            AgentReference.clipboardPayload(path: "a.md", selection: range((1, 0), (2, 4)), source: doc),
            "a.md#L1-L2\n\n```markdown\nalpha\nbeta\n```")
    }

    func testALongSelectionIsCopiedWhole() {
        // No ceiling, matching the TypeScript: `buildContextBlock` does not
        // truncate either, and only the model-facing `describeForModel` does,
        // which Jot has no equivalent of. Someone who selected a long passage
        // and asked for it meant it, and Jot's Copy Everything has no ceiling
        // for the same reason.
        let long = String(repeating: "a", count: 40_000)
        let out = AgentReference.clipboardPayload(
            path: "a.md", selection: range((1, 0), (1, long.count)), source: long)
        XCTAssertTrue(out.contains(long), "the whole selection should be on the clipboard")
        XCTAssertFalse(out.contains("truncated"), String(out.suffix(80)))
    }

    // MARK: the span rule on its own

    func testTheLineSpanEndsOnThePreviousLineWhenTheSelectionEndsAtColumnZero() {
        XCTAssertEqual(AgentReference.lineSpan(range((1, 0), (3, 0))).endLine, 2)
    }

    func testASelectionEndingPastColumnZeroKeepsItsLastLine() {
        // The discriminating pair: same lines, one column apart, different span.
        XCTAssertEqual(AgentReference.lineSpan(range((1, 0), (3, 1))).endLine, 3)
    }

    func testASingleLineSelectionEndingAtColumnZeroKeepsItsLine() {
        // The rule is about a LATER line. A zero-width caret at column 0 must
        // not walk itself back to line zero.
        XCTAssertEqual(AgentReference.lineSpan(caret(1, 0)).endLine, 1)
    }
}
