import XCTest
@testable import BirtaWriterCore

final class HotkeyComboTests: XCTestCase {
    func testDefaultSpellingParsesToItself() {
        let parsed = try? HotkeyCombo.parse("cmd+alt+ctrl+j").get()
        XCTAssertEqual(parsed, HotkeyCombo.release)
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

    func testAPressedKeyBecomesTheComboItSpells() {
        // What the recorder control has in hand: the code and the Carbon bits.
        let combo = HotkeyCombo.from(keyCode: 38, modifiers: HotkeyCombo.cmdKey | HotkeyCombo.optionKey | HotkeyCombo.controlKey)

        XCTAssertEqual(combo, HotkeyCombo.release)
        XCTAssertEqual(combo?.spelling, "cmd+alt+ctrl+j")
        XCTAssertEqual(combo?.keyName, "j")
    }

    /// `-` is the one key whose name is also a separator this parser accepts,
    /// so it is the one that can be listed in `keyCodes` and still be
    /// unbindable. Both spellings of the same combination have to reach it.
    func testTheMinusKeyIsBindableDespiteBeingASeparator() {
        for spelling in ["cmd+-", "cmd-", "cmd -"] {
            let combo = try? HotkeyCombo.parse(spelling).get()
            XCTAssertEqual(combo?.keyCode, 27, "\(spelling) did not reach the minus key")
            XCTAssertEqual(combo?.keyName, "-")
        }
    }

    /// A separator run with no key after it is still no key, rather than the
    /// trailing `-` being taken as one.
    func testATrailingSeparatorWithNoKeyIsStillRefused() {
        XCTAssertNil(try? HotkeyCombo.parse("cmd+").get())
        XCTAssertNil(try? HotkeyCombo.parse("-").get())
    }

    func testEveryCodeItAcceptsSpellsBackToTheSameCode() {
        // The reverse map picks one name per code; a wrong pick would store a
        // spelling that reparses to a different key than the one pressed.
        for code in Set(HotkeyCombo.keyCodes.values) {
            let combo = HotkeyCombo.from(keyCode: code, modifiers: HotkeyCombo.cmdKey)
            XCTAssertEqual(combo?.keyCode, code, "code \(code) spelled as \(combo?.spelling ?? "nil")")
        }
    }

    func testAKeyWithNoModifierIsRefused() {
        // It would take that key away from every app on the machine.
        XCTAssertNil(HotkeyCombo.from(keyCode: 38, modifiers: 0))
    }

    func testAKeyWithNoNameIsRefused() {
        XCTAssertNil(HotkeyCombo.from(keyCode: 999, modifiers: HotkeyCombo.cmdKey))
    }

    func testRejections() {
        XCTAssertEqual(HotkeyCombo.parse(""), .failure(.empty))
        XCTAssertEqual(HotkeyCombo.parse("cmd+wat"), .failure(.unknownToken("wat")))
        XCTAssertEqual(HotkeyCombo.parse("cmd+alt"), .failure(.noKey))
        XCTAssertEqual(HotkeyCombo.parse("cmd+j+k"), .failure(.twoKeys("j", "k")))
        XCTAssertEqual(HotkeyCombo.parse("j"), .failure(.noModifier))
    }
}
