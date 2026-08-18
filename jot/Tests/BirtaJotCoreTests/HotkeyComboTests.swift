import XCTest
@testable import BirtaJotCore

final class HotkeyComboTests: XCTestCase {
    func testDefaultSpellingParsesToItself() {
        let parsed = try? HotkeyCombo.parse("cmd+alt+ctrl+j").get()
        XCTAssertEqual(parsed, HotkeyCombo.default)
        XCTAssertEqual(parsed?.keyCode, 38)
        XCTAssertEqual(parsed?.modifiers, HotkeyCombo.cmdKey | HotkeyCombo.optionKey | HotkeyCombo.controlKey)
    }

    func testSynonymsAndOrderNormalise() {
        let a = try? HotkeyCombo.parse("Control-Option-Command-J").get()
        let b = try? HotkeyCombo.parse("  ctrl opt meta j ").get()
        XCTAssertEqual(a?.spelling, "cmd+alt+ctrl+j")
        XCTAssertEqual(a, b)
        XCTAssertEqual(a?.symbols, "⌃⌥⌘J")
    }

    func testFunctionAndNamedKeys() {
        XCTAssertEqual(try? HotkeyCombo.parse("shift+f5").get().keyCode, 96)
        XCTAssertEqual(try? HotkeyCombo.parse("cmd+space").get().keyCode, 49)
    }

    func testRejections() {
        XCTAssertEqual(HotkeyCombo.parse(""), .failure(.empty))
        XCTAssertEqual(HotkeyCombo.parse("cmd+wat"), .failure(.unknownToken("wat")))
        XCTAssertEqual(HotkeyCombo.parse("cmd+alt"), .failure(.noKey))
        XCTAssertEqual(HotkeyCombo.parse("cmd+j+k"), .failure(.twoKeys("j", "k")))
        XCTAssertEqual(HotkeyCombo.parse("j"), .failure(.noModifier))
    }
}
