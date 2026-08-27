import XCTest
@testable import BirtaWriterCore

final class HostShortcutTests: XCTestCase {
    /// The notation is the page's own (`Mod-Shift-d`), not a rendered chord:
    /// the panel runs these through the same `kbd()` its other rows use, so a
    /// pre-rendered string would print differently in the same column.
    func testAChordShouldBeProseMirrorNotationWithModForTheCommandKey() {
        XCTAssertEqual(HostShortcut.chord(key: "d", command: true, shift: true), "Mod-Shift-d")
        XCTAssertEqual(HostShortcut.chord(key: "s", command: true), "Mod-s")
    }

    /// `kbd()` renders the parts in the order it is given them, so the order
    /// here is the order the reader sees.
    func testEveryModifierShouldAppearInModCtrlAltShiftOrder() {
        XCTAssertEqual(
            HostShortcut.chord(key: "j", command: true, shift: true, option: true, control: true),
            "Mod-Ctrl-Alt-Shift-j")
    }

    /// The comma is the one Settings uses, and it survives as itself.
    func testAPunctuationKeyShouldSurviveUnchanged() {
        XCTAssertEqual(HostShortcut.chord(key: ",", command: true), "Mod-,")
    }

    /// No modifiers is a real answer, not a dangling separator.
    func testAKeyWithNoModifiersShouldBeTheKeyAlone() {
        XCTAssertEqual(HostShortcut.chord(key: "Tab"), "Tab")
    }
}
