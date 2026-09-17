import XCTest
@testable import BirtaWriterCore

/// The mode, the two slots and the colour mod, resolved with no window.
final class AppearanceTests: XCTestCase {
    private let slate = VSCodeTheme(name: "Slate", kind: .dark, colors: ["editor.background": "#182529"])
    private let paper = VSCodeTheme(name: "Paper", kind: .light, colors: ["editor.background": "#f7f3e8"])

    private func lookup(_ id: String) -> VSCodeTheme? {
        ["slate": slate, "paper": paper][id]
    }

    func testAutoShouldFollowTheSystemAndAHeldModeShouldNot() {
        let auto = AppearanceSettings()
        XCTAssertEqual(auto.effectiveKind(systemIsDark: true), .dark)
        XCTAssertEqual(auto.effectiveKind(systemIsDark: false), .light)
        let held = AppearanceSettings(mode: .light)
        XCTAssertEqual(held.effectiveKind(systemIsDark: true), .light)
        XCTAssertTrue(auto.isSystemDefault)
        XCTAssertFalse(held.isSystemDefault)
    }

    func testEachModeShouldHaveItsOwnSlotOfEitherKind() {
        // A dark theme by day and the system's dark by night is a real
        // choice, so a slot takes any theme and nil.
        let settings = AppearanceSettings().setting("slate", for: .light)
        XCTAssertEqual(settings.lightTheme, "slate")
        XCTAssertNil(settings.darkTheme)
        XCTAssertEqual(settings.setting(nil, for: .light).lightTheme, nil)
        XCTAssertEqual(settings.setting("paper", for: .dark).darkTheme, "paper")
    }

    func testResolveShouldReadTheSlotForTheModeInForce() {
        let settings = AppearanceSettings(lightTheme: "paper", darkTheme: "slate")
        let day = Appearance.resolve(settings, systemIsDark: false, theme: lookup)
        XCTAssertEqual(day.kind, .light)
        XCTAssertEqual(day.theme, paper)
        XCTAssertEqual(day.themeId, "paper")
        XCTAssertEqual(day.bodyClass, "vscode-light")
        let night = Appearance.resolve(settings, systemIsDark: true, theme: lookup)
        XCTAssertEqual(night.theme, slate)
        XCTAssertEqual(night.paper, "#182529")
    }

    func testASlotNamingAThemeTheStoreLacksShouldReadAsTheSystem() {
        let settings = AppearanceSettings(darkTheme: "gone")
        let resolved = Appearance.resolve(settings, systemIsDark: true, theme: lookup)
        XCTAssertNil(resolved.theme)
        XCTAssertNil(resolved.themeId, "the menu ticks the system row, not a row that is not there")
        XCTAssertEqual(resolved.bodyClass, "vscode-dark")
        XCTAssertEqual(resolved.stylesheet(), "", "nothing to override")
    }

    func testTheWindowShouldFollowTheThemesKindThenAHeldModeThenTheSystem() {
        // A dark theme in the light slot draws the window dark: the page is
        // dark, and a light titlebar over it is the wrong picture.
        let darkByDay = Appearance.resolve(AppearanceSettings(lightTheme: "slate"), systemIsDark: false, theme: lookup)
        XCTAssertEqual(darkByDay.bodyClass, "vscode-dark")
        XCTAssertEqual(darkByDay.windowKind(mode: .auto), .dark)
        let held = Appearance.resolve(AppearanceSettings(mode: .light), systemIsDark: true, theme: lookup)
        XCTAssertEqual(held.windowKind(mode: .light), .light)
        let system = Appearance.resolve(AppearanceSettings(), systemIsDark: true, theme: lookup)
        XCTAssertNil(system.windowKind(mode: .auto), "left to the system")
    }

    func testTheStylesheetShouldCarryTheThemeThenTheModSoTheModWins() {
        let settings = AppearanceSettings(darkTheme: "slate", accent: "#ff0080")
        let css = Appearance.resolve(settings, systemIsDark: true, theme: lookup).stylesheet()
        XCTAssertTrue(css.hasPrefix(":root:has(body.vscode-light), :root:has(body.vscode-dark) {\n"))
        let paperAt = css.range(of: "--vscode-editor-background: #182529")!.lowerBound
        let accentAt = css.range(of: "--vscode-focusBorder: #ff0080")!.lowerBound
        XCTAssertLessThan(paperAt, accentAt, "the theme's declarations first, the mod's after")
    }
}
