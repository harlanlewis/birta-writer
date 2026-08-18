import XCTest
@testable import BirtaJotCore

/// The same cases `src/__tests__/askAgent.test.ts` asserts, in Swift.
///
/// Deliberately duplicated rather than sampled: the point of the port is that
/// both surfaces hand the same line to the same CLI, and a case that holds in
/// one language and not the other is exactly the drift this is here to catch.
/// Only the POSIX half of `shellQuote` is mirrored; Jot is macOS-only and has
/// no PowerShell branch to test.
final class AgentRequestTests: XCTestCase {
    func testARequestAndAReferenceShouldComposeToOneLineNamingTheLocationFirst() {
        XCTAssertEqual(
            AgentRequest.compose(prompt: "add a mermaid diagram", reference: "notes/plan.md#L12"),
            "In notes/plan.md#L12: add a mermaid diagram")
    }

    func testNewlinesAndRunsOfSpacesInTheRequestShouldCollapseToSingleSpaces() {
        XCTAssertEqual(
            AgentRequest.compose(prompt: "  rewrite\n\nthis   section ", reference: "a.md#L1-L3"),
            "In a.md#L1-L3: rewrite this section")
    }

    func testShellQuoteShouldSingleQuoteAndEscapeEmbeddedSingleQuotes() {
        XCTAssertEqual(AgentRequest.shellQuote("it's $HOME `x`"), "'it'\\''s $HOME `x`'")
    }

    /// The property the quoting exists for: prose is data. Anything a shell
    /// would otherwise expand has to survive as characters.
    func testShellQuoteShouldLeaveEveryExpansionCharacterLiteral() {
        let quoted = AgentRequest.shellQuote("$HOME `id` $(id) \\ \"x\"")
        XCTAssertTrue(quoted.hasPrefix("'") && quoted.hasSuffix("'"))
        XCTAssertTrue(quoted.contains("$HOME"))
        XCTAssertTrue(quoted.contains("$(id)"))
    }

    func testATemplateWithThePlaceholderShouldHaveEveryOccurrenceReplaced() {
        XCTAssertEqual(
            AgentRequest.expand(template: "claude -p {prompt} --permission-mode acceptEdits",
                                quotedPrompt: "'go'"),
            "claude -p 'go' --permission-mode acceptEdits")
    }

    func testATemplateWithoutThePlaceholderShouldGetThePromptAppended() {
        XCTAssertEqual(AgentRequest.expand(template: "claude", quotedPrompt: "'go'"), "claude 'go'")
        XCTAssertEqual(AgentRequest.expand(template: "  claude  ", quotedPrompt: "'go'"), "claude 'go'")
    }

    func testTheHarnessNameShouldBeTheCommandsFirstWordWithoutItsDirectory() {
        XCTAssertEqual(AgentRequest.harnessName(from: "claude -p {prompt}"), "claude")
        XCTAssertEqual(AgentRequest.harnessName(from: "codex exec --full-auto {prompt}"), "codex")
        XCTAssertEqual(AgentRequest.harnessName(from: "/usr/local/bin/claude {prompt}"), "claude")
        XCTAssertNil(AgentRequest.harnessName(from: "   "))
    }
}
