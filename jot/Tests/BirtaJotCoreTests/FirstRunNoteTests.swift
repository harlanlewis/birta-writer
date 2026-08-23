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
    ///
    /// Not pinned to the heading. The tour opens on what the reader just DID
    /// rather than on a masthead, so the name lands in the first paragraph;
    /// what matters is that the name appears and is the shared spelling.
    func testTheTourShouldNameTheProduct() {
        XCTAssertTrue(FirstRunNote.markdown.contains(ScratchpadLocation.productName))
        // The old name is retired. A tour still carrying it would be the
        // last surface telling somebody they had installed something else.
        XCTAssertFalse(FirstRunNote.markdown.contains("Jot"))
    }

    // ── The two traps the tour can fall into silently ─────────────────────

    /// Lines outside a fence carry no bare `*`.
    ///
    /// The serializer escapes one mid-paragraph, so a demo written `340 * 12`
    /// reaches the reader's own file as `340 \* 12`: a backslash nobody typed,
    /// in the first document they ever open, in the one document whose whole
    /// job is to claim the file stays clean. Nothing else notices, because the
    /// tour is a string here and the escaping happens on the way to disk.
    func testTheTourShouldCarryNoCharacterTheSerializerWillEscape() {
        var fenced = false
        var offenders: [String] = []
        for line in FirstRunNote.markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("```") { fenced.toggle(); continue }
            if fenced { continue }
            if line.contains("*") { offenders.append(String(line)) }
        }
        XCTAssertEqual(offenders, [], "these reach the file with a backslash in front")
    }

    /// No line the reader is told to type INTO already carries what they are
    /// told to type.
    ///
    /// `340 + 12 =` plus a typed `=` is `==`, which computes nothing and
    /// leaves somebody staring at a demo that does not work. The tour says to
    /// type an equals sign, so no demo line may end in one.
    func testNoDemoLineShouldAlreadyCarryTheCharacterTheReaderTypes() {
        XCTAssertTrue(FirstRunNote.markdown.contains("type an equals sign"),
                      "the instruction this guards should still be here")
        let ends = FirstRunNote.markdown
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { $0.hasSuffix("=") && !$0.hasPrefix("|") }
        XCTAssertEqual(ends.map(String.init), [], "a demo line already ends with the character to type")
    }

    /// The type-along happens at the TOP LEVEL, never inside the checklist.
    ///
    /// Return from inside a list continues the list, and `## ` typed there is
    /// escaped to a literal rather than becoming a heading. A tour whose
    /// central move sat one indent deeper would demonstrate the exact opposite
    /// of the claim it is making, and would look completely reasonable in the
    /// source.
    func testTheTypeAlongShouldSitAtTheTopLevel() {
        let lines = FirstRunNote.markdown.split(separator: "\n", omittingEmptySubsequences: false)
        guard let i = lines.firstIndex(where: { $0.contains("press Return") }) else {
            return XCTFail("the type-along instruction should still be here")
        }
        let isTopLevel = { (l: Substring) in
            !l.hasPrefix("- ") && !l.hasPrefix("* ") && !l.hasPrefix(" ") && !l.hasPrefix(">")
        }
        XCTAssertTrue(isTopLevel(lines[i]), "the instruction itself is inside a list")
        // The line it sends the reader to is the next PARAGRAPH, so the search
        // has to clear the rest of this one first. Taking the next non-blank
        // line instead finds the instruction's own second line, which is
        // top-level whatever the target does, and the guard passes on a
        // question it never asked.
        guard let blank = lines[(i + 1)...].firstIndex(where: {
            $0.trimmingCharacters(in: .whitespaces).isEmpty
        }) else {
            return XCTFail("the instruction paragraph never ends")
        }
        guard let target = lines[(blank + 1)...].first(where: {
            !$0.trimmingCharacters(in: .whitespaces).isEmpty
        }) else {
            return XCTFail("the instruction points at nothing")
        }
        XCTAssertTrue(isTopLevel(target), "the type-along target is inside a list: \(target)")
    }
}
