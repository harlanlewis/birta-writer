import XCTest
@testable import BirtaJotCore

/// MAR-395: what this side of the host-prompt seam owns, which is parsing a
/// step and refusing one it cannot draw.
///
/// The questions, their order and the composed report are the page's, so there
/// is deliberately nothing here about any of them. What IS here is the two
/// rules a sheet drawn from this data depends on: a step that does not parse
/// is not a step, and validation says the same thing on both surfaces.
final class HostPromptTests: XCTestCase {

    private func step(_ json: String) -> HostPromptStep? {
        let object = try? JSONSerialization.jsonObject(with: Data(json.utf8))
        return HostPromptStep.parse(object)
    }

    // MARK: - Input steps

    func testParsesAnInputStepWithItsValidation() {
        let parsed = step("""
        {"kind":"input","title":"Send Feedback (1 of 4)","prompt":"What's the issue?",
         "placeholder":"e.g. a table","required":{"message":"required, that"},
         "maxLength":{"value":256,"message":"too long, that"}}
        """)

        XCTAssertEqual(parsed, .input(title: "Send Feedback (1 of 4)",
                                      prompt: "What's the issue?",
                                      placeholder: "e.g. a table",
                                      required: "required, that",
                                      maxLength: .init(value: 256, message: "too long, that")))
    }

