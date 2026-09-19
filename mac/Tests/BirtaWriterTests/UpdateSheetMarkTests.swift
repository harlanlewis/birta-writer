import AppKit
import XCTest
@testable import BirtaWriter
@testable import BirtaWriterCore

/// The app's mark on the two update sheets, asked of a sheet that has actually
/// been presented.
///
/// It has to be presented, and that is the whole reason this file exists apart
/// from `UpdatePromptTests` and `UpdateCheckPromptTests`, which build their
/// alerts and never show them. `NSAlert` keeps an icon view either way and
/// fills it from the running application, so `alert.icon` reads back as a real
/// image on a sheet that draws none: as a SHEET, AppKit hides that view,
/// because the sheet is already attached to the window whose app it would be
/// naming. An assertion over the property is therefore satisfied by the broken
/// build, which is what the first version of this check did.
///
/// So the claim is about the view, and the bare alert is carried alongside as
/// the arm that proves the check can tell the two apart: it must come back
/// hidden. Without it a run in which AppKit had stopped hiding anything would
/// report every sheet healthy, having compared nothing.
@MainActor
final class UpdateSheetMarkTests: XCTestCase {
    override func setUp() { super.setUp(); _ = NSApplication.shared }

    /// The icon view AppKit built for `alert`, once the sheet is laid out, or
    /// nil when it built none at all.
    ///
    /// Waited for by ASKING rather than by sleeping a fixed span. AppKit lays
    /// a sheet out on the run loop and not on the call that asked for it, so
    /// the read has to come after that; a sleep long enough on an idle machine
    /// is a sleep a loaded one runs out of, and what that produces is a red
    /// about the machine wearing the words of a red about the product. The
    /// ceiling is generous and is not a measurement of anything: it is the
    /// point past which "not laid out yet" stops being a plausible
    /// explanation.
    private func markView(of alert: NSAlert, on host: NSWindow) -> NSImageView? {
        alert.beginSheetModal(for: host) { _ in }
        func firstImageView() -> NSImageView? {
            var found: NSImageView?
            func walk(_ view: NSView) {
                if found == nil, let image = view as? NSImageView { found = image }
                for sub in view.subviews where found == nil { walk(sub) }
            }
            if let root = alert.window.contentView { walk(root) }
            return found
        }
        let deadline = Date().addingTimeInterval(10)
        var found = firstImageView()
        while found == nil, Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            found = firstImageView()
        }
        // Existence is not arrangement, and the property this is read for is
        // the arrangement's: waiting only for the view to appear would leave
        // the control arm racing a hide that had not been applied yet, and
        // its failure would read as "a plain sheet drew a mark". Forcing the
        // pending layout is what makes the read deterministic rather than
        // early.
        alert.window.layoutIfNeeded()
        host.endSheet(alert.window)
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        return found
    }

    private func host() -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.orderFront(nil)
        return window
    }

    func testAnUpdateSheetShouldDrawTheMarkAPlainSheetHides() throws {
        let window = host()
        defer { window.orderOut(nil) }

        // The control. A sheet nobody gave an icon to draws none, whatever its
        // `icon` property says, and that is the state both sheets below were in.
        let plain = NSAlert()
        plain.messageText = "Birta Writer is up to date."
        plain.addButton(withTitle: "OK")
        let plainMark = try XCTUnwrap(markView(of: plain, on: window),
                                      "AppKit built no icon view at all, so this check compares nothing")
        XCTAssertTrue(plainMark.isHidden,
                      "a plain sheet drew a mark, so this check can no longer tell the two apart")

        let mark = AppIcon.image
        XCTAssertGreaterThan(mark.size.width, 0, "the app's own mark did not resolve")

        // Both sheets, because they are built in two places and only one of
        // them is the one somebody asked for.
        let sheets: [(String, NSAlert)] = [
            ("the asked-for answer",
             UpdateCheckPrompt.build(UpdatePolicy.checkReport(.upToDate, appName: "Birta Writer",
                                                              current: "2026.826.0"))),
            ("the unasked offer",
             UpdatePrompt.build(tag: "v2026.905.0", hasUnwrittenBytes: false, staged: false).alert),
        ]
        for (what, alert) in sheets {
            let drawn = try XCTUnwrap(markView(of: alert, on: window), what)
            XCTAssertFalse(drawn.isHidden, "\(what) drew no mark")
            XCTAssertEqual(drawn.image?.tiffRepresentation, mark.tiffRepresentation,
                           "\(what) drew something other than the app's mark")
            XCTAssertGreaterThan(drawn.frame.width, 0, what)
        }
    }
}
