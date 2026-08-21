import XCTest
@testable import BirtaJotCore

/// Which tool a command line is running, which is what the Settings pull-down
/// says with its menu shut.
///
/// The claim being made on screen is narrow and worth keeping narrow: the menu
/// names the PROGRAM, never the command. Arguments are exactly what somebody
/// is expected to have changed, so a matched name has to survive them, and a
/// command naming nothing here is somebody running their own thing rather than
/// an error.
final class AgentPresetTests: XCTestCase {
    func testAPresetsOwnTemplateShouldMatchIt() {
        // Over `allCases`, so a preset added without a recognisable program
        // fails here rather than being a menu entry that never names itself.
        var matched = 0
        for preset in AgentPreset.allCases {
            XCTAssertEqual(AgentPreset.matching(command: preset.template), preset,
                           "\(preset.title) does not recognise its own template")
            matched += 1
        }
        // A floor on what actually returned a verdict, so this cannot pass by
        // enumerating nothing.
        XCTAssertEqual(matched, AgentPreset.allCases.count)
        XCTAssertGreaterThanOrEqual(matched, 5)
    }

    func testEveryPresetShouldNameADistinctProgram() {
        // Two presets on one program would make the menu's answer arbitrary:
        // whichever came first in the enum would name a command the other one
        // is running just as well.
        let programs = AgentPreset.allCases.compactMap { AgentPreset.program(of: $0.template) }
        XCTAssertEqual(programs.count, AgentPreset.allCases.count)
        XCTAssertEqual(Set(programs).count, programs.count,
                       "two presets run the same program: \(programs.sorted())")
    }

    func testChangedArgumentsShouldStillNameTheTool() {
        XCTAssertEqual(AgentPreset.matching(command: "claude -p {prompt}"), .claudeCode)
        XCTAssertEqual(AgentPreset.matching(command: "claude --model opus -p {prompt}"), .claudeCode)
        // No arguments at all is still a command naming a tool.
        XCTAssertEqual(AgentPreset.matching(command: "claude"), .claudeCode)
    }

    func testAFullPathShouldNameTheToolAtTheEndOfIt() {
        XCTAssertEqual(AgentPreset.matching(command: "/opt/homebrew/bin/claude -p {prompt}"),
                       .claudeCode)
        XCTAssertEqual(AgentPreset.matching(command: "\"/Users/me/bin/codex\" exec {prompt}"),
                       .codex)
    }

    func testLeadingSpaceAndCaseShouldNotDecideIt() {
        XCTAssertEqual(AgentPreset.matching(command: "   gemini -p {prompt}"), .gemini)
        XCTAssertEqual(AgentPreset.matching(command: "GEMINI -p {prompt}"), .gemini)
    }

    func testACommandNamingNoKnownToolShouldMatchNothing() {
        // Not an error, and not a near miss either: the pull-down simply goes
        // back to asking.
        for command in ["", "   ", "my-own-agent --run {prompt}", "./scripts/ask.sh {prompt}"] {
            XCTAssertNil(AgentPreset.matching(command: command),
                         "\(command) should name no preset")
        }
    }

    /// A tool's name has to be the FIRST word, not a word anywhere in the line.
    ///
    /// The failure this rules out: a wrapper script that mentions the tool in
    /// an argument would otherwise be reported as that tool, and the menu
    /// would name a program the command does not run.
    func testANameInTheArgumentsShouldNotCount() {
        XCTAssertNil(AgentPreset.matching(command: "sh -c \"claude -p {prompt}\""))
        XCTAssertNil(AgentPreset.matching(command: "env FOO=1 claude -p {prompt}"))
    }
}
