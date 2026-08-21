import AppKit
import XCTest
@testable import BirtaJot

/// A settings window is as tall as the pane it is showing, up to a ceiling
/// past which the pane scrolls instead.
///
/// Until this file the claim was checked by `jot/scripts/measure.sh` grepping
/// a `settingsfit` trace line out of a launched app, which cannot run in CI. A
/// window sizes itself before it is shown, so the claim can be asserted where
/// a pull request will see it.
///
/// That arm of `measure.sh` is NOT made redundant by this one, and the two are
/// worth keeping apart. It drives the iCloud switch, which is a pane changing
/// height while it is already on screen, and it skips itself on a Mac with
/// iCloud Drive off, because the switch it needs is disabled there. This
/// covers the other gesture, a pane being switched to, which that arm never
/// reaches.
///
/// The failure it exists for is a window that simply does not follow: it keeps
/// the height it was first sized to, a scroller appears over two rows, and the
/// pane reads as too big for its window rather than as a window that stopped
/// listening.
@MainActor
final class SettingsWindowSizeTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    /// What a pane asked for and what the window gave it.
    private struct Fit {
        let pane: CGFloat
        let content: CGFloat
    }

    private func scrollView(in view: NSView) -> NSScrollView? {
        if let found = view as? NSScrollView { return found }
        for subview in view.subviews {
            if let found = scrollView(in: subview) { return found }
        }
        return nil
    }

    private func fit(of controller: SettingsWindowController, tab: String) -> Fit {
        controller.selectTabForTesting(tab)
        guard let window = controller.window,
              let pane = scrollView(in: window.contentView!)?.documentView else {
            XCTFail("no pane on screen for \(tab)")
            return Fit(pane: 0, content: 0)
        }
        pane.layoutSubtreeIfNeeded()
        return Fit(pane: pane.fittingSize.height,
                   content: window.contentRect(forFrameRect: window.frame).height)
    }

    func testTheWindowShouldFollowThePaneItShows() {
        let controller = SettingsWindowController(onHotkeyChange: { 0 }, onChange: {},
                                                  onShowWelcome: {}, onCheckForUpdates: {})
        defer { controller.window?.close() }
        let cap = SettingsWindowController.Metrics.maxPaneHeight

        let general = fit(of: controller, tab: "general")
        let advanced = fit(of: controller, tab: "advanced")
        let back = fit(of: controller, tab: "general")

        // General is the short pane on every machine this has run on, and the
        // arm being asserted below is the one where a pane fits: a window that
        // gave it less than it asked for would be showing a scroller over a
        // pane that had room.
        XCTAssertLessThanOrEqual(general.pane, cap,
                                 "General no longer fits under the ceiling, so the exact-fit "
                                 + "assertion below is measuring the capped arm instead")
        XCTAssertEqual(general.content, general.pane, accuracy: 0.5)

        // The ceiling holds whichever pane is on screen. Whether any pane
        // actually reaches it depends on the fonts and rows of the machine
        // running this, so it is asserted as a bound rather than as coverage.
        XCTAssertLessThanOrEqual(advanced.content, cap + 0.5)
        XCTAssertLessThanOrEqual(general.content, cap + 0.5)

        // The window followed rather than keeping the height it was built at,
        // and it followed BACK: panes are built once and kept, so a fit that
        // only ran while a pane was being built would pass the first switch
        // and not the second.
        XCTAssertGreaterThan(abs(advanced.content - general.content), 0.5,
                             "the window is the same height for two panes of different heights: "
                             + "general \(general.pane), advanced \(advanced.pane)")
        XCTAssertEqual(back.content, general.content, accuracy: 0.5)
    }
}
