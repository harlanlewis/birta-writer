import AppKit
import XCTest

/// Why Jot's settings rows set `controlSize = .small` on their switches.
///
/// A regular NSSwitch is drawn for a control that is the point of its own
/// view. Down a settings pane it is the loudest thing there, which is what
/// `SettingsWindowController.wireControls` turns down. The system is what
/// honours that request, so it is asserted here rather than written into a
/// comment as a figure: a number in a comment rots in silence.
///
/// A failure here means the system stopped drawing `.small` smaller, and the
/// rows went back to full-size switches with nothing saying so.
@MainActor
final class SettingsSwitchTests: XCTestCase {
    /// A switch answers with the regular size until it has been laid out in a
    /// view hierarchy: `controlSize` reaches `intrinsicContentSize` on the next
    /// layout pass and not when it is set. Reading it any earlier reports the
    /// same size for every control size, which is a comparison that proves
    /// nothing.
    private func laidOutSize(_ size: NSControl.ControlSize) -> NSSize {
        let toggle = NSSwitch()
        toggle.controlSize = size
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 200, height: 100))
        host.addSubview(toggle)
        host.layoutSubtreeIfNeeded()
        return toggle.intrinsicContentSize
    }

    func testASmallSwitchShouldBeSmallerThanARegularOneInBothAxes() {
        let regular = laidOutSize(.regular)
        let small = laidOutSize(.small)
        XCTAssertLessThan(small.width, regular.width, "a .small switch is no narrower than a regular one")
        XCTAssertLessThan(small.height, regular.height, "a .small switch is no shorter than a regular one")
    }
}
