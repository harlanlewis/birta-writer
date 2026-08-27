import AppKit
import BirtaJotCore
import XCTest
@testable import BirtaJot

/// The drawing half of `RowAvailability`.
///
/// `RowAvailabilityTests` decides what a row's two facts ARE; nothing there can
/// tell you whether either reaches a pixel. This builds a real row, applies an
/// availability, and reads the two inks back.
///
/// The label is the half that is easy to leave out and impossible to notice: a
/// disabled switch is dim on its own, so a row whose NAME stayed at full
/// strength still looks plausible, and the only tell is that it reads as a
/// setting somebody switched off rather than one they cannot have.
@MainActor
final class SettingsRowViewTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    private func makeRow() -> SettingsRowView {
        SettingsWindowController.row("Automatically update", control: NSSwitch(),
                                     caption: Caption(""))
    }

    func testABlockedRowShouldDimItsNameAndRedItsSentence() {
        let row = makeRow()

        row.apply(.blocked("A development build does not replace itself."))

        XCTAssertEqual(row.titleLabel.textColor, .disabledControlTextColor)
        XCTAssertEqual(row.caption?.textColor, .systemRed)
        XCTAssertEqual(row.caption?.stringValue, "A development build does not replace itself.")
    }

    /// The discriminating pair: same ink on the label, different ink on the
    /// sentence. Without this, a row view that ignored `tone` entirely would
    /// pass the blocked case above by dimming everything.
    func testAWarningShouldRedTheSentenceWithoutDimmingTheName() {
        let row = makeRow()

        row.apply(.warning("macOS refused."))

        XCTAssertEqual(row.titleLabel.textColor, .labelColor,
                       "a row that still works must not read as unavailable")
        XCTAssertEqual(row.caption?.textColor, .systemRed)
    }

    func testAWorkingRowShouldDrawInTheOrdinaryInks() {
        let row = makeRow()
        row.apply(.blocked("gone wrong"))

        row.apply(.available("Describes the setting."))

        XCTAssertEqual(row.titleLabel.textColor, .labelColor)
        XCTAssertEqual(row.caption?.textColor, .secondaryLabelColor)
    }

    /// An empty sentence takes its own box out of the layout, or every silent
    /// row is a line taller than it needs to be.
    func testARowWithNothingToSayShouldCollapseItsCaption() {
        let row = makeRow()
        row.apply(.warning("something"))
        XCTAssertFalse(row.caption?.isHidden ?? true)

        row.apply(.available())

        XCTAssertTrue(row.caption?.isHidden ?? false)
        XCTAssertTrue(row.caption?.holder?.isHidden ?? false,
                      "the holder is what the row's stack arranges")
    }

    /// A hotkey macOS refuses is the third row that goes through the pattern,
    /// and the one whose sentence is written at the moment it happens rather
    /// than derived from a stored fact.
    ///
    /// Driven through the recorder's own callback, so what is checked is the
    /// path a person takes rather than a call to `apply` written by the test.
    func testAHotkeyTheSystemRefusesShouldRedTheSummonRowsSentence() {
        // A non-zero status is macOS refusing the registration.
        let controller = SettingsWindowController(onHotkeyChange: { -1 }, onChange: { _ in },
                                                  onShowWelcome: {}, onCheckForUpdates: {})
        defer { controller.window?.close() }
        controller.selectTabForTesting("general")
        guard let row = controller.rowForTesting(.summon) else {
            return XCTFail("the General pane draws no summon row")
        }
        // The precondition: nothing is wrong yet, so a red sentence below is
        // this gesture rather than the row's resting state.
        XCTAssertTrue(row.caption?.isHidden ?? false)

        // Different from what is stored, or the setter returns early. Restored
        // afterwards, since the runner's defaults domain outlives this run.
        let original = Prefs.hotkey
        defer { Prefs.hotkey = original }
        controller.chooseHotkeyForTesting(original == .dev ? .release : .dev)

        XCTAssertEqual(row.caption?.textColor, .systemRed)
        XCTAssertFalse(row.caption?.stringValue.isEmpty ?? true)
    }

    /// The wiring, on the real pane: Settings hands the login row its answer.
    ///
    /// The check that would still pass if `apply` were never called from the
    /// window is the one above, which builds its own row. This one drives the
    /// controller's own path.
    func testTheSettingsPaneShouldHandTheLoginRowItsAvailability() {
        let controller = SettingsWindowController(onHotkeyChange: { 0 }, onChange: { _ in },
                                                  onShowWelcome: {}, onCheckForUpdates: {})
        defer { controller.window?.close() }
        controller.selectTabForTesting("general")

        controller.showEveryConditionalRowForTesting()

        guard let row = controller.rowForTesting(.startAtLogin) else {
            return XCTFail("the General pane draws no start-at-login row")
        }
        XCTAssertEqual(row.caption?.stringValue, LoginItemState.blocked.caption)
        XCTAssertEqual(row.caption?.textColor, .systemRed)
    }

    /// And the update row, whose answer depends on the build rather than on
    /// the system: whatever this build is, the row and the rule agree.
    ///
    /// General first and Advanced second, which is the order a person opening
    /// Settings gets and the order this needs.
    ///
    /// Availability is written through `rowViews`, which `render` is what
    /// fills, and the row is on Advanced while the pane built first is
    /// General, so the write made during that first build reaches no
    /// auto-update row at all. Every pane build must therefore make it again,
    /// which is what `buildPane` calling `showRowAvailability` after `render`
    /// is for. Availability written once, from whichever pane happened to be
    /// built first, leaves this row with no sentence and no dimming, and this
    /// is the check that says so.
    func testTheSettingsPaneShouldHandTheUpdateRowItsAvailability() {
        let controller = SettingsWindowController(onHotkeyChange: { 0 }, onChange: { _ in },
                                                  onShowWelcome: {}, onCheckForUpdates: {})
        defer { controller.window?.close() }
        controller.selectTabForTesting("general")
        controller.selectTabForTesting("advanced")

        guard let row = controller.rowForTesting(.autoUpdate) else {
            return XCTFail("the Advanced pane draws no auto-update row")
        }
        let expected = RowAvailability.autoUpdate(updatesItself: AppFlavor.current.updatesItself)
        XCTAssertEqual(row.caption?.stringValue, expected.note)
        XCTAssertEqual(row.titleLabel.textColor,
                       expected.isEnabled ? .labelColor : .disabledControlTextColor)
    }
}
