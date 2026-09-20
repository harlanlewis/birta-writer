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

    /// The cap is the one `fitWindowToPane` applies, the SMALLER of the
    /// ceiling and the screen the window is on, and the panes are picked by
    /// measurement rather than by name. A CI runner's display is well under
    /// the ceiling, and General, once it draws the rows a Mac with iCloud
    /// Drive off shows, is taller than that display: naming it as the pane
    /// that fits reads as a claim about the display rather than the window,
    /// and fails there for a reason that is about the display. The shortest
    /// pane is the one that has to fit somewhere, and if none does the run
    /// says so rather than measuring the capped arm as though it were exact.
    func testTheWindowShouldFollowThePaneItShows() {
        let controller = makeController()
        defer { controller.window?.close() }
        let screenHeight = (controller.window?.screen ?? NSScreen.main)?.visibleFrame.height
            ?? SettingsWindowController.Metrics.maxPaneHeight
        let cap = min(SettingsWindowController.Metrics.maxPaneHeight, screenHeight)

        // From the type, so a pane added later is measured without this file
        // being touched, and the enumeration asserts its own reach.
        let fits = SettingsWindowController.tabNames.map { ($0, fit(of: controller, tab: $0)) }
        XCTAssertGreaterThan(fits.count, 1, "fewer than two panes to compare")
        guard let shortest = fits.min(by: { $0.1.pane < $1.1.pane }),
              let tallest = fits.max(by: { $0.1.pane < $1.1.pane }) else {
            return XCTFail("no panes measured")
        }

        // The arm being asserted is the one where a pane fits: a window that
        // gave it less than it asked for would be showing a scroller over a
        // pane that had room.
        XCTAssertLessThanOrEqual(shortest.1.pane, cap,
                                 "no pane fits under \(cap)pt on this screen (shortest is "
                                 + "\(shortest.0) at \(shortest.1.pane)pt), so the exact-fit "
                                 + "assertion below is measuring the capped arm instead")
        XCTAssertEqual(shortest.1.content, shortest.1.pane, accuracy: 0.5,
                       "the window gave \(shortest.0) \(shortest.1.content)pt for a "
                       + "\(shortest.1.pane)pt pane that fits under \(cap)pt")

        // The cap holds whichever pane is on screen. Whether any pane actually
        // reaches it depends on the fonts, rows and display of the machine
        // running this, so it is asserted as a bound rather than as coverage.
        for (name, measured) in fits {
            XCTAssertLessThanOrEqual(measured.content, cap + 0.5,
                                     "\(name) was given \(measured.content)pt over a \(cap)pt cap")
        }

        // The window followed rather than keeping the height it was built at,
        // and it followed BACK: panes are built once and kept, so a fit that
        // only ran while a pane was being built would pass the first switch
        // and not the second.
        _ = fit(of: controller, tab: tallest.0)
        let back = fit(of: controller, tab: shortest.0)
        XCTAssertGreaterThan(abs(tallest.1.content - shortest.1.content), 0.5,
                             "the window is the same height for two panes of different heights: "
                             + "\(shortest.0) \(shortest.1.pane), \(tallest.0) \(tallest.1.pane)")
        XCTAssertEqual(back.content, shortest.1.content, accuracy: 0.5,
                       "the window did not follow back to \(shortest.0)")
    }
}

/// The theme card is a strip taller in one shape than the other, and the
/// window has to follow the flip as it follows a pane's conditional rows.
@MainActor
final class AppearanceCardShapeSizeTests: XCTestCase {
    func testTheWindowShouldFollowTheThemeCardsShape() throws {
        let saved = Prefs.appearance
        defer { Prefs.appearance = saved }
        Prefs.appearance = AppearanceSettings()
        let controller = SettingsWindowController(
            flavour: .release, onHotkeyChange: { 0 }, onChange: { _ in }, onChangeEverywhere: {},
            onShowWelcome: {}, onCheckForUpdates: {},
            onAppearanceChange: { Prefs.appearance = $0 })
        defer { controller.window?.close() }
        controller.selectTabForTesting("appearance")
        func fit() throws -> (pane: CGFloat, content: CGFloat) {
            let window = try XCTUnwrap(controller.window)
            let pane = try XCTUnwrap(window.contentView?.firstDescendant(NSScrollView.self)?.documentView)
            pane.layoutSubtreeIfNeeded()
            return (pane.fittingSize.height, window.contentRect(forFrameRect: window.frame).height)
        }
        let slots = try fit()
        XCTAssertEqual(controller.themeCardShapeForTesting, "slots")
        controller.setFollowSystemForTesting(false)
        let held = try fit()
        XCTAssertEqual(controller.themeCardShapeForTesting, "held")
        XCTAssertGreaterThan(slots.pane - held.pane, 50, "one strip fewer is not a strip's height shorter")
        // Both fits are exact only below the cap, and the cap is the one
        // `fitWindowToPane` uses: the SMALLER of the ceiling and the screen
        // the window is on. Taking the ceiling alone reads as a claim about
        // this pane on a display that cannot show it, and fails there for a
        // reason that is about the display: a CI runner's screen is shorter
        // than a desk's, which is the same difference `Metrics.maxPaneHeight`
        // warns about one file over. The arm above is the one that holds
        // everywhere, since it compares two panes rather than a window.
        let screenHeight = (controller.window?.screen ?? NSScreen.main)?.visibleFrame.height
            ?? SettingsWindowController.Metrics.maxPaneHeight
        let cap = min(SettingsWindowController.Metrics.maxPaneHeight, screenHeight)
        try XCTSkipUnless(slots.pane <= cap,
                          "the Appearance pane is over the cap on this machine (pane \(slots.pane), "
                            + "cap \(cap)), so the fit is capped and the arms below measure the screen")
        XCTAssertEqual(slots.content, slots.pane, accuracy: 0.5)
        XCTAssertEqual(held.content, held.pane, accuracy: 0.5, "the window kept the taller shape's height")
        controller.setFollowSystemForTesting(true)
        let back = try fit()
        XCTAssertEqual(back.content, slots.content, accuracy: 0.5, "and it did not follow back")
    }
}

private extension NSView {
    func firstDescendant<T: NSView>(_ type: T.Type) -> T? {
        for view in subviews {
            if let match = view as? T { return match }
            if let match = view.firstDescendant(type) { return match }
        }
        return nil
    }
}