    func testParsesAnOptionalInputWithNoValidation() {
        let parsed = step(#"{"kind":"input","title":"t","prompt":"p"}"#)

        XCTAssertEqual(parsed, .input(title: "t", prompt: "p", placeholder: nil,
                                      required: nil, maxLength: nil))
    }

    /// An input with no question is half a request. A sheet drawn from it
    /// would ask something the page did not write, and the page would then
    /// record the answer as if it had.
    func testRefusesAnInputWithNoPrompt() {
        XCTAssertNil(step(#"{"kind":"input","title":"t"}"#))
    }

    func testRefusesAStepWithNoTitleOrNoKind() {
        XCTAssertNil(step(#"{"kind":"input","prompt":"p"}"#))
        XCTAssertNil(step(#"{"title":"t","prompt":"p"}"#))
    }

    // MARK: - Pick steps

    func testParsesAPickStepWithItsRows() {
        let parsed = step("""
        {"kind":"pick","title":"where?","placeholder":"you send it",
         "rows":[{"id":"github","label":"GitHub","detail":"needs an account"},
                 {"id":"clipboard","label":"Clipboard"}]}
        """)

        XCTAssertEqual(parsed, .pick(title: "where?", placeholder: "you send it", rows: [
            .init(id: "github", label: "GitHub", detail: "needs an account"),
            .init(id: "clipboard", label: "Clipboard", detail: nil),
        ]))
    }

    /// A pick with no rows is a question with no answers: a sheet the user can
    /// only cancel, which is worse than saying the step cannot be drawn.
    func testRefusesAPickWithNoRows() {
        XCTAssertNil(step(#"{"kind":"pick","title":"t","rows":[]}"#))
        XCTAssertNil(step(#"{"kind":"pick","title":"t"}"#))
    }

    /// All or nothing. A row missing its id could not be reported back, and
    /// silently dropping it would draw a menu short of a choice the page
    /// offered, with no sign that anything was missing.
    func testRefusesAPickWhereAnyRowIsIncomplete() {
        XCTAssertNil(step("""
        {"kind":"pick","title":"t","rows":[{"id":"a","label":"A"},{"label":"B"}]}
        """))
    }

    /// The kind this build cannot draw. It parses to nil so the caller answers
    /// `unsupported` rather than staying silent: an unrecognised message is
    /// dropped here with only a trace line (MAR-390), which would make a step
    /// this app cannot draw look exactly like one it correctly ignored.
    func testRefusesAKindItDoesNotDraw() {
        XCTAssertNil(step(#"{"kind":"colourWheel","title":"t"}"#))
    }

    // MARK: - Validation, which has to agree with the page's

    func testRefusesAnEmptyOrWhitespaceAnswerWhenRequired() {
        XCTAssertEqual(HostPromptStep.validate("", required: "needed", maxLength: nil), "needed")
        XCTAssertEqual(HostPromptStep.validate("  \n ", required: "needed", maxLength: nil), "needed")
    }

    func testAcceptsAnEmptyAnswerWhenNotRequired() {
        XCTAssertNil(HostPromptStep.validate("", required: nil, maxLength: nil))
    }

    /// The boundary in both directions, so the check discriminates a width
    /// rather than passing at every one.
    func testAcceptsAtTheCeilingAndRefusesOnePastIt() {
        let limit = HostPromptStep.MaxLength(value: 4, message: "too long")

        XCTAssertNil(HostPromptStep.validate("abcd", required: nil, maxLength: limit))
        XCTAssertEqual(HostPromptStep.validate("abcde", required: nil, maxLength: limit), "too long")
    }

    /// The trim is measured too, because the page's rule trims before counting
    /// and a surface that did not would accept a title the other refuses.
    func testMeasuresTheTrimmedAnswerAgainstTheCeiling() {
        let limit = HostPromptStep.MaxLength(value: 4, message: "too long")

        XCTAssertNil(HostPromptStep.validate("  abcd  ", required: nil, maxLength: limit))
    }
}

/// The reply, as it reaches the page.
final class HostPromptResultTests: XCTestCase {

    private func decoded(_ message: HostMessage) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(message.jsonString().utf8))
            as? [String: Any]) ?? [:]
    }

    func testAnAnswerCarriesItsValueAndNothingElse() {
        let json = decoded(.hostPromptResult(id: "p1", value: "typed", unsupported: false))

        XCTAssertEqual(json["type"] as? String, "hostPromptResult")
        XCTAssertEqual(json["id"] as? String, "p1")
        XCTAssertEqual(json["value"] as? String, "typed")
        // Absent rather than false: the page's type has it optional, and an
        // explicit false on every reply is noise on the wire.
        XCTAssertNil(json["unsupported"])
    }

    /// A cancel is a null value, never a missing one. The page distinguishes
    /// null from the empty string, so a reply that simply omitted the field
    /// would read as an empty answer and continue the flow.
    func testACancelIsAnExplicitNullValue() {
        let json = decoded(.hostPromptResult(id: "p1", value: nil, unsupported: false))

        XCTAssertTrue(json["value"] is NSNull)
        XCTAssertNil(json["unsupported"])
    }

    func testAnUnsupportedStepSaysSoRatherThanLookingLikeACancel() {
        let json = decoded(.hostPromptResult(id: "p1", value: nil, unsupported: true))

        XCTAssertTrue(json["value"] is NSNull)
        XCTAssertEqual(json["unsupported"] as? Bool, true)
    }

    /// The empty string is a real answer on an optional step, meaning
    /// "nothing to add", and must not collapse into a cancel on the way over.
    func testAnEmptyAnswerStaysAnEmptyStringRatherThanBecomingACancel() {
        let json = decoded(.hostPromptResult(id: "p1", value: "", unsupported: false))

        XCTAssertEqual(json["value"] as? String, "")
        XCTAssertFalse(json["value"] is NSNull)
    }
}

/// What the app reports about itself, and the shape the page's composer reads.
final class HostDiagnosticsTests: XCTestCase {

    func testCarriesTheFieldNamesTheComposerPrints() {
        let json = HostDiagnostics(appVersion: "Version 2026.823.0",
                                   systemVersion: "macOS 26.1.0",
                                   platform: "darwin arm64",
                                   changedSettings: ["autosave: off"]).jsonObject

        XCTAssertEqual(json["extensionVersion"] as? String, "Version 2026.823.0")
        XCTAssertEqual(json["hostVersion"] as? String, "macOS 26.1.0")
        XCTAssertEqual(json["platform"] as? String, "darwin arm64")
        XCTAssertEqual(json["changedSettings"] as? [String], ["autosave: off"])
    }

    /// It has to survive `JSONSerialization`, which is what actually crosses
    /// the bridge; a value it cannot encode would take the whole reply with it.
    func testSurvivesBeingMarshalledToThePage() {
        let message = HostMessage.hostDiagnosticsResult(
            id: "diag-1",
            diagnostics: HostDiagnostics(appVersion: "v", systemVersion: "s",
                                         platform: "p", changedSettings: []))

        let decoded = try? JSONSerialization.jsonObject(
            with: Data(message.jsonString().utf8)) as? [String: Any]

        XCTAssertEqual(decoded?["type"] as? String, "hostDiagnosticsResult")
        XCTAssertEqual(decoded?["id"] as? String, "diag-1")
        XCTAssertEqual((decoded?["diagnostics"] as? [String: Any])?["platform"] as? String, "p")
    }
}
