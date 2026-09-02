import AppKit
import BirtaWriterCore
import XCTest
@testable import BirtaWriter

/// The other half of the drawing invariant, over the screen somebody sees once.
///
/// `SettingsPaneTests` holds the Settings side: the pane draws the rows its
/// declaration names. This holds the first-run side, and the two together are
/// what make the claim checkable at all, because the claim is about the SAME
/// question being asked in one place and answered again in another.
///
/// The first-run side is the half that cannot be checked by using the app.
/// It is shown once, on a launch with an empty defaults domain, so a row lost
/// out of it is invisible to everyone who already has the app, and the person it
/// is not invisible to has no second chance to notice.
///
/// Measured before this file existed, so it is a hole rather than a worry:
/// with the mirror of the mutation `SettingsPaneTests` was built for,
///
///     SettingsWindowController.group(group.rows.filter { $0 != .showInDock }...
///
/// in `WelcomeView`'s form, the whole Mac suite passed, 309 tests.
///
/// `WelcomeView` is an `NSView` with no window at all, and it builds its rows
/// through the same `SettingsWindowController.row` as Settings does, so the
/// same walk reads it.
@MainActor
final class WelcomeScreenTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    /// The row labels on the screen, top to bottom. Told apart from headings,
    /// captions and a path field by the shape of a row: a plain `NSView`
    /// holding exactly its label and its control. `SettingsPaneTests` carries
    /// the full argument for why this is not a walk over every `NSTextField`.
    private func rowLabels(in view: NSView) -> [String] {
        var found: [String] = []
        if let field = view as? NSTextField, !(field is Caption), !(field is PathLabel),
           let line = field.superview, type(of: line) == NSView.self,
           line.subviews.count == 2, line.subviews.first === field {
            found.append(field.stringValue)
        }
        for subview in view.subviews { found += rowLabels(in: subview) }
        return found
    }

    func testTheFirstRunScreenShouldDrawEveryRowItAsksAbout() {
        let welcome = WelcomeView(flavour: .release, onHotkeyChange: { 0 })
        welcome.layoutSubtreeIfNeeded()
        let drawn = rowLabels(in: welcome)
        let declared = SettingsForm.rows(of: SettingsForm.welcome).map(\.rawValue)
        XCTAssertEqual(drawn, declared,
                       "the first-run screen and its declaration disagree; drawn: "
                       + drawn.joined(separator: " | "))
    }

    /// The mark is the only place the app says its own name here.
    ///
    /// A heading under the logo is that name twice, once drawn and once set,
    /// and the two never quite agree. Checked as an ABSENCE, which is the kind
    /// of claim nothing else on this screen can make: every other check here
    /// asks whether something is drawn.
    func testTheFirstRunScreenShouldNotWriteTheAppsNameUnderItsOwnMark() {
        let welcome = WelcomeView(flavour: .release, onHotkeyChange: { 0 })
        welcome.layoutSubtreeIfNeeded()

        var text: [String] = []
        func walk(_ view: NSView) {
            if let field = view as? NSTextField { text.append(field.stringValue) }
            for subview in view.subviews { walk(subview) }
        }
        walk(welcome)

        // The instrument reached the screen: the row labels ARE fields, so an
        // empty sweep would mean the walk found nothing rather than that the
        // title is gone.
        XCTAssertTrue(text.contains(SettingsRow.showInDock.rawValue),
                      "the walk read no rows, so it cannot say anything about a title")
        XCTAssertFalse(text.contains(AppFlavor.current.displayName),
                       "the first-run screen writes the app's name under its own logo")
    }

    /// The two screens, compared as DRAWN rather than as declared.
    ///
    /// `SettingsFormTests` makes this comparison between two arrays, which is
    /// where it belongs and is not what this is. Both sides here came off a
    /// live view hierarchy, so a row that is declared in both and drawn in
    /// only one fails here and nowhere else.
    ///
    /// Every tab, not General alone: a first-run question can belong to a pane
    /// that is not General, and what the first run owes somebody is that the
    /// question is findable in Settings rather than findable on one particular
    /// tab. Automatically update is the row that makes the distinction real.
    func testEveryRowTheFirstRunDrawsShouldBeDrawnInSettingsToo() {
        let welcome = WelcomeView(flavour: .release, onHotkeyChange: { 0 })
        welcome.layoutSubtreeIfNeeded()
        let asked = rowLabels(in: welcome)

        let controller = SettingsWindowController(flavour: .release, onHotkeyChange: { 0 },
                                                  onChange: { _ in }, onChangeEverywhere: {}, onShowWelcome: {},
                                                  onCheckForUpdates: {})
        defer { controller.window?.close() }
        var settings: [String] = []
        for tab in SettingsWindowController.tabNames {
            controller.selectTabForTesting(tab)
            controller.window?.contentView?.layoutSubtreeIfNeeded()
            settings += rowLabels(in: controller.window!.contentView!)
        }

        XCTAssertFalse(asked.isEmpty, "the first-run screen drew no rows at all")
        XCTAssertGreaterThan(settings.count, asked.count,
                             "Settings is meant to draw rows the first run does not ask about")
        for label in asked {
            XCTAssertTrue(settings.contains(label),
                          "the first run asks about \(label) on screen, and no Settings pane "
                          + "draws a row by that name to go back to")
        }
    }

    /// The first run's update row, on both builds, and the pair is what is
    /// asserted.
    ///
    /// This screen applies `problemsOnly`, so the two builds differ in a
    /// SECOND way that Settings does not have: a working row says nothing at
    /// all here, because the screen asks questions rather than documenting
    /// answers, and a row that cannot be operated says the same sentence
    /// Settings gives it. Both halves of that promise are the development
    /// arm's, and neither was reachable while the screen read
    /// `AppFlavor.current`: under `swift test` that is always the release.
    func testOnlyADevelopmentBuildsFirstRunShouldExplainADeadUpdateRow() {
        var drawn: [AppFlavor: (dimmed: Bool, note: String, red: Bool)] = [:]
        for flavour in AppFlavor.allCases {
            let welcome = WelcomeView(flavour: flavour, onHotkeyChange: { 0 })
            welcome.layoutSubtreeIfNeeded()
            guard let row = updateRow(in: welcome) else {
                return XCTFail("the first-run screen draws no update row on \(flavour)")
            }
            drawn[flavour] = (row.titleLabel.textColor == .disabledControlTextColor,
                              row.caption?.stringValue ?? "",
                              row.caption?.textColor == .systemRed)
        }

        XCTAssertEqual(drawn[.release]?.dimmed, false)
        XCTAssertEqual(drawn[.release]?.note, "",
                       "the first run documents a setting that works, which is Settings' job")
        XCTAssertEqual(drawn[.dev]?.dimmed, true)
        XCTAssertEqual(drawn[.dev]?.note, "A development build does not replace itself.")
        XCTAssertEqual(drawn[.dev]?.red, true)
        // The same words as Settings, and taken from the rule rather than
        // written twice: two screens disagreeing about what is wrong with a
        // row is the thing `problemsOnly` exists to prevent.
        XCTAssertEqual(drawn[.dev]?.note,
                       RowAvailability.autoUpdate(updatesItself: false).note)
    }

    /// The update row on the first-run screen, found by its own name. Read
    /// back off the hierarchy: the screen's `rowViews` is its own, and a check
    /// holding it would pass whether or not the row reached the screen.
    private func updateRow(in view: NSView) -> SettingsRowView? {
        if let row = view as? SettingsRowView,
           row.titleLabel.stringValue == SettingsRow.autoUpdate.rawValue { return row }
        for subview in view.subviews {
            if let found = updateRow(in: subview) { return found }
        }
        return nil
    }
}
