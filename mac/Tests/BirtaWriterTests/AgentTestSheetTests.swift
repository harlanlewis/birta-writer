import AppKit
import BirtaWriterCore
import XCTest
@testable import BirtaWriter

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
    func testAFailureWithNoOutputShouldFallBackToTheAppsOwnAccountOfIt() throws {
        let alert = SettingsWindowController.agentTestAlert(
            name: "The agent",
            result: AgentProbeResult(succeeded: false, transcript: "   \n",
                                     failure: "Could not run the agent."))

        XCTAssertEqual(transcript(of: alert), "Could not run the agent.")
    }

    /// Never both. Two explanations of one failure read as two failures.
    func testAFailureWithOutputShouldNotAlsoCarryTheAppsSummary() throws {
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
        XCTAssertLessThan(scroll.frame.height, 400,
                          "a long answer must not size the sheet to itself")
    }

    /// `NSAlert` lays its accessory view out from that view's FRAME. A box
    /// described only by constraints has none until something puts it in a
    /// window, and the alert is not that something: it reads a zero rect,
    /// places the box over the text it belongs under, and draws an empty
    /// bezel beside a failure whose only useful content is inside it.
    func testTheTranscriptShouldCarryTheFrameTheAlertLaysItOutFrom() throws {
        let alert = SettingsWindowController.agentTestAlert(
            name: "Amp", result: AgentProbeResult(succeeded: true, transcript: "Hello!", failure: nil))

        let scroll = try XCTUnwrap(alert.accessoryView as? NSScrollView)
        XCTAssertGreaterThan(scroll.frame.width, 100, "the alert has no width to place it at")
        XCTAssertGreaterThan(scroll.frame.height, 40, "the alert has no height to place it at")
    }

    /// The text has to be laid out to the box's own width, or a wrapped answer
    /// is drawn at a width of nothing and the box reads as empty.
    ///
    /// Asserted as an OVERFLOW rather than as a fit: a document view sized to
    /// its own content is what makes the scroller real, and a zero-frame text
    /// view passes every bound you can write about a size it does not have.
    func testALongAnswerShouldBeLaidOutInsideTheBoxAndOverflowIt() throws {
        let long = String(repeating: "a line of an agent's answer\n", count: 400)
        let alert = SettingsWindowController.agentTestAlert(
            name: "Amp", result: AgentProbeResult(succeeded: true, transcript: long, failure: nil))

        let scroll = try XCTUnwrap(alert.accessoryView as? NSScrollView)
        let view = try XCTUnwrap(scroll.documentView as? NSTextView)
        view.layoutManager?.ensureLayout(for: try XCTUnwrap(view.textContainer))
        // Both halves, and the first is what stops this passing on a text view
        // that was never laid out: a zero-width one matches a zero-width box.
        XCTAssertGreaterThan(view.frame.width, 100, "the text was never laid out to any width")
        XCTAssertEqual(view.frame.width, scroll.contentSize.width, accuracy: 1,
                       "the text is laid out to a width that is not the box's")
        XCTAssertGreaterThan(view.frame.height, scroll.contentSize.height,
                             "400 lines have to overflow the box, or nothing was laid out")
    }
}
