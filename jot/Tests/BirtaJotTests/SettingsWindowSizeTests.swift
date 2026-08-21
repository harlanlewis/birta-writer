import AppKit
import BirtaJotCore
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

    /// A group's intro paragraph reaches the screen.
    ///
    /// `SettingsPaneTests` walks ROW labels, and an intro is deliberately not
    /// one: it sits outside the card, so that walk steps straight over it and
    /// a declared intro that stopped being drawn would pass every other check
    /// in the suite. This is the only thing that looks at it.
    ///
    /// Narrower than it started, and that is worth recording rather than
    /// quietly dropping. It first asserted the pane's WIDTH, which could never
    /// have failed: `pane` pins its stack to one column with a required
    /// constraint, so an over-wide child is clipped rather than allowed to
    /// widen anything, and the measurement came back 520 whatever was done to
    /// it. Then it asserted the paragraph wrapped, which also could not fail,
    /// because `Caption` carries a wrapping width by construction and there is
    /// no way to build one without. Both were dropped. What is left is the arm
    /// that does fail when the drawing stops: with `render` no longer
    /// appending the intro, this is red and nothing else in the suite is.
    func testADeclaredGroupIntroShouldBeDrawnOnItsPane() {
        let controller = SettingsWindowController(onHotkeyChange: { 0 }, onChange: {},
                                                  onShowWelcome: {}, onCheckForUpdates: {})
        defer { controller.window?.close() }
        controller.selectTabForTesting("editor")
        guard let content = controller.window?.contentView else {
            return XCTFail("the settings window has no content view")
        }
        content.layoutSubtreeIfNeeded()

        guard let intro = SettingsForm.editor.compactMap(\.intro).first else {
            return XCTFail("the Editor pane declares no intro to check")
        }
        guard let field = field(in: content, saying: intro) else {
            return XCTFail("the declared intro is not drawn on the Editor pane")
        }
        // It is prose, so it takes more than one line. A single line would
        // mean it was drawn truncated rather than wrapped, which is the one
        // way this can be present and still useless.
        let oneLine = field.font?.boundingRectForFont.height ?? 13
        XCTAssertGreaterThan(field.frame.height, oneLine * 2,
                             "the intro is \(field.frame.height)pt tall for \(intro.count) "
                             + "characters, so it is not wrapping")
    }

    /// The drawn field carrying exactly `text`, anywhere in `view`.
    private func field(in view: NSView, saying text: String) -> NSTextField? {
        if let found = view as? NSTextField, found.stringValue == text { return found }
        for subview in view.subviews {
            if let found = field(in: subview, saying: text) { return found }
        }
        return nil
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
