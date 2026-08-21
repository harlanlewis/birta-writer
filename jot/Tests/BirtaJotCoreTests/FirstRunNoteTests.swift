import XCTest
@testable import BirtaJotCore

final class FirstRunNoteTests: XCTestCase {

    // ── The rule ──────────────────────────────────────────────────────────

    /// The whole space, derived from the type rather than listed here, so a
    /// fourth `Existing` case joins this matrix the day it is added instead of
    /// the day somebody remembers. The count is asserted because a sweep that
    /// enumerated nothing passes every assertion inside it.
    func testTheWholeSpaceShouldBeCoveredAndOnlyEmptyNotesShouldBeWritten() {
        var writes = 0
        var refusals = 0
        for existing in FirstRunNote.Existing.allCases {
            for bufferIsEmpty in [true, false] {
                for isFirstRun in [true, false] {
                    let write = FirstRunNote.shouldWrite(existing: existing,
                                                         bufferIsEmpty: bufferIsEmpty,
                                                         isFirstRun: isFirstRun)
                    // The invariant, stated once and checked over everything:
                    // the tour is written exactly when all three permit it.
                    let permitted = isFirstRun && bufferIsEmpty && existing != .hasContent
                    XCTAssertEqual(write, permitted,
                                   "existing=\(existing.rawValue) buffer empty=\(bufferIsEmpty) first run=\(isFirstRun)")
                    if write { writes += 1 } else { refusals += 1 }
                }
            }
        }
        XCTAssertEqual(writes + refusals, FirstRunNote.Existing.allCases.count * 4)
        // Both outcomes have to be reachable, or the assertion above is
        // agreeing with a function that always answers the same thing.
        XCTAssertGreaterThan(writes, 0)
        XCTAssertGreaterThan(refusals, 0)
    }

    /// Each refusal on its own, so a rule that stopped being consulted is
    /// visible as a named failure rather than as one row of the matrix.
    func testAnyOneRefusalShouldBeEnoughOnItsOwn() {
        XCTAssertTrue(FirstRunNote.shouldWrite(existing: .absent, bufferIsEmpty: true, isFirstRun: true))

        XCTAssertFalse(FirstRunNote.shouldWrite(existing: .hasContent, bufferIsEmpty: true, isFirstRun: true),
                       "a note with writing in it is never written over")
        XCTAssertFalse(FirstRunNote.shouldWrite(existing: .absent, bufferIsEmpty: false, isFirstRun: true),
                       "bytes in the panel that the file has not been given yet are still bytes")
        XCTAssertFalse(FirstRunNote.shouldWrite(existing: .absent, bufferIsEmpty: true, isFirstRun: false),
                       "deleting the tour has to be final")
    }

    /// An empty file is treated as an absent one. The new-file-each-session
    /// mode creates its note before anything binds to it, so without this the
    /// tour could never reach that mode at all.
    func testAnEmptyFileShouldBeTreatedAsAnAbsentOne() {
        for existing in [FirstRunNote.Existing.absent, .empty] {
            XCTAssertTrue(FirstRunNote.shouldWrite(existing: existing, bufferIsEmpty: true, isFirstRun: true),
                          "\(existing.rawValue) should be writable")
        }
    }

    // ── The note ──────────────────────────────────────────────────────────

    /// The tour is a checklist, and the checklist is the thing it teaches
    /// first. A tour that lost its boxes would still read as prose and would
    /// no longer be what it claims to be.
    func testTheTourShouldBeAChecklistWithNothingAlreadyTicked() {
        let lines = FirstRunNote.markdown.split(separator: "\n", omittingEmptySubsequences: false)
        let unticked = lines.filter { $0.hasPrefix("- [ ] ") }
        XCTAssertGreaterThanOrEqual(unticked.count, 6)
        // Arriving pre-ticked would make the first gesture "untick something",
        // which teaches the same key and reads as somebody else's leftovers.
        XCTAssertEqual(lines.filter { $0.hasPrefix("- [x] ") }.count, 0)
    }

    /// Fenced and display-math blocks close. An unclosed fence swallows the
    /// rest of the note, and the note is long enough that the tail is what
    /// would go: the embeds, the callout and the closing list.
    func testEveryBlockTheTourOpensShouldClose() {
        let lines = FirstRunNote.markdown.split(separator: "\n", omittingEmptySubsequences: false)
        XCTAssertEqual(lines.filter { $0.hasPrefix("```") }.count % 2, 0, "unbalanced code fence")
        XCTAssertEqual(lines.filter { String($0) == "$$" }.count % 2, 0, "unbalanced math block")
        XCTAssertTrue(FirstRunNote.markdown.hasSuffix("\n"), "a text file ends with a newline")
    }

    /// It says the product's name, and says it the way everything else does.
    func testTheTourShouldNameTheProduct() {
        XCTAssertTrue(FirstRunNote.markdown.contains("# Welcome to \(ScratchpadLocation.productName)"))
        // The old name is retired. A tour still carrying it would be the
        // last surface telling somebody they had installed something else.
        XCTAssertFalse(FirstRunNote.markdown.contains("Jot"))
    }
}
