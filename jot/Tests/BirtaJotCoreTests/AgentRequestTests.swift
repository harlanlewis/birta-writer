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

    /// The case the rule exists for: a template ending in the placeholder
    /// hands the prompt positionally, so a flag appended after it is read as
    /// arguments following the prompt rather than as its options.
    func testAFlagShouldGoBeforeATrailingPromptPlaceholder() {
        XCTAssertEqual(
            AgentRequest.adding(
                flag: "--model", value: "opus",
                to: "codex exec --sandbox workspace-write --skip-git-repo-check {prompt}"),
            "codex exec --sandbox workspace-write --skip-git-repo-check --model 'opus' {prompt}")
    }

    func testAFlagShouldBeAppendedWhenThePlaceholderIsNotLast() {
        XCTAssertEqual(
            AgentRequest.adding(flag: "--model", value: "opus",
                                to: "claude -p {prompt} --permission-mode acceptEdits"),
            "claude -p {prompt} --permission-mode acceptEdits --model 'opus'")
    }

    /// A template the user already gave the flag to is theirs; a per-request
    /// addition must not produce the flag twice and let the CLI pick.
    func testATemplateThatAlreadyCarriesTheFlagShouldBeLeftAlone() {
        let template = "claude --model haiku -p {prompt}"
        XCTAssertEqual(
            AgentRequest.adding(flag: "--model", value: "opus", to: template), template)
    }

    /// The value is quoted for the same reason the prompt is: it reaches a
    /// shell, and a model name is data.
    func testAFlagValueShouldBeShellQuoted() {
        XCTAssertTrue(
            AgentRequest.adding(flag: "--effort", value: "a b", to: "claude").contains("'a b'"))
    }

    func testTheHarnessNameShouldBeTheCommandsFirstWordWithoutItsDirectory() {
        XCTAssertEqual(AgentRequest.harnessName(from: "claude -p {prompt}"), "claude")
        XCTAssertEqual(
            AgentRequest.harnessName(
                from: "codex exec --sandbox workspace-write --skip-git-repo-check {prompt}"),
            "codex")
        XCTAssertEqual(AgentRequest.harnessName(from: "/usr/local/bin/claude {prompt}"), "claude")
        XCTAssertNil(AgentRequest.harnessName(from: "   "))
    }

    func testAFlagThisOneIsAPrefixOfShouldNotCountAsCarryingIt() {
        // `--model` is a prefix of `--model-fallback`. Read as a substring, a
        // template naming the second reads as already naming the first, and
        // the request's model is dropped with nothing to say so.
        let template = "claude --model-fallback sonnet {prompt}"
        let out = AgentRequest.adding(flag: "--model", value: "opus", to: template)
        XCTAssertEqual(out, "claude --model-fallback sonnet --model 'opus' {prompt}")
    }

    func testAFlagSpelledWithAnEqualsShouldCountAsCarryingIt() {
        let template = "claude --model=opus {prompt}"
        XCTAssertEqual(AgentRequest.adding(flag: "--model", value: "sonnet", to: template), template)
    }
}
