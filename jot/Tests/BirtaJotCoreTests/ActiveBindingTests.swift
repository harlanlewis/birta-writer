import XCTest
@testable import BirtaJotCore

/// The precedence, and the property the title popover's rename depends on:
/// the slot the path was READ from is the slot a move must be WRITTEN to.
final class ActiveBindingTests: XCTestCase {
    private let doc = URL(fileURLWithPath: "/tmp/jot-test/Chosen.md")
    private let note = URL(fileURLWithPath: "/tmp/jot-test/Note.md")
    private let pad = URL(fileURLWithPath: "/tmp/jot-test/Birta Jot.md")

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
