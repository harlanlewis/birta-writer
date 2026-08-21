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
        //
        // Over `SettingsForm.panes` rather than a sum written out here, and
        // that is the point rather than a tidiness: this test named `general`
        // and `advanced` by hand, so adding an Editor pane made every row on
        // it read as UNPLACED. A guard that names the arrays it reads is a
        // guard that a new array is invisible to, and the failure could just
        // as easily have gone the other way, with a pane quietly uncovered.
        // The panes are what `panes` IS, so it cannot be left out of itself.
        XCTAssertGreaterThanOrEqual(SettingsForm.panes.count, 3)
        let placed = SettingsForm.panes.flatMap(SettingsForm.rows(of:))
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

    func testAConditionalRowShouldBeFoundByNameRatherThanByCount() {
        // Every one of these is read by production code to hide a row under
        // the answer above it, so a wrong index here is a row that vanishes
        // with the wrong switch or refuses to.
        XCTAssertEqual(SettingsForm.index(of: SettingsRow.location, inGroupOf: SettingsForm.general), 1)
        XCTAssertEqual(SettingsForm.index(of: WelcomeRow.location, inGroupOf: SettingsForm.welcome), 1)
        XCTAssertEqual(SettingsForm.index(of: SettingsRow.newNoteName, inGroupOf: SettingsForm.editor), 1)
        XCTAssertEqual(SettingsForm.index(of: SettingsRow.agentCommand, inGroupOf: SettingsForm.editor), 1)
        // A row in ANOTHER card of the same pane is not found, which is what
        // makes the three above claims about one card rather than about a
        // position on the pane.
        XCTAssertNil(SettingsForm.index(of: SettingsRow.summon,
                                        inGroupOf: SettingsForm.general.filter { $0.rows.contains(.location) }))
        XCTAssertNil(SettingsForm.index(of: SettingsRow.agentCommand,
                                        inGroupOf: SettingsForm.editor.filter { $0.rows.contains(.opens) }))
    }

    /// A heading is now the EXCEPTION rather than the rule, and this test
    /// changed with it rather than being relaxed to let a red through.
    ///
    /// It used to require one on every Settings group. Most cards lost theirs
    /// deliberately: a card of plain switches is bounded by its own fill, and
    /// a title over it names what the rows already say. What is still worth
    /// holding is that a heading, where there is one, is real, and that an
    /// intro cannot float above a card with no heading to belong to.
    func testEveryGroupShouldHaveRowsAndAnyHeadingShouldBeReal() {
        var headed = 0
        for group in SettingsForm.panes.flatMap({ $0 }) {
            XCTAssertFalse(group.rows.isEmpty)
            if let heading = group.heading {
                headed += 1
                XCTAssertFalse(heading.isEmpty)
            }
            // An intro is a sentence under a heading. Without one it is a
            // paragraph floating over a card, which is the layout this type
            // exists to stop being written by hand at each screen.
            if group.intro != nil { XCTAssertNotNil(group.heading) }
        }
        // A floor, so this cannot pass by there being no headings at all: the
        // agent group has one because it is a subject somebody opts into.
        XCTAssertGreaterThan(headed, 0)
        XCTAssertEqual(SettingsForm.editor.first(where: { $0.rows.contains(.agentEnabled) })?.heading,
                       "AI Agent")
        // The first-run groups carry no heading field at all, which is the
        // type saying what a comment used to.
        for group in SettingsForm.welcome { XCTAssertFalse(group.rows.isEmpty) }
    }
}
