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
}
