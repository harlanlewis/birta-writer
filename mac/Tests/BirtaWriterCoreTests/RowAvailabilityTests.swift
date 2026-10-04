import XCTest
@testable import BirtaWriterCore

/// Whether a settings row can do what it says, and what the sentence under it
/// means.
///
/// The reason this is a type rather than two booleans at each surface: the two
/// facts are independent, and the interesting combination is the one that is
/// easiest to collapse by accident. A login registration macOS is HOLDING is a
/// row that works and is reporting a problem, so a design that derived the ink
/// from `isEnabled` would draw that warning in ordinary grey and a development
/// build's dead update row in ordinary grey too.
final class RowAvailabilityTests: XCTestCase {
    /// A chord for the summon arms below, and the release default so the arms
    /// read against a spelling somebody actually sees. Asserted against
    /// `symbols` rather than a literal, because a literal here would be a second
    /// place the spelling is written down and the one the rule does not use.
    private static let chord = HotkeyCombo.release

    func testAWorkingRowShouldBeOperableAndNotAProblem() {
        let row = RowAvailability.available("Describes the setting.")

        XCTAssertTrue(row.isEnabled)
        XCTAssertFalse(row.isProblem)
        XCTAssertEqual(row.note, "Describes the setting.")
    }

    func testABlockedRowShouldBeBothDeadAndAProblem() {
        let row = RowAvailability.blocked("Cannot be done here.")

        XCTAssertFalse(row.isEnabled)
        XCTAssertTrue(row.isProblem)
    }

    /// The combination the type exists for: operable and wrong at once.
    func testAWarningShouldStayOperable() {
        let row = RowAvailability.warning("macOS refused.")

        XCTAssertTrue(row.isEnabled)
        XCTAssertTrue(row.isProblem)
    }

    func testADevelopmentBuildShouldHaveADeadUpdateRowThatSaysSo() {
        let row = RowAvailability.autoUpdate(updatesItself: false)

        XCTAssertFalse(row.isEnabled)
        XCTAssertTrue(row.isProblem, "a row that cannot do what it says is not ordinary prose")
        XCTAssertFalse(row.note.isEmpty)
    }

    func testABuildThatUpdatesItselfShouldHaveALiveRowDescribingWhatItDoes() {
        let row = RowAvailability.autoUpdate(updatesItself: true)

        XCTAssertTrue(row.isEnabled)
        XCTAssertFalse(row.isProblem)
        XCTAssertFalse(row.note.isEmpty)
    }

    /// The two arms must not read the same, or the row says nothing about
    /// which build somebody is looking at.
    func testTheTwoUpdateArmsShouldSayDifferentThings() {
        XCTAssertNotEqual(RowAvailability.autoUpdate(updatesItself: true).note,
                          RowAvailability.autoUpdate(updatesItself: false).note)
    }

    /// Every login state maps to an availability, and the mapping keeps
    /// `LoginItemState`'s own two answers rather than re-deriving them.
    ///
    /// Enumerated from the type, so a state added later is covered here the
    /// day it lands rather than the day somebody remembers to write its arm.
    func testEveryLoginStateShouldKeepTheSystemsOwnAnswer() {
        var checked = 0
        for state in [LoginItemState.on, .off, .blocked, .unavailable] {
            let row = RowAvailability.startAtLogin(state)
            XCTAssertEqual(row.isEnabled, state.isEnabled, "\(state) changed operability")
            XCTAssertEqual(row.isProblem, state.isWarning, "\(state) changed tone")
            XCTAssertEqual(row.note, state.caption, "\(state) changed its sentence")
            checked += 1
        }
        XCTAssertEqual(checked, 4)
    }

    // MARK: the summon row

    /// The asymmetry, stated as the rule rather than left in a comment: a clean
    /// registration is not evidence the chord works, so the row says nothing.
    ///
    /// A sentence here would be the defect, not an improvement. Two of the four
    /// holder/contender combinations in `GlobalHotkey.registrationOptions`
    /// answer `noErr` while another app goes on receiving the chord, and the
    /// keys macOS binds outside the Carbon registry never reach that status at
    /// all, so "this combination is yours" is a claim nothing can check.
    func testAChordTheSystemTookShouldSayNothingRatherThanConfirmIt() {
        let row = RowAvailability.summon(refused: nil, menuBar: true, dock: false)

        XCTAssertEqual(row.note, "")
        XCTAssertFalse(row.isProblem)
        XCTAssertTrue(row.isEnabled)
    }

    /// A refusal is operable and red: the recorder still takes a click, and
    /// recording a replacement is the one move that fixes it.
    func testARefusedChordShouldBeNamedInAnOperableWarning() {
        let row = RowAvailability.summon(refused: Self.chord, menuBar: true, dock: false)

        XCTAssertTrue(row.isEnabled, "the recorder is how this gets fixed")
        XCTAssertTrue(row.isProblem)
        XCTAssertTrue(row.note.contains(Self.chord.symbols),
                      "a refusal that does not name the chord cannot be acted on: \(row.note)")
    }

