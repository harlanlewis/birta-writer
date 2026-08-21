import XCTest
@testable import BirtaJotCore

/// The precedence, and the property the title popover's rename depends on:
/// the slot the path was READ from is the slot a move must be WRITTEN to.
final class ActiveBindingTests: XCTestCase {
    private let doc = URL(fileURLWithPath: "/tmp/jot-test/Chosen.md")
    private let note = URL(fileURLWithPath: "/tmp/jot-test/Note.md")
    private let pad = URL(fileURLWithPath: "/tmp/jot-test/Birta Writer.md")

    func testADocumentOutranksEverything() {
        XCTAssertEqual(ActiveBinding.slot(hasDocument: true, hasCurrentNote: true), .document)
        XCTAssertEqual(ActiveBinding.url(document: doc, currentNote: note, scratchpad: pad), doc)
    }

    func testANoteOutranksTheScratchpad() {
        XCTAssertEqual(ActiveBinding.slot(hasDocument: false, hasCurrentNote: true), .currentNote)
        XCTAssertEqual(ActiveBinding.url(document: nil, currentNote: note, scratchpad: pad), note)
    }

    func testTheScratchpadIsWhereItStarts() {
        XCTAssertEqual(ActiveBinding.slot(hasDocument: false, hasCurrentNote: false), .scratchpad)
        XCTAssertEqual(ActiveBinding.url(document: nil, currentNote: nil, scratchpad: pad), pad)
    }

    /// The one that matters for a rename. Enumerated from `Slot.allCases`
    /// rather than from a list here, so a fourth setting cannot be added and
    /// left out of the sweep, and the count is asserted because a sweep that
    /// reached nothing would pass.
    func testEverySlotIsReachableAndNamesTheUrlItSupplied() {
        var reached: Set<ActiveBinding.Slot> = []
        // Every combination of the two higher settings being present.
        for hasDoc in [true, false] {
            for hasNote in [true, false] {
                let slot = ActiveBinding.slot(hasDocument: hasDoc, hasCurrentNote: hasNote)
                reached.insert(slot)
                let url = ActiveBinding.url(document: hasDoc ? doc : nil,
                                            currentNote: hasNote ? note : nil,
                                            scratchpad: pad)
                // The slot and the URL must be the same answer, or a rename
                // writes the new path into a setting that was not being used.
                let expected: URL
                switch slot {
                case .document: expected = doc
                case .currentNote: expected = note
                case .scratchpad: expected = pad
                }
                XCTAssertEqual(url, expected, "slot \(slot.rawValue) named a different file")
            }
        }
        XCTAssertEqual(reached, Set(ActiveBinding.Slot.allCases),
                       "every slot should be reachable from some combination")
        XCTAssertEqual(ActiveBinding.Slot.allCases.count, 3,
                       "a new slot needs a case in the switch above, not just here")
    }
}

/// Which stored setting a moved file came from.
///
/// Separate from the precedence tests above because it answers a different
/// question, and one the precedence rule CANNOT answer after a move: a slot
/// whose file no longer exists reads as empty, so asking "which slot is in
/// force" names the slot the binding fell back to.
final class ActiveBindingRebindTests: XCTestCase {
    private let document = URL(fileURLWithPath: "/tmp/doc.md")
    private let currentNote = URL(fileURLWithPath: "/tmp/Note 2026-08-20.md")
    private let scratchpad = URL(fileURLWithPath: "/tmp/Birta Writer.md")
    private let moved = URL(fileURLWithPath: "/tmp/Renamed.md")

    func testAMovedFileShouldBeMatchedToTheSettingThatNamedIt() {
        XCTAssertEqual(ActiveBinding.slot(holding: document, document: document,
                                          currentNote: currentNote, scratchpad: scratchpad), .document)
        XCTAssertEqual(ActiveBinding.slot(holding: currentNote, document: document,
                                          currentNote: currentNote, scratchpad: scratchpad), .currentNote)
        XCTAssertEqual(ActiveBinding.slot(holding: scratchpad, document: document,
                                          currentNote: currentNote, scratchpad: scratchpad), .scratchpad)
    }

    /// The defect. A note made by New Note is renamed in Finder; the old path
    /// is now gone, so the precedence rule reports `.scratchpad` and the
    /// rename would be written into the scratchpad setting, repointing it at
    /// somebody's renamed note. Matching the old path does not care that the
    /// file has moved.
    func testARenamedCurrentNoteShouldNotBeWrittenIntoTheScratchpadSetting() {
        let byPrecedence = ActiveBinding.slot(hasDocument: false, hasCurrentNote: false)
        XCTAssertEqual(byPrecedence, .scratchpad, "the rule this one exists to not be")
        XCTAssertEqual(ActiveBinding.slot(holding: currentNote, document: nil,
                                          currentNote: currentNote, scratchpad: scratchpad),
                       .currentNote)
    }

    /// The default scratchpad location is stored nowhere, so nothing names it.
    func testAFileNoSettingNamesShouldMatchNothing() {
        XCTAssertNil(ActiveBinding.slot(holding: moved, document: nil,
                                        currentNote: nil, scratchpad: nil))
        XCTAssertNil(ActiveBinding.slot(holding: moved, document: document,
                                        currentNote: currentNote, scratchpad: scratchpad))
    }

    func testAPathSpelledWithDotsShouldStillMatch() {
        XCTAssertEqual(ActiveBinding.slot(holding: URL(fileURLWithPath: "/tmp/./doc.md"),
                                          document: document, currentNote: nil, scratchpad: nil),
                       .document)
    }

    /// Precedence is kept even here: a path stored in two settings at once
    /// belongs to the one that outranks the other, so a rebind cannot write
    /// the lower slot and leave the higher one naming the old path.
    func testAPathStoredTwiceShouldMatchTheSlotThatOutranks() {
        XCTAssertEqual(ActiveBinding.slot(holding: scratchpad, document: nil,
                                          currentNote: scratchpad, scratchpad: scratchpad),
                       .currentNote)
    }
}
