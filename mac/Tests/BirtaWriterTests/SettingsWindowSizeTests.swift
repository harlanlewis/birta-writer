import AppKit
import BirtaWriterCore
import XCTest
@testable import BirtaWriter

/// A settings window is as tall as the pane it is showing, up to a ceiling
/// past which the pane scrolls instead.
///
/// Until this file the claim was checked by `mac/scripts/measure.sh` grepping
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

    /// The RELEASE window unless a test says otherwise, which is what every
    /// arm here measured before the flavour was injectable.
    private func makeController(_ flavour: AppFlavor = .release) -> SettingsWindowController {
        SettingsWindowController(flavour: flavour, onHotkeyChange: { 0 }, onChange: { _ in }, onChangeEverywhere: {},
                                 onShowWelcome: {}, onCheckForUpdates: {})
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
        let controller = makeController()
        defer { controller.window?.close() }
        controller.selectTabForTesting("aiAgent")
        guard let content = controller.window?.contentView else {
            return XCTFail("the settings window has no content view")
        }
        content.layoutSubtreeIfNeeded()

        // Every paragraph, not the first: an intro is a list now, and reading
        // only its head would let the rest stop being drawn with this green.
        let declared = SettingsForm.aiAgent.intro
        XCTAssertFalse(declared.isEmpty, "the AI Agent pane declares no intro to check")
        for paragraph in declared {
            XCTAssertNotNil(field(in: content, saying: paragraph),
                            "a declared intro paragraph is not drawn on the AI Agent pane")
        }
        guard let intro = declared.first,
              let field = field(in: content, saying: intro) else {
            return XCTFail("the declared intro is not drawn on the AI Agent pane")
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

    /// The ceiling fits the tallest each pane gets, not the one this Mac draws.
    ///
    /// The failure this exists for: General grew past the ceiling and the
    /// suite was green locally and red on a runner, because the runner has
    /// iCloud Drive switched off and therefore draws the Location row and a
    /// caption explaining it, about sixty points that a Mac with iCloud on
    /// never shows. A height check that measures only the machine it is on
    /// is a check whose answer depends on who runs it.
    ///
    /// The BUILD is the second thing it depended on, for the same reason and
    /// with the same shape. A development build draws the Welcome screen row
    /// that no release has, so its Advanced pane is the tallest the app can
    /// ever put on screen, and until the flavour was injectable this walked
    /// the release panes only: `AppFlavor.current` is fixed by the process,
    /// and under `swift test` that process is Xcode's xctest tool, which is
    /// neither of our bundle ids and therefore reads as the release. So the
    /// ceiling had never been asked about the widest pane there is.
    func testEveryPaneShouldFitTheCeilingWithEveryConditionalRowShown() {
        let cap = SettingsWindowController.Metrics.maxPaneHeight
        // From the type, so a build added later is measured without this file
        // being touched.
        for flavour in AppFlavor.allCases {
            let controller = makeController(flavour)
            defer { controller.window?.close() }
            for name in SettingsWindowController.tabNames {
                controller.selectTabForTesting(name)
                controller.showEveryConditionalRowForTesting()
                let tallest = fit(of: controller, tab: name)
                XCTAssertLessThanOrEqual(tallest.pane, cap,
                                         "the \(name) pane of a \(flavour) build wants "
                                         + "\(tallest.pane)pt with every conditional row shown, "
                                         + "over a \(cap)pt ceiling, so it scrolls on a machine "
                                         + "that draws them all")
            }
        }
    }

    /// The loop above measures both builds and would measure two identical
    /// sets of panes just as happily, reporting nothing. This is the arm that
    /// says the build reaches the layout at all: a development build's
    /// Advanced pane carries a row no release has, so it is taller, and the
    /// pair is what is asserted rather than either height on its own.
    ///
    /// It is the taller ADVANCED and not the tallest pane in the app, which is
    /// worth being exact about: General carries far more, and the loop above
    /// is where the ceiling is actually under pressure. What this pins is that
    /// the flavour changes the drawing, which a number could not say.
    ///
    /// A row's height is the machine's to decide, so what is asserted is the
    /// ordering and a floor under the gap rather than a measurement. Half a
    /// point is the accuracy every other comparison in this file uses; a row
    /// and its sentence are far more than that, so a gap under it would mean
    /// the row was declared and not drawn.
    func testADevelopmentBuildsAdvancedPaneShouldBeTallerThanTheReleases() {
        let dev = makeController(.dev)
        defer { dev.window?.close() }
        let release = makeController(.release)
        defer { release.window?.close() }
        dev.selectTabForTesting("advanced")
        dev.showEveryConditionalRowForTesting()
        release.selectTabForTesting("advanced")
        release.showEveryConditionalRowForTesting()

        let taller = fit(of: dev, tab: "advanced")
        let shorter = fit(of: release, tab: "advanced")

        XCTAssertGreaterThan(taller.pane, shorter.pane + 0.5,
                             "a development build's Advanced pane is no taller than the "
                             + "release's, so the Welcome screen row is declared and not drawn: "
                             + "dev \(taller.pane), release \(shorter.pane)")
        // And the window followed it. A pane that grew under a window that did
        // not is the failure this whole file exists for, and the dev Advanced
        // is the one pane no other arm here has ever put on screen.
        XCTAssertEqual(taller.content, taller.pane, accuracy: 0.5,
                       "the window is \(taller.content)pt for a \(taller.pane)pt pane that fits "
                       + "under the \(SettingsWindowController.Metrics.maxPaneHeight)pt ceiling")
    }

    func testTheWindowShouldFollowThePaneItShows() {
        let controller = makeController()
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