    /// The escape hatch names the ways in the app is actually SHOWING.
    ///
    /// Enumerated over `AppPresence.Surface` rather than spot-checked, because
    /// the failure this guards is a sentence that is true on the maintainer's
    /// machine and false on somebody else's: naming the menu-bar icon
    /// unconditionally is wrong for a copy running with the Dock icon and no
    /// menu-bar item, which `AppPresence` permits.
    func testTheEscapeHatchShouldNameOnlyTheSurfacesOnScreen() {
        var checked = 0
        for menuBar in [true, false] {
            for dock in [true, false] {
                let note = RowAvailability.summon(refused: Self.chord, menuBar: menuBar, dock: dock).note
                for surface in AppPresence.Surface.allCases {
                    let shown = AppPresence.isShown(surface, menuBar: menuBar, dock: dock)
                    XCTAssertEqual(note.contains(surface.name), shown,
                                   "menuBar=\(menuBar) dock=\(dock) got: \(note)")
                }
                checked += 1
            }
        }
        XCTAssertEqual(checked, 4, "the sweep reached fewer states than there are")
    }

    /// Unreachable by `AppPresence`'s own invariant, and answered anyway: a
    /// half-sentence offering an escape hatch that does not exist is worse than
    /// a refusal on its own, and a trap here would take the app down over a
    /// caption.
    func testARefusalWithNoWayInShouldStillNameTheChordAndOfferNothing() {
        let row = RowAvailability.summon(refused: Self.chord, menuBar: false, dock: false)

        XCTAssertTrue(row.note.contains(Self.chord.symbols))
        XCTAssertTrue(row.isProblem)
        for surface in AppPresence.Surface.allCases {
            XCTAssertFalse(row.note.contains(surface.name), "offered a way in that is switched off")
        }
    }

    /// A rule that ignored its inputs would pass every arm above that only
    /// asks what a note CONTAINS. These three must read differently.
    func testTheSummonArmsShouldNotAllReadTheSame() {
        let taken = RowAvailability.summon(refused: nil, menuBar: true, dock: true).note
        let menuBarOnly = RowAvailability.summon(refused: Self.chord, menuBar: true, dock: false).note
        let dockOnly = RowAvailability.summon(refused: Self.chord, menuBar: false, dock: true).note

        XCTAssertNotEqual(taken, menuBarOnly)
        XCTAssertNotEqual(menuBarOnly, dockOnly)
    }

    /// The first-run screen trims explanatory prose and keeps problems, and a
    /// refused summon is exactly the case that must survive the trim: that
    /// screen is where somebody meets a default chord macOS has declined.
    func testARefusedSummonShouldSurviveTheFirstRunScreensTrim() {
        let row = RowAvailability.summon(refused: Self.chord, menuBar: true, dock: false)

        XCTAssertEqual(row.problemsOnly, row)
    }

    /// A blocked login is the case a single flag would have lost: the switch
    /// still works, and the sentence is still red.
    func testAHeldLoginRegistrationShouldBeOperableAndRed() {
        let row = RowAvailability.startAtLogin(.blocked)

        XCTAssertTrue(row.isEnabled)
        XCTAssertTrue(row.isProblem)
    }

    func testAScreenWithNoRoomForProseShouldKeepTheProblemsAndDropTheRest() {
        XCTAssertEqual(RowAvailability.available("Describes the setting.").problemsOnly.note, "")
        // A problem survives, because the first run is exactly where somebody
        // meets a copy macOS will not register.
        let blocked = RowAvailability.blocked("Cannot be done here.")
        XCTAssertEqual(blocked.problemsOnly, blocked)
        XCTAssertEqual(RowAvailability.startAtLogin(.unavailable).problemsOnly.note,
                       LoginItemState.unavailable.caption)
    }

    /// Dropping the sentence must not quietly bring the row back to life.
    func testProblemsOnlyShouldNotChangeWhetherARowWorks() {
        for row in [RowAvailability.available("x"), .blocked("y"), .warning("z")] {
            XCTAssertEqual(row.problemsOnly.isEnabled, row.isEnabled)
        }
    }

    /// The channel's reason holds whatever the flavour says: a store copy is
    /// the store's to update, development build or not.
    func testAStoreCopyShouldHaveItsUpdateRowDeadWhateverTheFlavour() {
        for flavour in AppFlavor.allCases {
            let row = RowAvailability.autoUpdate(flavour: flavour, distribution: .appStore)
            XCTAssertFalse(row.isEnabled, flavour.rawValue)
            XCTAssertTrue(row.isProblem, flavour.rawValue)
            XCTAssertTrue(row.note.contains("App Store"), flavour.rawValue)
        }
    }

    /// A direct build answers for its flavour exactly as the older rule did,
    /// so nothing an existing install shows has moved.
    func testADirectCopyShouldAnswerForItsFlavour() {
        XCTAssertEqual(RowAvailability.autoUpdate(flavour: .release, distribution: .direct),
                       RowAvailability.autoUpdate(updatesItself: true))
        XCTAssertEqual(RowAvailability.autoUpdate(flavour: .dev, distribution: .direct),
                       RowAvailability.autoUpdate(updatesItself: false))
    }

    /// Both rows the sandbox takes away are dead and say so in the ink that
    /// means withheld, and both name where the thing does exist.
    func testTheTerminalCommandAndTheAgentShouldBeBlockedOnlyWhenNotOffered() {
        for make in [RowAvailability.terminalCommand(offered:), RowAvailability.agent(offered:)] {
            XCTAssertTrue(make(true).isEnabled)
            XCTAssertFalse(make(true).isProblem)
            let blocked = make(false)
            XCTAssertFalse(blocked.isEnabled)
            XCTAssertTrue(blocked.isProblem)
            XCTAssertTrue(blocked.note.contains("App Store"))
            XCTAssertTrue(blocked.note.contains("download"))
        }
    }
}
