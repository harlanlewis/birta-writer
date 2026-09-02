import XCTest
@testable import BirtaWriterCore

/// The invariant that makes these types rather than two layouts: the first-run
/// screen is a subset of Settings, in order, worded the same, so a question
/// somebody answered on first run is found again by looking for it in
/// Settings.
///
/// The subject is the declaration rather than the drawing.
/// `SettingsWindowController` and `WelcomeView` render these arrays, so a row
/// that moves here moves on screen, and a label has one spelling because there
/// is one place to spell it.
final class SettingsFormTests: XCTestCase {
    /// Over `SettingsForm.allRows` rather than over General alone, and the
    /// difference is a decision rather than a loosening.
    ///
    /// What the first run owes somebody is that a question it asked can be
    /// FOUND again, worded the same, in the order the two screens agree on.
    /// Which tab it is found on is a separate question, settled by what the
    /// row is about: Automatically update is about the program replacing
    /// itself rather than about the writing, so it lives on Advanced while the
    /// first run still asks it. Taking the subset of General alone would make
    /// the layout decision and the findability guarantee one claim, and would
    /// answer a move between tabs by going red at the row that moved rather
    /// than at anything a user could notice.
    ///
    /// The order is still pinned, and that is the half worth keeping: reading
    /// the tabs left to right and each pane top to bottom must meet the
    /// first-run questions in the order the first run asked them, so nobody is
    /// sent backwards through Settings to retrace a screen they saw once.
    func testWelcomeShouldBeAnOrderedSubsetOfSettings() {
        let settings = SettingsForm.allRows
        let welcome = SettingsForm.rows(of: SettingsForm.welcome)
        XCTAssertFalse(welcome.isEmpty)
        XCTAssertGreaterThan(settings.count, welcome.count,
                             "Settings is meant to hold rows the first run does not ask about")

        // Walk Settings once, striking off welcome rows as they appear. A row
        // out of order, or absent, leaves the cursor short.
        var cursor = 0
        for row in settings where cursor < welcome.count && row == welcome[cursor] {
            cursor += 1
        }
        XCTAssertEqual(cursor, welcome.count,
                       "the first-run rows are not all in Settings in the same order: "
                       + "stopped at \(welcome[min(cursor, welcome.count - 1)].rawValue)")
    }

    /// The reading order the check above takes its subset of is the panes in
    /// tab order, with nothing dropped and nothing added.
    ///
    /// Its own arm because `allRows` is where the invariant could be weakened
    /// without any test going red: a definition that quietly returned only
    /// General, or sorted its result, would leave the subset walk passing on a
    /// sequence that is not the one a person reads.
    func testTheReadingOrderShouldBeThePanesInTabOrder() {
        XCTAssertEqual(SettingsForm.allRows,
                       SettingsForm.rows(of: SettingsForm.general)
                           + SettingsForm.rows(of: SettingsForm.markdown)
                           + SettingsForm.rows(of: SettingsForm.aiAgent)
                           + SettingsForm.rows(of: SettingsForm.advanced(showsWelcomeScreen: true)))
        XCTAssertEqual(SettingsForm.allRows.count, SettingsRow.allCases.count)
    }

    /// Every publishing target has a row, and no row names a target that is
    /// gone.
    ///
    /// `SettingsRow` is a hand-written enum, so its cases are exactly the list
    /// a fifth target would never join; the vocabulary is `CaseIterable`, so
    /// comparing the two is what turns "remember to add a switch" into a red
    /// test. Both directions, because a target with no switch cannot be turned
    /// off and a row for a target that no longer exists is a switch that
    /// writes nothing.
    func testEveryPublishingTargetShouldHaveItsOwnSettingsRow() {
        let rows = SyntaxSet.allCases.map(SettingsForm.row(for:))
        XCTAssertEqual(Set(rows).count, rows.count, "two targets share a row")
        XCTAssertEqual(rows, SettingsForm.rows(of: SettingsForm.markdown),
                       "the Markdown pane is not the targets, in vocabulary order")
        // The label a reader sees is the target's own, spelled once.
        XCTAssertEqual(rows.map(\.rawValue), SyntaxSet.allCases.map(\.label))
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
    /// General, so for somebody using the app it is a slower way to reach settings
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
