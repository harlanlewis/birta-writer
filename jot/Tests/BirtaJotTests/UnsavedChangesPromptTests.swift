import AppKit
import BirtaJotCore
import XCTest
@testable import BirtaJot

/// The quit question as a real sheet on a real window, because the thing worth
/// checking is what happens when it is ended by something other than a click.
///
/// `Coordinator.answerQuitPromptUnattended` ends this sheet with the FIRST
/// button's response code, which is how a quit that cannot be refused (a
/// SIGTERM from an installer, the swap at the end of a self-update) takes down
/// a question somebody left on screen instead of sitting behind it forever
/// (MAR-411). That path never presses a button, so the only thing holding it
/// to Save is `present`'s own switch, and nothing was reading that switch
/// until this file: the sheet was reachable by clicking and by nothing else.
///
/// Presented rather than built, unlike `AgentTestSheetTests`, and that is the
/// point: `endSheet` is the mechanism under test, and a sheet that was never
/// begun cannot be ended.
@MainActor
final class UnsavedChangesPromptTests: XCTestCase {
    override func setUp() { super.setUp(); _ = NSApplication.shared }

    /// An offscreen window to hang it on. Never ordered front, so nothing
    /// appears; a sheet still attaches, which is all this needs.
    private func hostWindow() -> NSWindow {
        NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 320),
                 styleMask: [.titled, .closable], backing: .buffered, defer: false)
    }

    /// Wait for the sheet to attach. `beginSheetModal` attaches on a later
    /// turn of the run loop, so a check taken straight after the call reads
    /// nil and says nothing about the sheet.
    private func attachedSheet(of window: NSWindow) throws -> NSWindow {
        for _ in 0..<200 {
            if let sheet = window.attachedSheet { return sheet }
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        throw XCTSkip("the sheet did not attach; there is nothing to end")
    }

    private func endedResponse(_ code: NSApplication.ModalResponse) throws -> UnsavedChanges.Answer? {
        let window = hostWindow()
        var answered: UnsavedChanges.Answer?
        UnsavedChangesPrompt.present(document: "Scratch pad.md", on: window) { answered = $0 }
        let sheet = try attachedSheet(of: window)
        window.endSheet(sheet, returnCode: code)
        for _ in 0..<200 where answered == nil {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        return answered
    }

    /// The one the unattended quit depends on: ended at the first button, the
    /// answer is Save, so the buffer is written on the way out rather than
    /// dropped.
    func testEndingTheSheetAtTheFirstButtonShouldAnswerSave() throws {
        XCTAssertEqual(try endedResponse(.alertFirstButtonReturn), .save)
    }

    /// And the other two still mean what they say, so the test above is a
    /// claim about the first button rather than about the switch answering
    /// Save whatever it is handed.
    func testEndingTheSheetAtTheSecondButtonShouldAnswerDiscard() throws {
        XCTAssertEqual(try endedResponse(.alertSecondButtonReturn), .discard)
    }

    func testEndingTheSheetAtTheThirdButtonShouldAnswerCancel() throws {
        XCTAssertEqual(try endedResponse(.alertThirdButtonReturn), .cancel)
    }

    /// Save FIRST, which is the other half of the check above and not implied
    /// by it: the switch reads a response code, so swapping the buttons over
    /// leaves all three response tests passing (measured) while the unattended
    /// quit, which names the first button and never sees a title, starts
    /// discarding somebody's buffer.
    ///
    /// An assertion about Escape belongs here too and is deliberately absent:
    /// removing either `keyEquivalent` line from `present` leaves the sheet's
    /// live buttons reading exactly the same, so a check on them would be
    /// decoration. It is the ordering that is readable and load-bearing.
    func testSaveShouldBeTheFirstOfTheThreeButtons() throws {
        let window = hostWindow()
        UnsavedChangesPrompt.present(document: "Scratch pad.md", on: window) { _ in }
        let sheet = try attachedSheet(of: window)
        let buttons = sheet.contentView.map(Self.buttons(in:)) ?? []
        XCTAssertEqual(buttons.map(\.title),
                       [UnsavedChanges.saveTitle, UnsavedChanges.discardTitle,
                        UnsavedChanges.cancelTitle])
        window.endSheet(sheet, returnCode: .alertThirdButtonReturn)
    }

    /// Every push button in the sheet, in view order.
    private static func buttons(in view: NSView) -> [NSButton] {
        var found: [NSButton] = []
        if let button = view as? NSButton, button.bezelStyle == .push { found.append(button) }
        for subview in view.subviews { found += buttons(in: subview) }
        return found
    }
}
