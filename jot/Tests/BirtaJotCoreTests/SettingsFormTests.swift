import XCTest
@testable import BirtaJotCore

/// The invariant that makes these types rather than two layouts: the first-run
/// screen is a subset of Settings' General pane, in order, worded the same, so
/// a question somebody answered on first run is found again by looking where
/// they answered it.
///
/// The subject is the declaration rather than the drawing.
/// `SettingsWindowController` and `WelcomeView` render these arrays, so a row
/// that moves here moves on screen, and a label has one spelling because there
/// is one place to spell it.
final class SettingsFormTests: XCTestCase {
    func testWelcomeShouldBeAnOrderedSubsetOfGeneral() {
        let general = SettingsForm.rows(of: SettingsForm.general)
        let welcome = SettingsForm.rows(of: SettingsForm.welcome)
        XCTAssertFalse(welcome.isEmpty)
        XCTAssertGreaterThan(general.count, welcome.count,
                             "General is meant to hold rows the first run does not ask about")

        // Walk General once, striking off welcome rows as they appear. A row
        // out of order, or absent, leaves the cursor short.
        var cursor = 0
        for row in general where cursor < welcome.count && row == welcome[cursor] {
            cursor += 1
        }
        XCTAssertEqual(cursor, welcome.count,
                       "the first-run rows are not all in General in the same order: "
                       + "stopped at \(welcome[min(cursor, welcome.count - 1)].rawValue)")
    }

    func testEveryFirstRunRowShouldBeOnTheFirstRunScreen() {
        // `WelcomeRow` is the vocabulary `WelcomeView` switches over, so a case
        // declared and never placed in a group is a control nothing draws.
        let placed = SettingsForm.welcome.flatMap(\.rows)
        XCTAssertEqual(Set(placed).count, placed.count, "a first-run row is drawn twice")
        XCTAssertEqual(Set(placed), Set(WelcomeRow.allCases),
                       "unplaced: "
                       + Set(WelcomeRow.allCases).subtracting(placed)
                       .map(\.settingsRow.rawValue).sorted().joined(separator: ", "))
    }

    func testEveryRowShouldAppearOnExactlyOneSettingsPane() {
        // The floor that stops this file passing on an empty enumeration, and
        // the guard that a case added to `SettingsRow` was placed on a screen
        // rather than declared and forgotten.
        let placed = SettingsForm.rows(of: SettingsForm.general)
            + SettingsForm.rows(of: SettingsForm.advanced)
        XCTAssertEqual(Set(placed).count, placed.count, "a row is drawn twice in Settings")
        XCTAssertEqual(Set(placed), Set(SettingsRow.allCases),
                       "every row must be on exactly one Settings pane; unplaced: "
                       + Set(SettingsRow.allCases).subtracting(placed).map(\.rawValue).sorted()
                       .joined(separator: ", "))
        XCTAssertEqual(placed.count, SettingsRow.allCases.count)
    }

    func testLabelsShouldBeDistinctAndNonEmpty() {
        let labels = SettingsRow.allCases.map(\.rawValue)
        XCTAssertEqual(Set(labels).count, labels.count, "two rows share a label")
        XCTAssertFalse(labels.contains(where: \.isEmpty))
    }

    func testTheLocationRowShouldBeFoundByNameRatherThanByCount() {
        // Both values are read by production code: `SettingsWindowController`
        // and `WelcomeView` each hide their own Location row by asking.
        XCTAssertEqual(SettingsForm.index(of: SettingsRow.location, inGroupOf: SettingsForm.general), 1)
        XCTAssertEqual(SettingsForm.index(of: WelcomeRow.location, inGroupOf: SettingsForm.welcome), 1)
        XCTAssertNil(SettingsForm.index(of: SettingsRow.autosave, inGroupOf: SettingsForm.general.filter {
            $0.heading == "Where your notes live"
        }))
    }

    func testEveryHeadedGroupShouldHaveRowsAndTheWelcomeShouldHaveNoHeadings() {
        for group in SettingsForm.general + SettingsForm.advanced {
            XCTAssertFalse(group.rows.isEmpty)
            XCTAssertNotNil(group.heading)
        }
        // The first-run groups carry no heading field at all, which is the
        // type saying what a comment used to.
        for group in SettingsForm.welcome { XCTAssertFalse(group.rows.isEmpty) }
    }
}
