import AppKit
import XCTest
@testable import BirtaWriter
import BirtaWriterCore

/// The three surfaces a colour theme is picked from (View > Theme, the
/// palette, the Themes pane) and the page it reaches, built and read back
/// without being shown.
///
/// All three read one setting and one store, and the claim worth holding is
/// that they agree: the same rows under the same titles, the same row marked
/// as in force, and a pick on any of them going through the app rather than
/// to the surface's own copy of the answer.
@MainActor
final class ThemeSurfacesTests: XCTestCase {
    private var root: URL!
    private var store: ThemeStore!
    private var savedAppearance = AppearanceSettings()

    override func setUpWithError() throws {
        try super.setUpWithError()
        _ = NSApplication.shared
        root = FileManager.default.temporaryDirectory.appendingPathComponent("themesurfaces-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = ThemeStore(directory: root.appendingPathComponent("Themes", isDirectory: true))
        // The setting is a preference, saved and put back as `PaletteWindowTests`
        // does for the palette's recents.
        savedAppearance = Prefs.appearance
    }

    override func tearDownWithError() throws {
        Prefs.appearance = savedAppearance
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    private static let themes = [
        ThemeSummary(id: "paper", name: "Paper", kind: .light),
        ThemeSummary(id: "slate", name: "Slate", kind: .dark),
    ]

    private func titles(of menu: NSMenu) -> [String] {
        menu.items.map { $0.isSeparatorItem ? "-" : $0.title }
    }

    // MARK: the menu

    func testTheViewMenuShouldOpenThemeThroughASubmenuThatFillsItself() {
        let view = NSMenu(title: "view")
        AppMenu.add(.view, to: view, target: self)
        let item = view.items.first { $0.title == "Theme" }
        XCTAssertEqual(item?.submenu?.identifier, AppMenu.themesMenuIdentifier)
        XCTAssertEqual(item?.action, #selector(NSMenu.submenuAction(_:)), "the row opens its submenu and nothing else")
        // A target with no windows to ask gets the appearance row and the
        // way to add a theme, and nothing in between.
        XCTAssertEqual(titles(of: item!.submenu!),
                       ["Auto", "Light", "Dark", "-", ThemesMenu.systemTitle, "-", ThemesMenu.addTitle])
        // The row sits with Font: how the page looks, not what it shows.
        let names = titles(of: view)
        XCTAssertEqual(names.firstIndex(of: "Theme"), names.firstIndex(of: "Font").map { $0 + 1 })
    }

    func testTheThemesMenuShouldListTheStoreWithTheOneInForceTickedAndIdsAsPayload() {
        let menu = ThemesMenu(source: { Self.themes }, current: { "slate" }, mode: { .dark })
        XCTAssertEqual(titles(of: menu), ["Auto", "Light", "Dark", "-", ThemesMenu.systemTitle, "-", "Paper", "Slate",
                                          "-", ThemesMenu.addTitle])
        let rows = menu.items.filter { !$0.isSeparatorItem }
        XCTAssertEqual(rows.map(\.state), [.off, .off, .on, .off, .off, .on, .off], "the held mode and the slot in force")
        XCTAssertEqual(rows.prefix(3).map { $0.representedObject as? String }, ["auto", "light", "dark"])
        XCTAssertEqual(rows.prefix(3).map(\.action), Array(repeating: #selector(AppDelegate.menuSetAppearanceMode(_:)), count: 3))
        let themeRows = Array(rows.dropFirst(3).prefix(3))
        XCTAssertEqual(themeRows.map { $0.representedObject as? String }, ["", "paper", "slate"],
                       "the system row carries an empty id, which the delegate reads as nil")
        XCTAssertEqual(themeRows.map(\.action), Array(repeating: #selector(AppDelegate.menuSelectTheme(_:)), count: 3))
        XCTAssertEqual(rows.last?.action, #selector(AppDelegate.menuOpenThemeSettings))
        XCTAssertTrue(rows.allSatisfy { $0.target == nil }, "the responder chain, so the row ends at the delegate")

        let system = ThemesMenu(source: { Self.themes }, current: { nil })
        let systemRows = system.items.filter { !$0.isSeparatorItem }
        XCTAssertEqual(systemRows[0].state, .on, "auto by default")
        XCTAssertEqual(systemRows[3].state, .on, "no theme in force ticks the system row")
    }

    func testTheThemesMenuShouldRebuildFromItsSourceOnEveryOpening() {
        var themes: [ThemeSummary] = []
        let menu = ThemesMenu(source: { themes }, current: { nil })
        XCTAssertEqual(titles(of: menu).count, 7)
        themes = Self.themes
        menu.menuNeedsUpdate(menu)
        XCTAssertEqual(titles(of: menu), ["Auto", "Light", "Dark", "-", ThemesMenu.systemTitle, "-", "Paper", "Slate",
                                          "-", ThemesMenu.addTitle])
    }

    func testApplyStateShouldLeaveTheThemesMenusRowsStanding() {
        let view = NSMenu(title: "view")
        AppMenu.add(.view, to: view, target: self)
        let themes = view.items.first { $0.title == "Theme" }!.submenu!
        AppMenu.applyState(MenuState(), to: view)
        // Its rows are not table rows: a repaint that walked into it would
        // find no row for any item and could only leave them as they were,
        // but `tidyRules` would hide the rule under a row it never saw.
        XCTAssertEqual(titles(of: themes), ["Auto", "Light", "Dark", "-", ThemesMenu.systemTitle, "-", ThemesMenu.addTitle])
        XCTAssertTrue(themes.items.allSatisfy { !$0.isHidden })
    }

    // MARK: the palette

    func testThePaletteShouldListEveryThemeUnderViewThemeWithTheOneInForceMarked() throws {
        var context = PaletteSources.Context(front: nil, allows: { _ in true })
        context.themes = Self.themes
        context.currentTheme = "slate"
        let catalog = PaletteSources.catalog(context)
        let group = try XCTUnwrap(catalog.items.first { $0.title == "Theme" && $0.section == "View" })
        XCTAssertEqual(group.kind, .group)
        XCTAssertEqual(group.children.map(\.title),
                       ["Auto", "Light", "Dark", ThemesMenu.systemTitle, "Paper", "Slate", ThemesMenu.addTitle])
        XCTAssertEqual(group.children.map(\.detail),
                       [PaletteSources.currentThemeDetail, nil, nil, nil, nil, PaletteSources.currentThemeDetail, nil],
                       "the mode in force and the theme in force each say so")

        guard case .appearanceMode(.dark)? = catalog.action(for: group.children[2].id) else {
            return XCTFail("a mode row holds the app to that mode")
        }
        guard case .theme(nil)? = catalog.action(for: group.children[3].id) else {
            return XCTFail("the system row puts the system's palette in the slot")
        }
        guard case .theme("paper")? = catalog.action(for: group.children[4].id) else {
            return XCTFail("a theme row carries its id")
        }
        guard case let .setting(pane, row)? = catalog.action(for: group.children[6].id) else {
            return XCTFail("Add Theme… opens the pane")
        }
        XCTAssertEqual(pane, "appearance")
        XCTAssertEqual(row, .theme)

        var none = PaletteSources.Context(front: nil, allows: { _ in true })
        none.currentTheme = nil
        let appearance = PaletteSources.catalog(none).items.first { $0.title == "Theme" && $0.section == "View" }
        XCTAssertEqual(appearance?.children[3].detail, PaletteSources.currentThemeDetail)
    }

    // MARK: the page

    func testTheServedPageShouldCarryTheThemeStylesheetInItsOwnElement() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Resources/index.html")
        let template = try String(contentsOf: url, encoding: .utf8)
        let handler = BirtaSchemeHandler(webRoot: URL(fileURLWithPath: "/tmp"), documentDirectory: nil)
        XCTAssertTrue(handler.renderPage(template).contains(#"<style id="host-theme"></style>"#),
                      "empty under the appearance, and present so a live pick has somewhere to land")
        handler.themeCSS = VSCodeTheme(name: "T", kind: .dark, colors: ["editor.background": "#101010"]).stylesheet()
        let page = handler.renderPage(template)
        XCTAssertTrue(page.contains("<style id=\"host-theme\">:root:has(body.vscode-light), :root:has(body.vscode-dark) {\n  --vscode-editor-background: #101010;\n}\n</style>"), page)
        // After the palette's link, or the override loses on order.
        let palette = try XCTUnwrap(page.range(of: "dist/hostPalette.css"))
        let theme = try XCTUnwrap(page.range(of: "id=\"host-theme\""))
        XCTAssertLessThan(palette.lowerBound, theme.lowerBound)
    }

    // MARK: the pane

    func testTheAppearancePaneShouldDrawBothSlotsAndMoveTheSettingsThroughTheApp() throws {
        let a = root.appendingPathComponent("a.json")
        let b = root.appendingPathComponent("b.json")
        try ##"{ "name": "Paper", "type": "light", "colors": { "editor.background": "#f7f3e8" } }"##
            .write(to: a, atomically: true, encoding: .utf8)
        try ##"{ "name": "Slate", "type": "dark", "colors": { "editor.background": "#182529" } }"##
            .write(to: b, atomically: true, encoding: .utf8)
        try store.importThemes(from: a)
        try store.importThemes(from: b)
        Prefs.appearance = AppearanceSettings(darkTheme: "slate")

        var applied: [AppearanceSettings] = []
        var changed = 0
        var commands: [String] = []
        let controller = SettingsWindowController(
            flavour: .release, onHotkeyChange: { 0 }, onChange: { _ in }, onChangeEverywhere: {},
            onShowWelcome: {}, onCheckForUpdates: {},
            themeStore: store,
            onAppearanceChange: { settings in applied.append(settings); Prefs.appearance = settings },
            onThemesChanged: { changed += 1 },
            onEditorCommand: { commands.append($0) })
        controller.selectTabForTesting("appearance")
        XCTAssertEqual(controller.appearanceModesForTesting, ["Auto", "Light", "Dark"])
        XCTAssertEqual(controller.themeChoicesForTesting, ["System", "Paper", "Slate"], "the system first, then the library")
        XCTAssertEqual(controller.darkThemeChoicesForTesting, controller.themeChoicesForTesting)
        XCTAssertEqual(controller.accentChoicesForTesting.first, "Default")
        XCTAssertEqual(controller.themeLibraryForTesting.map(\.id), ["paper", "slate"])

        controller.chooseThemeForTesting("paper", for: .light)
        XCTAssertEqual(applied.last?.lightTheme, "paper", "a pick goes to the app, which owns every window")
        XCTAssertEqual(applied.last?.darkTheme, "slate", "the other slot keeps its own")
        controller.chooseModeForTesting(.dark)
        XCTAssertEqual(applied.last?.mode, .dark)
        controller.chooseAccentForTesting("#ff5257")
        XCTAssertEqual(applied.last?.accent, "#ff5257")

        controller.removeThemeForTesting("slate")
        XCTAssertEqual(changed, 1, "the app is told the library changed under it")
        XCTAssertEqual(applied.last?.darkTheme, nil, "the slot naming the removed theme is cleared")
        XCTAssertEqual(applied.last?.lightTheme, "paper")
        XCTAssertEqual(store.list().map(\.id), ["paper"], "removed from disk, not only from the strip")
        XCTAssertEqual(controller.themeChoicesForTesting, ["System", "Paper"])

        // The registry browser: presented as a sheet, its controls still
        // reach its controller once `present` has returned, which is only
        // true while the settings window holds it (every reference the
        // sheet keeps is weak). Dismissed again so the window is left as it
        // was found.
        XCTAssertTrue(controller.browseThemesForTesting(), "the sheet's controls reach a live controller")
        controller.dismissThemeBrowserForTesting()

        // Typography: the toolbar's own commands, to every window, with the
        // preference written so a window opened meanwhile boots on it.
        let before = Prefs.fontSize
        controller.stepFontSizeForTesting(10)
        XCTAssertEqual(commands.last, "increaseFontSize")
        XCTAssertEqual(Prefs.fontSize, min(200, before + 10))
        XCTAssertEqual(controller.fontSizeForTesting, "\(Prefs.fontSize)%")
        Prefs.fontSize = before
    }
}
