import XCTest
@testable import BirtaJotCore

/// The invariant that made this a type: the first-run screen is a subset of
/// Settings' General pane, in order, worded the same.
///
/// It used to be a comment in two files, and it was broken by one row's wording
/// drifting from its twin with nothing to say so. The subject of these tests is
/// the declaration rather than the drawing: `SettingsWindowController` and
/// `WelcomeView` render these arrays, so a row that moves here moves on screen,
/// and a row added to one screen only cannot be spelled differently on the
/// other because there is one spelling.
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

    func testEveryRowShouldAppearOnExactlyOneScreen() {
        // The floor that stops this file passing on an empty enumeration, and
        // the guard that a case added to `SettingsRow` was actually placed on
        // a screen rather than declared and forgotten.
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
        XCTAssertEqual(SettingsForm.index(of: .location, inGroupOf: SettingsForm.general), 1)
        XCTAssertEqual(SettingsForm.index(of: .location, inGroupOf: SettingsForm.welcome), 1)
        XCTAssertNil(SettingsForm.index(of: .autosave, inGroupOf: SettingsForm.welcome))
    }

    func testEveryHeadedGroupShouldHaveRowsAndTheWelcomeShouldHaveNoHeadings() {
        for group in SettingsForm.general + SettingsForm.advanced {
            XCTAssertFalse(group.rows.isEmpty)
            XCTAssertNotNil(group.heading)
        }
        for group in SettingsForm.welcome {
            XCTAssertFalse(group.rows.isEmpty)
            XCTAssertNil(group.heading, "the first run draws no headings")
        }
    }
}
