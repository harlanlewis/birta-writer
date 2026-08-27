import AppKit
import BirtaJotCore
import XCTest
@testable import BirtaJot

/// The other half of the drawing invariant, over the screen somebody sees once.
///
/// `SettingsPaneTests` holds the Settings side: the pane draws the rows its
/// declaration names. This holds the first-run side, and the two together are
/// what make the claim checkable at all, because the claim is about the SAME
/// question being asked in one place and answered again in another.
///
/// The first-run side is the half that cannot be checked by using the app.
/// It is shown once, on a launch with an empty defaults domain, so a row lost
/// out of it is invisible to everyone who already has Jot, and the person it
/// is not invisible to has no second chance to notice.
///
/// Measured before this file existed, so it is a hole rather than a worry:
/// with the mirror of the mutation `SettingsPaneTests` was built for,
///
///     SettingsWindowController.group(group.rows.filter { $0 != .showInDock }...
///
/// in `WelcomeView`'s form, the whole Jot suite passed, 309 tests.
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
        let welcome = WelcomeView(onHotkeyChange: { 0 })
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
        let welcome = WelcomeView(onHotkeyChange: { 0 })
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
        let welcome = WelcomeView(onHotkeyChange: { 0 })
        welcome.layoutSubtreeIfNeeded()
        let asked = rowLabels(in: welcome)

        let controller = SettingsWindowController(onHotkeyChange: { 0 }, onChange: { _ in },
                                                  onShowWelcome: {}, onCheckForUpdates: {})
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
}
