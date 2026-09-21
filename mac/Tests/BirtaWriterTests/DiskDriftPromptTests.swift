import AppKit
import BirtaWriterCore
import XCTest
@testable import BirtaWriter

/// The question a file changed underneath the app puts, as a real sheet on a
/// real window, for the reason `UnsavedChangesPromptTests` gives: the answer
/// is read off a response code, and nothing else reads that switch.
///
/// It is also how a probe answers it. `Coordinator.answerDriftQuestionForMeasurement`
/// ends this sheet at a button POSITION, since a script cannot click one, so
/// the mapping below is what stands between "Reload from Disk" in a check and
/// the buffer being written over the other tool's file instead.
@MainActor
final class DiskDriftPromptTests: XCTestCase {
    override func setUp() { super.setUp(); _ = NSApplication.shared }

    private func hostWindow() -> NSWindow {
        NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 320),
                 styleMask: [.titled, .closable], backing: .buffered, defer: false)
    }

    /// `beginSheetModal` attaches on a later turn of the run loop, so a check
    /// taken straight after the call reads nil and says nothing.
    private func attachedSheet(of window: NSWindow) throws -> NSWindow {
        for _ in 0..<200 {
            if let sheet = window.attachedSheet { return sheet }
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        throw XCTSkip("the sheet did not attach; there is nothing to end")
    }

    private func endedResponse(_ code: NSApplication.ModalResponse) throws -> DiskDrift.Answer?? {
        let window = hostWindow()
        var answered: DiskDrift.Answer??
        DiskDriftPrompt.present(document: "Note.md", on: window) { answered = .some($0) }
        let sheet = try attachedSheet(of: window)
        window.endSheet(sheet, returnCode: code)
        for _ in 0..<200 where answered == nil {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        return answered
    }

    func testEndingTheSheetAtTheFirstButtonShouldAnswerReload() throws {
        XCTAssertEqual(try endedResponse(.alertFirstButtonReturn), .some(.reload))
    }

    func testEndingTheSheetAtTheSecondButtonShouldAnswerKeep() throws {
        XCTAssertEqual(try endedResponse(.alertSecondButtonReturn), .some(.keep))
    }

    /// Anything else answers NOTHING, rather than picking one. A sheet ended
    /// by the window going away has not been answered, and either default
    /// would throw away one of the two versions on somebody's behalf.
    func testEndingTheSheetAnyOtherWayShouldAnswerNeither() throws {
        XCTAssertEqual(try endedResponse(.alertThirdButtonReturn), .some(nil))
    }

    /// Reload FIRST, which the two response tests above cannot see: they read
    /// a code, so swapping the buttons leaves both passing while a check, and
    /// the Return key, mean the opposite of what they say.
    func testReloadShouldBeTheFirstOfTheTwoButtons() throws {
        let window = hostWindow()
        DiskDriftPrompt.present(document: "Note.md", on: window) { _ in }
        let sheet = try attachedSheet(of: window)
        let buttons = sheet.contentView.map(Self.buttons(in:)) ?? []
        XCTAssertEqual(buttons.map(\.title), [DiskDrift.reloadTitle, DiskDrift.keepTitle])
        window.endSheet(sheet, returnCode: .alertThirdButtonReturn)
    }

    /// An assertion that Escape does not reach Keep My Changes belongs here
    /// and is deliberately absent, for the reason `UnsavedChangesPromptTests`
    /// gives about its own: removing the line in `present` that clears that
    /// key equivalent leaves this file green, because AppKit assigns none to
    /// the second of two buttons anyway. A check that cannot fail is
    /// decoration.
    private static func buttons(in view: NSView) -> [NSButton] {
        var found: [NSButton] = []
        if let button = view as? NSButton, button.bezelStyle == .push { found.append(button) }
        for subview in view.subviews { found += buttons(in: subview) }
        return found
    }
}
