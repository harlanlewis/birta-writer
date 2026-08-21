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
        // and `advanced` by hand, so adding a third pane made every row on
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
        XCTAssertEqual(SettingsForm.index(of: SettingsRow.location, inPane: SettingsForm.general), 1)
        XCTAssertEqual(SettingsForm.index(of: WelcomeRow.location, inGroupOf: SettingsForm.welcome), 1)
        XCTAssertEqual(SettingsForm.index(of: SettingsRow.newNoteName, inPane: SettingsForm.general), 1)
        XCTAssertEqual(SettingsForm.index(of: SettingsRow.agentCommand, inPane: SettingsForm.aiAgent), 1)
        // A row in ANOTHER card of the same pane is not found, which is what
        // makes the three above claims about one card rather than about a
        // position on the pane.
        XCTAssertNil(SettingsForm.index(
            of: SettingsRow.summon,
            inPane: SettingsPane(groups: SettingsForm.general.groups.filter {
                $0.rows.contains(.location)
            })))
        XCTAssertNil(SettingsForm.index(
            of: SettingsRow.newNoteName,
            inPane: SettingsPane(groups: SettingsForm.general.groups.filter {
                $0.rows.contains(.summon)
            })))
    }

    /// A row whose control is a dependent of the row above it has to be in the
    /// SAME card, because that is what the hiding reaches into.
    ///
    /// Asserted as adjacency rather than as an index, so it survives the cards
    /// being reordered: File name exists only when a summon makes a new note,
    /// and the Terminal command only when `/ai` is switched on.
    func testADependentRowShouldSitDirectlyUnderTheRowItDependsOn() {
        let pairs: [(SettingsPane, SettingsRow, SettingsRow)] = [
            (SettingsForm.general, .opens, .newNoteName),
            (SettingsForm.aiAgent, .agentEnabled, .agentCommand),
        ]
        for (pane, above, below) in pairs {
            let card = pane.groups.first { $0.rows.contains(below) }
            XCTAssertNotNil(card, "\(below.rawValue) is on no card")
            guard let rows = card?.rows,
                  let index = rows.firstIndex(of: below) else { continue }
            XCTAssertEqual(index > 0 ? rows[index - 1] : nil, above,
                           "\(below.rawValue) must sit under \(above.rawValue) in one card")
        }
    }

    func testEveryGroupShouldHaveRows() {
        for group in SettingsForm.panes.flatMap(\.groups) {
            XCTAssertFalse(group.rows.isEmpty)
        }
        for group in SettingsForm.welcome { XCTAssertFalse(group.rows.isEmpty) }
    }

    /// An intro belongs to a PANE, whose tab title is the heading it sits
    /// under, and it is for a pane holding something somebody has to opt into.
    ///
    /// The floor is what stops this passing on a form with no prose at all,
    /// and it names the pane: the agent is the one that needs explaining,
    /// because everything on it is off until it is turned on and what it turns
    /// on runs a program and may cost money.
    func testTheAgentPaneShouldExplainItselfAndTheOthersShouldNot() {
        XCTAssertFalse(SettingsForm.aiAgent.intro.isEmpty)
        for paragraph in SettingsForm.aiAgent.intro {
            XCTAssertFalse(paragraph.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        XCTAssertTrue(SettingsForm.general.intro.isEmpty)
        XCTAssertTrue(SettingsForm.advanced(showsWelcomeScreen: true).intro.isEmpty)
    }

    /// Replaying the first run is a development affordance, and the reason is
    /// this file's own invariant: every question that screen asks is a row on
    /// General, so for somebody using Jot it is a slower way to reach settings
    /// they can already see.
    func testTheWelcomeRowShouldBeOfferedOnlyByABuildThatShowsIt() {
        XCTAssertTrue(SettingsForm.rows(of: SettingsForm.advanced(showsWelcomeScreen: true))
            .contains(.welcomeScreen))
        XCTAssertFalse(SettingsForm.rows(of: SettingsForm.advanced(showsWelcomeScreen: false))
            .contains(.welcomeScreen))
        // The rest of the pane is the same either way: this hides one row, it
        // does not hide the pane.
        XCTAssertTrue(SettingsForm.rows(of: SettingsForm.advanced(showsWelcomeScreen: false))
            .contains(.resetSettings))
        XCTAssertEqual(AppFlavor.dev.showsWelcomeScreen, true)
        XCTAssertEqual(AppFlavor.release.showsWelcomeScreen, false)
    }
}
