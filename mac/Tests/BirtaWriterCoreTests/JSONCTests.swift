import XCTest
@testable import BirtaWriterCore

final class JSONCTests: XCTestCase {
    private func parse(_ text: String) throws -> Any {
        try JSONC.object(from: Data(text.utf8))
    }

    func testCommentsShouldBeStrippedOutsideStringsAndKeptInsideThem() throws {
        let text = """
        {
          // a line comment
          "a": "http://not-a-comment", /* a block
          comment */ "b": "/* kept */"
        }
        """
        let object = try XCTUnwrap(try parse(text) as? [String: String])
        XCTAssertEqual(object, ["a": "http://not-a-comment", "b": "/* kept */"])
    }

    func testTrailingCommasShouldBeDroppedBeforeAClosingBracketOrBrace() throws {
        let text = """
        { "list": [1, 2, 3, /* last */ ], "obj": { "k": true, }, }
        """
        let object = try XCTUnwrap(try parse(text) as? [String: Any])
        XCTAssertEqual(object["list"] as? [Int], [1, 2, 3])
        XCTAssertEqual((object["obj"] as? [String: Bool])?["k"], true)
    }

    func testACommaThatIsNotTrailingShouldStay() throws {
        XCTAssertEqual(JSONC.strip(##"["a", "b"]"##), ##"["a", "b"]"##)
        XCTAssertEqual(JSONC.strip(##"{"a": ",", "b": "}"}"##), ##"{"a": ",", "b": "}"}"##)
    }

    func testAnEscapedQuoteShouldNotEndTheString() throws {
        let object = try XCTUnwrap(try parse(##"{"a": "say \"hi\" // still text"}"##) as? [String: String])
        XCTAssertEqual(object["a"], ##"say "hi" // still text"##)
    }

    func testPlainJSONShouldPassThroughUnchanged() {
        let text = ##"{"colors": {"editor.background": "#ffffff"}, "n": [1, 2]}"##
        XCTAssertEqual(JSONC.strip(text), text)
    }

    func testNonUTF8ShouldThrowRatherThanReadAsEmpty() {
        XCTAssertThrowsError(try JSONC.object(from: Data([0xff, 0xfe, 0x00])))
    }
}
