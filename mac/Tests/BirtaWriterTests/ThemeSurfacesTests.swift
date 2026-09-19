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
///
/// ORDER is each surface's own, and deliberately so. All three list by name;
/// what the pane adds is a GROUPING, because it draws a picker per mode and
/// each strip leads with the themes of its own kind (`ThemeStore.ordered`).
/// The menu and the palette are one list with the theme in force ticked, and
/// grouping there would move that ticked row into the middle of a list a
/// reader scans from the top.
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

    func testTheAppearancePaneShouldDrawBothSlotsAndMoveTheSettingsThroughTheApp() async throws {
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
        XCTAssertTrue(controller.followsSystemForTesting, "the switch is on by default")
        XCTAssertEqual(controller.themeCardShapeForTesting, "slots")
        XCTAssertEqual(controller.themeStripHeadingsForTesting, ["Light Theme", "Dark Theme"],
                       "two strips, so each says which it is")
        XCTAssertEqual(controller.themeStripNamesForTesting.map(\.name), ["Light Theme", "Dark Theme"],
                       "and each is spoken by the name it is drawn under")
        XCTAssertTrue(controller.themeStripNamesForTesting.allSatisfy(\.isElement),
                      "a name on a view that is not an element is a name nothing announces")
        XCTAssertEqual(controller.themeChoicesForTesting, ["macOS Light", "Paper", "Slate"],
                       "the light picker: the system's light, then the light themes, then the rest")
        XCTAssertEqual(controller.darkThemeChoicesForTesting, ["macOS Dark", "Slate", "Paper"],
                       "the dark picker leads with the dark themes")
        // And each slot strip draws ONE line where its own kind runs out, so
        // the leading half reads as the mode's themes rather than as a list
        // that happens to start well. The card named is the first one after
        // the line, which is what says the line landed on the turn rather
        // than somewhere in the middle of a run.
        XCTAssertEqual(controller.themeDividersForTesting.map(\.titleAfter), ["Slate", "Paper"])
        XCTAssertEqual(controller.themeDividersForTesting.map(\.drawn), [1, 1],
                       "a line decided and never drawn, or one left behind by an earlier pass")
        // Everything, on one strip. Which card leads is the HELD kind's to
        // decide and this Mac's appearance is what holds it here, so the
        // order is pinned below where a kind is held on purpose.
        XCTAssertEqual(Set(controller.heldThemeChoicesForTesting),
                       ["macOS Light", "macOS Dark", "Paper", "Slate"], "held, one strip of everything")
        XCTAssertEqual(controller.heldThemeChoicesForTesting.prefix(2).sorted(),
                       ["macOS Dark", "macOS Light"], "both system cards lead")
        XCTAssertEqual(controller.accentChoicesForTesting.first, "Default")
        XCTAssertEqual(controller.themeLibraryForTesting.map(\.id), ["paper", "slate"])

        controller.chooseThemeForTesting("paper", for: .light)
        XCTAssertEqual(applied.last?.lightTheme, "paper", "a pick goes to the app, which owns every window")
        XCTAssertEqual(applied.last?.darkTheme, "slate", "the other slot keeps its own")
        controller.chooseModeForTesting(.dark)
        XCTAssertEqual(applied.last?.mode, .dark)
        // A mode held from outside the pane (View > Theme, the palette) is
        // what the switch and the card show, not what they were last set to.
        XCTAssertFalse(controller.followsSystemForTesting, "the switch follows a mode held elsewhere")
        XCTAssertEqual(controller.themeCardShapeForTesting, "held")
        controller.chooseAccentForTesting("#ff5257")
        XCTAssertEqual(applied.last?.accent, "#ff5257")

        // The switch, from the system: off holds the kind last held (dark,
        // from the pick above), shows the one strip with that slot's theme
        // ringed; a pick there holds the card's own kind; on brings both
        // slots back untouched.
        controller.setFollowSystemForTesting(true)
        XCTAssertEqual(applied.last?.mode, .auto)
        XCTAssertEqual(controller.themeCardShapeForTesting, "slots")
        controller.setFollowSystemForTesting(false)
        XCTAssertEqual(applied.last?.mode, .dark, "off holds the kind that was held, not the sun's")
        XCTAssertEqual(controller.themeCardShapeForTesting, "held")
        XCTAssertEqual(controller.themeStripHeadingsForTesting, [],
                       "one strip under the sentence names nothing a heading could add")
        // The heading is what a sighted reader loses here, so the name a
        // screen reader is given has to survive on its own.
        XCTAssertEqual(controller.themeStripNamesForTesting.map(\.name), ["Theme"])
        XCTAssertTrue(controller.themeStripNamesForTesting.allSatisfy(\.isElement),
                      "and on an element, or nothing announces it")
        XCTAssertEqual(controller.heldThemeSelectionForTesting, "Slate")
        XCTAssertEqual(controller.heldThemeChoicesForTesting, ["macOS Dark", "macOS Light", "Slate", "Paper"],
                       "holding dark, the dark cards lead")
        // No line on the held strip: one strip is one question, and a line
        // across it would divide the answers to a question nobody asked.
        XCTAssertEqual(controller.themeDividersForTesting.map(\.drawn), [0])
        controller.chooseHeldThemeForTesting("paper", kind: .light)
        XCTAssertEqual(applied.last?.mode, .light)
        XCTAssertEqual(controller.heldThemeChoicesForTesting, ["macOS Light", "macOS Dark", "Paper", "Slate"],
                       "the strip re-leads when the kind held flips")
        XCTAssertEqual(applied.last?.lightTheme, "paper")
        XCTAssertEqual(applied.last?.darkTheme, "slate", "the other slot keeps its own")
        XCTAssertEqual(controller.heldThemeSelectionForTesting, "Paper")
        controller.chooseHeldThemeForTesting(nil, kind: .dark)
        XCTAssertEqual(controller.heldThemeSelectionForTesting, "macOS Dark", "a system card rings the one of its kind")
        XCTAssertEqual(applied.last?.darkTheme, nil)
        controller.setFollowSystemForTesting(true)
        XCTAssertEqual(applied.last?.mode, .auto)
        XCTAssertEqual(applied.last?.heldKind, .dark, "the held pick is remembered while following the system")
        // Through the defaults, not the struct handed to `apply`: the memory
        // the switch relies on across a relaunch is the stored one.
        XCTAssertEqual(Prefs.appearance.heldKind, .dark, "the held kind is not written, so a relaunch forgets it")
        XCTAssertEqual(controller.themeCardShapeForTesting, "slots")
        XCTAssertEqual(applied.last?.lightTheme, "paper")
        Prefs.appearance = Prefs.appearance.setting("slate", for: .dark)
        controller.chooseModeForTesting(.dark)

        controller.removeThemeForTesting("slate")
        XCTAssertEqual(changed, 1, "the app is told the library changed under it")
        XCTAssertEqual(applied.last?.darkTheme, nil, "the slot naming the removed theme is cleared")
        XCTAssertEqual(applied.last?.lightTheme, "paper")
        XCTAssertEqual(store.list().map(\.id), ["paper"], "removed from disk, not only from the strip")
        XCTAssertEqual(controller.themeChoicesForTesting, ["macOS Light", "Paper"])
        // With the one dark theme gone the light strip is light throughout,
        // so it draws no line: a divider with nothing on the far side of it
        // promises cards that are not there. The dark strip still has both
        // kinds and still draws one, which is what says the absence above is
        // a decision rather than the feature having stopped working.
        controller.setFollowSystemForTesting(true)
        XCTAssertEqual(controller.themeDividersForTesting.map(\.drawn), [0, 1])
        XCTAssertEqual(controller.themeDividersForTesting.map(\.titleAfter), [nil, "Paper"])

        // The installed-themes picker: a sheet over a list this test
        // controls, whose Add adds exactly the ticked ones. Held while it is
        // up, for the reason the registry browser is.
        let loose = root.appendingPathComponent("loose.json")
        try ##"{ "name": "Loose", "type": "light", "colors": { "editor.background": "#fafafa" } }"##
            .write(to: loose, atomically: true, encoding: .utf8)
        let picker = try XCTUnwrap(controller.pickInstalledThemesForTesting([
            ThemeSource(label: "Paper", uiTheme: "vs", url: a),
            ThemeSource(label: "Loose", uiTheme: "vs", url: loose),
        ]), "the picker's controls reach a live controller")
        XCTAssertEqual(picker.rowsForTesting.map(\.alreadyAdded), [true, false], "Paper is in the library already")
        XCTAssertEqual(picker.addTitleForTesting, "Add")
        picker.toggleForTesting(1)
        XCTAssertEqual(picker.addTitleForTesting, "Add 1")
        picker.addForTesting()
        XCTAssertEqual(store.list().map(\.id), ["loose", "paper"], "only the ticked theme was added")
        XCTAssertEqual(applied.last?.darkTheme, "loose",
                       "one theme added is one somebody wants to see, in the slot of the mode in force (dark)")

        // The registry browser: presented as a sheet, its controls still
        // reach its controller once `present` has returned, which is only
        // true while the settings window holds it (every reference the
        // sheet keeps is weak). Dismissed again so the window is left as it
        // was found.
        // Over a fetch of this test's own, because the sheet asks the
        // registry for its first page as it opens: the request goes to the
        // seam, the answer fills the table, and the network is never touched.
        var asked: [URL] = []
        let page = #"{"extensions":[{"namespace":"n","name":"one","displayName":"One","version":"1.0.0","downloadCount":5,"files":{"download":"https://open-vsx.org/api/n/one/1.0.0/file/one.vsix"}}]}"#
        let browser = try XCTUnwrap(controller.browseThemesForTesting(fetch: { url in
            asked.append(url)
            return (Data(page.utf8), HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }), "the sheet's controls reach a live controller")
        let opened = XCTestExpectation(description: "the first page arrives")
        Task { @MainActor in
            while browser.resultCountForTesting == 0 { await Task.yield() }
            opened.fulfill()
        }
        await fulfillment(of: [opened], timeout: 5)
        XCTAssertEqual(asked.map(\.query), [OpenVsx.searchURL(query: "").query], "the first page is the empty query")
        XCTAssertEqual(browser.resultCountForTesting, 1)
        XCTAssertEqual(browser.statusForTesting, "The most downloaded themes on Open VSX. Search for more.")
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

/// The two drawer switches on the Appearance pane: their defaults, which
/// declaration each moves, and the stored key behind each.
///
/// Driven through the rows' own switches rather than through a hook, so what
/// is being read back is a control somebody could reach.
@MainActor
final class DrawerGroundSwitchTests: XCTestCase {
    private var saved = AppearanceSettings()

    override func setUpWithError() throws {
        try super.setUpWithError()
        _ = NSApplication.shared
        saved = Prefs.appearance
        Prefs.appearance = AppearanceSettings()
    }

    override func tearDownWithError() throws {
        Prefs.appearance = saved
        try super.tearDownWithError()
    }

    /// The switch in a row of the Appearance pane, by the row's name.
    private func toggle(_ row: SettingsRow, of controller: SettingsWindowController) throws -> NSSwitch {
        let view = try XCTUnwrap(controller.rowForTesting(row), "the pane draws no \(row.rawValue) row")
        var found: [NSSwitch] = []
        func walk(_ view: NSView) {
            if let sw = view as? NSSwitch { found.append(sw) }
            view.subviews.forEach(walk)
        }
        walk(view)
        XCTAssertEqual(found.count, 1, "\(row.rawValue) should carry exactly one switch")
        return try XCTUnwrap(found.first)
    }

    private func flip(_ sw: NSSwitch, to on: Bool) {
        sw.state = on ? .on : .off
        _ = NSApp.sendAction(sw.action!, to: sw.target, from: sw)
    }

    func testEachDrawerSwitchShouldOpenOnItsOwnDefaultAndMoveItsOwnGround() throws {
        var applied: [AppearanceSettings] = []
        let controller = SettingsWindowController(
            flavour: .release, onHotkeyChange: { 0 }, onChange: { _ in }, onChangeEverywhere: {},
            onShowWelcome: {}, onCheckForUpdates: {},
            onAppearanceChange: { applied.append($0); Prefs.appearance = $0 })
        defer { controller.window?.close() }
        controller.selectTabForTesting("appearance")

        let files = try toggle(.transparentSidebar, of: controller)
        let contents = try toggle(.transparentToc, of: controller)
        XCTAssertEqual(files.state, .off, "the file list is shaded until asked otherwise")
        XCTAssertEqual(contents.state, .on, "the table of contents reads as page until asked otherwise")

        flip(contents, to: false)
        XCTAssertEqual(applied.last?.transparentToc, false)
        XCTAssertEqual(applied.last?.transparentSidebar, false, "the other switch did not move")
        // Through the defaults as well as the struct, because the key behind
        // this one is written INVERTED (absent is transparent, as absent is
        // the default for every other appearance key).
        XCTAssertEqual(Prefs.appearance.transparentToc, false)

        flip(files, to: true)
        XCTAssertEqual(applied.last?.transparentSidebar, true)
        XCTAssertEqual(applied.last?.transparentToc, false, "and this one did not move the other back")

        // Both set the way the two switches now stand, and the grounds still
        // disagree: the whole point of two properties.
        let overlay = Appearance.resolve(Prefs.appearance, systemIsDark: false, theme: { _ in nil }).overlay
        let grounds = Dictionary(uniqueKeysWithValues: overlay.map { ($0.name, $0.value) })
        XCTAssertEqual(grounds[AppearanceOverlay.filesGround], "var(--vscode-editor-background)")
        XCTAssertEqual(grounds[AppearanceOverlay.tocGround], "var(--vscode-sideBar-background)")

        flip(contents, to: true)
        XCTAssertEqual(Prefs.appearance.transparentToc, true)
        XCTAssertNil(Dictionary(uniqueKeysWithValues:
            Appearance.resolve(Prefs.appearance, systemIsDark: false, theme: { _ in nil })
                .overlay.map { ($0.name, $0.value) })[AppearanceOverlay.tocGround],
                     "back to the default is back to declaring nothing")
    }
}

/// A theme card's remove button: where it is, when it is drawn, and what a
/// click there does instead of picking.
@MainActor
final class ThemeCardRemoveTests: XCTestCase {
    private func card(id: String?) -> ThemeStrip.ThemeCard {
        let card = ThemeStrip.ThemeCard(id: id, kind: .light, title: id ?? "macOS Light",
                                        palette: MiniWindowPalette(preview: ThemePreview.system(.light)))
        card.frame = NSRect(x: 0, y: 0, width: ThemeStrip.ThemeCard.pictureSize.width + 6,
                            height: ThemeStrip.ThemeCard.pictureSize.height + 38)
        return card
    }

    func testAThemeCardShouldTakeARemoveInThePicturesTopTrailingCorner() throws {
        let card = card(id: "paper")
        let button = try XCTUnwrap(card.removeButtonRect)
        let picture = NSRect(x: 3, y: card.bounds.height - ThemeStrip.ThemeCard.pictureSize.height - 3,
                             width: ThemeStrip.ThemeCard.pictureSize.width, height: ThemeStrip.ThemeCard.pictureSize.height)
        XCTAssertTrue(picture.contains(button), "the button sits on the picture, not off it")
        XCTAssertEqual(button.maxX, picture.maxX - ThemeStrip.ThemeCard.removeInset)
        XCTAssertEqual(button.maxY, picture.maxY - ThemeStrip.ThemeCard.removeInset)
        XCTAssertEqual(card.actionForMeasurement(at: NSPoint(x: button.midX, y: button.midY)), "remove")
        XCTAssertEqual(card.actionForMeasurement(at: NSPoint(x: picture.minX + 4, y: picture.minY + 4)), "pick",
                       "the rest of the picture still picks")
    }

    func testASystemCardShouldHaveNothingToRemove() {
        let card = card(id: nil)
        XCTAssertNil(card.removeButtonRect)
        XCTAssertEqual(card.actionForMeasurement(at: NSPoint(x: card.bounds.maxX - 8, y: card.bounds.maxY - 8)), "pick")
    }

    func testAClickOnTheButtonShouldRemoveWithoutAsking() {
        let card = card(id: "paper")
        var removed: [String] = []
        var picked = 0
        card.onRemove = { removed.append($0) }
        card.onPick = { _, _ in picked += 1 }
        let button = card.removeButtonRect!
        card.press(at: NSPoint(x: button.midX, y: button.midY))
        XCTAssertEqual(removed, ["paper"])
        XCTAssertEqual(picked, 0, "a remove is not also a pick")
        card.press(at: NSPoint(x: 10, y: card.bounds.height - 10))
        XCTAssertEqual(picked, 1)
        XCTAssertEqual(removed.count, 1)
    }
}

/// Renders the Appearance pane in both of the theme card's shapes, for a
/// person to look at. Off unless asked (`BIRTA_MAC_WRITE_SHOTS=1`), for the
/// reason `WelcomeAppearanceTests.testWriteAppearanceShots` gives; written
/// where `BIRTA_MAC_SHOTS_DIR` says, or to `/tmp`.
@MainActor
final class AppearancePaneShotTests: XCTestCase {
    func testWriteAppearancePaneShots() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["BIRTA_MAC_WRITE_SHOTS"] == "1")
        let dir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["BIRTA_MAC_SHOTS_DIR"] ?? "/tmp", isDirectory: true)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pane-shots-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let store = ThemeStore(directory: root)
        for (name, type, paper) in [("Paper", "light", "#f7f3e8"), ("Slate", "dark", "#182529"), ("Harlan Terracotta", "light", "#f1ebe0")] {
            let file = root.appendingPathComponent("\(name).json")
            try "{ \"name\": \"\(name)\", \"type\": \"\(type)\", \"colors\": { \"editor.background\": \"\(paper)\" } }"
                .write(to: file, atomically: true, encoding: .utf8)
            try store.importThemes(from: file)
        }
        let saved = Prefs.appearance
        defer { Prefs.appearance = saved }
        for (shape, settings) in [("slots", AppearanceSettings(lightTheme: "paper", darkTheme: "slate")),
                                  ("held", AppearanceSettings(lightTheme: "paper", darkTheme: "slate").holding("slate", kind: .dark))] {
            Prefs.appearance = settings
            let controller = SettingsWindowController(
                flavour: .release, onHotkeyChange: { 0 }, onChange: { _ in }, onChangeEverywhere: {},
                onShowWelcome: {}, onCheckForUpdates: {}, themeStore: store,
                onAppearanceChange: { Prefs.appearance = $0 }, onThemesChanged: {}, onEditorCommand: { _ in })
            controller.selectTabForTesting("appearance")
            let content = try XCTUnwrap(controller.window?.contentView)
            content.layoutSubtreeIfNeeded()
            let bounds = content.bounds
            var data: Data?
            NSAppearance(named: .aqua)!.performAsCurrentDrawingAppearance {
                let pdf = content.dataWithPDF(inside: bounds)
                guard let image = NSImage(data: pdf) else { return }
                let rendered = NSImage(size: bounds.size)
                rendered.lockFocus()
                image.draw(in: bounds)
                rendered.unlockFocus()
                data = rendered.tiffRepresentation
                    .flatMap { NSBitmapImageRep(data: $0) }
                    .flatMap { $0.representation(using: .png, properties: [:]) }
            }
            try XCTUnwrap(data).write(to: dir.appendingPathComponent("appearance-pane-\(shape).png"))
            controller.window?.close()
        }
    }
}
