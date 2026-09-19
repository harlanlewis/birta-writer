import AppKit
import BirtaWriterCore
import XCTest
@testable import BirtaWriter

/// How tall the panel's titlebar band is, and where the window's own furniture
/// sits in it, read off a real window that has been laid out.
///
/// Nothing here writes a height down, and that is the point. The band is the
/// system's number under the toolbar style the panel asks for
/// (`AppPanel.installBandToolbar`), the page is handed that same number to
/// size its first toolbar row from, and macOS places the traffic lights in it.
/// A test asserting "40" would be asserting a figure this app does not own; it
/// would go red on the macOS that changes it, naming nothing anyone could act
/// on, and it would pass on a build where the toolbar had been dropped and the
/// system happened to agree.
///
/// So the claims are relative: the band is TALLER than the bare titlebar a
/// window of the same style mask gets without the toolbar, and everything in
/// it is centred on the band rather than on some other height. The bare window
/// is the control, and it is what says the toolbar is doing the work: without
/// it, a build that installed no toolbar at all would pass every line below,
/// because a bare band is centred on itself just as happily.
@MainActor
final class TitlebarBandGeometryTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    /// The height of the band, and the distance from the window's top edge to
    /// the middle of its close button.
    private func band(of window: NSWindow) -> (height: CGFloat, closeMid: CGFloat) {
        window.orderFront(nil)
        window.layoutIfNeeded()
        let height = window.frame.height - window.contentLayoutRect.height
        let close = window.standardWindowButton(.closeButton)
        let mid = close.map { window.frame.height - $0.convert($0.bounds, to: nil).midY } ?? -1
        window.orderOut(nil)
        return (height, mid)
    }

    /// A plain window with the panel's own style mask and no toolbar: the band
    /// the panel used to have.
    private func bareBand() -> CGFloat {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        return band(of: window).height
    }

    func testTheBandShouldBeTallerThanABareTitlebarAndCentreTheWindowsButtonsInIt() {
        let panel = AppPanel(remembersFrame: false)
        panel.placeIfUnplaced()
        let measured = band(of: panel)

        XCTAssertGreaterThan(measured.height, bareBand(),
                             "the panel's band is no taller than a window with no toolbar")
        // Centred by macOS, which is the whole reason the height is asked for
        // rather than the buttons being moved.
        XCTAssertEqual(measured.closeMid, measured.height / 2, accuracy: 0.5)
    }

    /// The title and the file buttons sit on the same axis as the traffic
    /// lights, at whatever height the band turns out to be.
    ///
    /// They are centred on `bounds`, and the accessory's bounds are the band's
    /// only because AppKit stretches it: an accessory left at the height it
    /// was built with would centre everything half the difference too high,
    /// which is the defect this pins and which no screenshot of a 32-point
    /// band would have shown.
    func testTheTitleAndTheFileButtonsShouldSitOnTheTrafficLightsAxis() throws {
        let panel = AppPanel(remembersFrame: false)
        panel.placeIfUnplaced()
        let accessory = TitleBarAccessory()
        accessory.titleView.setActions(TitlebarActionsView.shipped)
        accessory.titleView.show(url: URL(fileURLWithPath: "/tmp/Note.md"), edited: false)
        panel.addTitlebarAccessoryViewController(accessory)
        panel.orderFront(nil)
        panel.layoutIfNeeded()
        // Offered, so the buttons are where they are drawn rather than where a
        // withdrawn row would report them.
        _ = accessory.titleView.actionsForMeasurement(hovered: true)
        accessory.titleView.layoutSubtreeIfNeeded()
        defer { panel.orderOut(nil) }

        let top = panel.frame.height
        let bandHeight = top - panel.contentLayoutRect.height
        XCTAssertEqual(accessory.view.frame.height, bandHeight, accuracy: 0.5,
                       "AppKit did not stretch the accessory to the band, so the rest measures nothing")

        let close = try XCTUnwrap(panel.standardWindowButton(.closeButton))
        let axis = top - close.convert(close.bounds, to: nil).midY
        XCTAssertEqual(top - accessory.titleView.labelFrameInWindow().midY, axis, accuracy: 0.5)

        let buttons = accessory.titleView.actionsView.buttons
        XCTAssertFalse(buttons.isEmpty, "no file buttons, so the axis below is compared against nothing")
        for button in buttons {
            XCTAssertEqual(top - button.convert(button.bounds, to: nil).midY, axis, accuracy: 0.5,
                           button.accessibilityLabel() ?? "")
        }
    }
}
