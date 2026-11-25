import XCTest
@testable import BirtaWriterCore

/// What the on-device model is asked for a subject, and what of its answer
/// is kept: every rule refuses rather than repairs, so the page's own name
/// stands whenever the answer is not a short name.
final class SubjectNamesTests: XCTestCase {
    func testThePromptShouldListTheNotesAndTagsAndNothingElse() {
        let prompt = SubjectNames.prompt(for: .init(id: "a.md", notes: ["Interview loop", "Role profile"], tags: ["hiring"]))
        XCTAssertEqual(prompt, "Notes in the group:\n- Interview loop\n- Role profile\nTags they carry: hiring\nTopic name:")
        XCTAssertFalse(SubjectNames.prompt(for: .init(id: "b.md", notes: ["X"], tags: [])).contains("Tags"),
                       "no tags line for a subject with none")
    }

    func testAPlainNameShouldBeKeptAsWritten() {
        XCTAssertEqual(SubjectNames.clean("Product Design Hiring"), "Product Design Hiring")
    }

    func testDecorationTheModelAddsShouldBeStripped() {
        XCTAssertEqual(SubjectNames.clean("\"Garden Planning.\""), "Garden Planning")
        XCTAssertEqual(SubjectNames.clean("Topic name: **Voice Agents**"), "Voice Agents")
        XCTAssertEqual(SubjectNames.clean("\n\n  Trip Planning\nBecause the notes are about trips."), "Trip Planning")
    }

    func testAnAnswerThatIsNotANameShouldBeRefused() {
        XCTAssertNil(SubjectNames.clean(""))
        XCTAssertNil(SubjectNames.clean("   \n  "))
        XCTAssertNil(SubjectNames.clean("These notes all seem to be about planning a trip to the coast"),
                     "a sentence is an explanation, not a name")
        XCTAssertNil(SubjectNames.clean(String(repeating: "Supercalifragilistic", count: 3)), "past the row's length")
    }
}
