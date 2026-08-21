import AppKit
import BirtaJotCore
import XCTest
@testable import BirtaJot

/// What the Test button's sheet says.
///
/// Built rather than presented, so nothing appears on screen and the two arms
/// are both reachable. The arm that matters is the failure: what a person
/// needs there is the tool's OWN error, which is the only thing that tells
/// them whether the command is missing, unauthenticated or mistyped.
@MainActor
final class AgentTestSheetTests: XCTestCase {
    override func setUp() { super.setUp(); _ = NSApplication.shared }

    /// The text inside the sheet's transcript view.
    private func transcript(of alert: NSAlert) -> String? {
        guard let scroll = alert.accessoryView as? NSScrollView,
              let view = scroll.documentView as? NSTextView else { return nil }
        return view.string
    }

    func testASuccessfulTestShouldSayItWorksAndShowWhatTheToolPrinted() throws {
        let alert = SettingsWindowController.agentTestAlert(
            name: "Claude Code",
            result: AgentProbeResult(succeeded: true, transcript: "Hello!\n", failure: nil))

        XCTAssertEqual(alert.messageText, "It works!")
        XCTAssertEqual(alert.informativeText, "Claude Code")
        XCTAssertEqual(transcript(of: alert), "Hello!")
        XCTAssertEqual(alert.buttons.map(\.title), ["Close"])
    }

    func testAFailedTestShouldShowTheToolsOwnErrorInPlaceOfTheAnswer() throws {
        let alert = SettingsWindowController.agentTestAlert(
            name: "Claude Code",
            result: AgentProbeResult(succeeded: false, transcript: "not logged in\n",
                                     failure: "The command exited with status 4."))

        XCTAssertEqual(alert.messageText, "It did not work.")
        XCTAssertEqual(alert.informativeText, "Claude Code")
        XCTAssertEqual(transcript(of: alert), "not logged in",
                       "the tool's own error is what the reader can act on")
        XCTAssertEqual(alert.buttons.map(\.title), ["Close"])
    }

    /// A command that printed nothing at all still has to say something, or
    /// the sheet is an empty box.
    func testAFailureWithNoOutputShouldFallBackToJotsOwnAccountOfIt() throws {
        let alert = SettingsWindowController.agentTestAlert(
            name: "The agent",
            result: AgentProbeResult(succeeded: false, transcript: "   \n",
                                     failure: "Could not run the agent."))

        XCTAssertEqual(transcript(of: alert), "Could not run the agent.")
    }

    /// Never both. Two explanations of one failure read as two failures.
    func testAFailureWithOutputShouldNotAlsoCarryJotsSummary() throws {
        let alert = SettingsWindowController.agentTestAlert(
            name: "Amp",
            result: AgentProbeResult(succeeded: false, transcript: "boom",
                                     failure: "The command exited with status 1."))

        XCTAssertFalse(transcript(of: alert)?.contains("status 1") ?? true)
    }

    /// The transcript is selectable, so a failure can be copied into a search,
    /// and scrollable, so a long answer does not make a sheet taller than the
    /// screen.
    func testTheTranscriptShouldBeSelectableAndBounded() throws {
        let long = String(repeating: "a line of an agent's answer\n", count: 400)
        let alert = SettingsWindowController.agentTestAlert(
            name: "Amp", result: AgentProbeResult(succeeded: true, transcript: long, failure: nil))

        let scroll = try XCTUnwrap(alert.accessoryView as? NSScrollView)
        let view = try XCTUnwrap(scroll.documentView as? NSTextView)
        XCTAssertTrue(view.isSelectable)
        XCTAssertFalse(view.isEditable)
        XCTAssertTrue(scroll.hasVerticalScroller)
        scroll.layoutSubtreeIfNeeded()
        XCTAssertLessThan(scroll.fittingSize.height, 400,
                          "a long answer must not size the sheet to itself")
    }
}
