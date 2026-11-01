import XCTest
@testable import BirtaWriterCore

/// A folder window's new tab, bound to a name before any file has it
/// (MAR-488): which writes it lets through, and when it counts as vacant.
final class UnwrittenNoteTests: XCTestCase {
    /// Every buffer shape the rules tell apart: nothing, whitespace only (a
    /// newline is what an emptied editor can hand back), and text.
    private let blanks = ["", " ", "\n", " \n\t"]
    private let written = ["a", "  # Heading\n"]

    func testANoteWaitingForTextShouldRefuseEveryBlankWriteAndAllowAnyText() {
        for buffer in blanks {
            XCTAssertFalse(UnwrittenNote.mayWrite(awaitingText: true, buffer: buffer),
                           "a blank buffer would make an empty file: \(buffer.debugDescription)")
        }
        for buffer in written {
            XCTAssertTrue(UnwrittenNote.mayWrite(awaitingText: true, buffer: buffer),
                          "text is what the note was waiting for: \(buffer.debugDescription)")
        }
    }

    /// The rule must not reach any other window: a note that is not waiting
    /// writes a blank buffer exactly as it always did, which is how a note
    /// emptied on purpose reaches disk.
    func testANoteNotWaitingShouldWriteWhateverItHolds() {
        for buffer in blanks + written {
            XCTAssertTrue(UnwrittenNote.mayWrite(awaitingText: false, buffer: buffer), buffer.debugDescription)
        }
    }

    func testAnUntouchedUnwrittenNoteShouldBeVacantAndATypedOneShouldNot() {
        for buffer in blanks {
            XCTAssertTrue(UnwrittenNote.isVacant(noteMissing: false, awaitingText: true, buffer: buffer),
                          "nothing to lose by leaving it: \(buffer.debugDescription)")
        }
        for buffer in written {
            XCTAssertFalse(UnwrittenNote.isVacant(noteMissing: false, awaitingText: true, buffer: buffer),
                           "the buffer is the only copy of what was typed: \(buffer.debugDescription)")
        }
    }

    /// The missing-file arm is unchanged by this type: a missing note is
    /// vacant whatever it holds, because leaving it keeps the text in a
    /// recovered file first; and a note on disk is never vacant.
    func testTheMissingArmShouldBeUnchangedAndAWrittenNoteNeverVacant() {
        for buffer in blanks + written {
            for awaiting in [false, true] {
                XCTAssertTrue(UnwrittenNote.isVacant(noteMissing: true, awaitingText: awaiting, buffer: buffer))
            }
            XCTAssertFalse(UnwrittenNote.isVacant(noteMissing: false, awaitingText: false, buffer: buffer),
                           buffer.debugDescription)
        }
    }
}
