import XCTest
@testable import BirtaJotCore

/// The rename field's rules, which are the ones that decide whether a file
/// moves. Every case here is reachable by typing into that field.
final class DocumentNameTests: XCTestCase {
    func testANewStemKeepsTheExtensionItHadBefore() {
        // Editing only the stem is the ordinary gesture, and losing `.md`
        // silently would take the note out of everything that reads markdown.
        XCTAssertEqual(DocumentName.resolve(typed: "Notes", current: "Birta Writer.md"),
                       .rename(to: "Notes.md"))
    }

    func testATypedExtensionIsTheirsToChoose() {
        XCTAssertEqual(DocumentName.resolve(typed: "Notes.txt", current: "Birta Writer.md"),
                       .rename(to: "Notes.txt"))
    }

    func testTheSameNameIsNotARename() {
        XCTAssertEqual(DocumentName.resolve(typed: "Birta Writer.md", current: "Birta Writer.md"),
                       .unchanged)
    }

    func testTheSameStemIsNotARenameEither() {
        // The field is seeded with the full name, so this is what committing
        // an untouched field looks like once the extension is re-applied.
        XCTAssertEqual(DocumentName.resolve(typed: "Birta Writer", current: "Birta Writer.md"),
                       .unchanged)
    }

    func testSurroundingWhitespaceIsNotAChange() {
        XCTAssertEqual(DocumentName.resolve(typed: "  Birta Writer.md  ", current: "Birta Writer.md"),
                       .unchanged)
    }

    func testAnEmptyNameIsRejected() {
        guard case .rejected = DocumentName.resolve(typed: "   ", current: "Birta Writer.md") else {
            return XCTFail("blank should be rejected")
        }
    }

    func testAPathSeparatorIsRejectedRatherThanStripped() {
        // Stripping it would move the note somewhere the person did not name
        // and could not see, which is worse than refusing.
        for typed in ["a/b.md", "a:b.md"] {
            guard case .rejected = DocumentName.resolve(typed: typed, current: "Birta Writer.md") else {
                return XCTFail("\(typed) should be rejected")
            }
        }
    }

    func testDotsAloneAreRejected() {
        // `.` and `..` name directories; accepting either would relocate the
        // file rather than rename it.
        for typed in [".", ".."] {
            guard case .rejected = DocumentName.resolve(typed: typed, current: "Birta Writer.md") else {
                return XCTFail("\(typed) should be rejected")
            }
        }
    }

    func testALeadingDotIsAStemAndNotABareExtension() {
        // `.hidden` has no extension by the dot-with-something-either-side
        // rule, so the current one is applied rather than the name being read
        // as an extension with no stem.
        XCTAssertEqual(DocumentName.resolve(typed: ".hidden", current: "Birta Writer.md"),
                       .rename(to: ".hidden.md"))
    }

    func testATrailingDotIsNotAnExtension() {
        XCTAssertEqual(DocumentName.resolve(typed: "Notes.", current: "Birta Writer.md"),
                       .rename(to: "Notes..md"))
    }

    func testAFileWithNoExtensionLendsNothing() {
        XCTAssertEqual(DocumentName.resolve(typed: "Notes", current: "LICENSE"),
                       .rename(to: "Notes"))
    }
}
