import AppKit
import XCTest
@testable import BirtaWriter
import BirtaWriterCore

/// The shipped themes as the Appearance pane draws and moves them: removing
/// one, putting the missing ones back, and what a theme somebody imported
/// under a shipped theme's name does to the strip.
///
/// The core's own suite holds what the library DOES; this holds that the pane
/// reaches it, which is the half a green `DefaultThemesTests` cannot see.
@MainActor
final class DefaultThemeSurfacesTests: XCTestCase {
    private var root: URL!
    private var store: ThemeStore!
    private var savedAppearance = AppearanceSettings()
    private var savedSeeded: Set<String> = []
    private var savedSystemAppearance: NSAppearance?

    /// The committed folder, which is what the build script copies into the
    /// bundle. The xctest host's own Resources are the runner's, which is why
    /// the controller takes this rather than reading `Bundle.main`.
    private var resources: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Resources", isDirectory: true)
    }

    override func setUpWithError() throws {
        try super.setUpWithError()
        _ = NSApplication.shared
        // Pinned for the file, for the reason `ThemeSurfacesTests` gives: a
        // slot assertion left to the machine's own appearance passes here and
        // fails on a runner in the other one.
        savedSystemAppearance = NSApp.appearance
        NSApp.appearance = NSAppearance(named: .darkAqua)
        root = FileManager.default.temporaryDirectory.appendingPathComponent("defaultpane-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = ThemeStore(directory: root.appendingPathComponent("Themes", isDirectory: true))
        savedAppearance = Prefs.appearance
        savedSeeded = Prefs.seededDefaultThemes
        // A known starting point. Both of these are the person's own defaults
        // inside an xctest process, so every test here would otherwise open on
        // whatever theme the machine is set to.
        Prefs.appearance = AppearanceSettings()
        Prefs.seededDefaultThemes = []
    }

    override func tearDownWithError() throws {
        Prefs.appearance = savedAppearance
        Prefs.seededDefaultThemes = savedSeeded
        NSApp.appearance = savedSystemAppearance
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    private func pane(applied: @escaping (AppearanceSettings) -> Void = { _ in },
                      changed: @escaping () -> Void = {}) -> SettingsWindowController {
        let controller = SettingsWindowController(
            flavour: .release, onHotkeyChange: { 0 }, onChange: { _ in }, onChangeEverywhere: {},
            onShowWelcome: {}, onCheckForUpdates: {},
            themeStore: store, bundledThemes: resources,
            onAppearanceChange: { settings in applied(settings); Prefs.appearance = settings },
            onThemesChanged: changed)
        controller.selectTabForTesting("appearance")
        return controller
    }

    private func write(_ text: String, to name: String) throws -> URL {
        let url = root.appendingPathComponent(name)
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    /// Give the library's copy of a shipped theme a paper the bundled file
    /// does not have.
    ///
    /// What makes "left exactly as it is" observable at all. A shipped theme
    /// rewritten from the bundle comes back byte for byte, so every check
    /// that reads its name, its kind or its presence passes whether Restore
    /// touched it or not; only a copy that DIFFERS can report the difference.
    private func alter(_ bundled: DefaultThemes.Bundled, to paper: String) throws {
        let file = store.directory.appendingPathComponent(bundled.id).appendingPathExtension("json")
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: try Data(contentsOf: file)) as? [String: Any])
        var colors = try XCTUnwrap(object["colors"] as? [String: Any])
        colors["editor.background"] = paper
        object["colors"] = colors
        try JSONSerialization.data(withJSONObject: object).write(to: file)
        XCTAssertEqual(store.theme(id: bundled.id)?.colors["editor.background"], paper,
                       "the alteration did not take, so nothing below is measuring anything")
    }

    /// Where a theme comes from is one menu, and Restore is the last way in.
    /// The index is what `addTheme(_:)` dispatches on, so it is asserted
    /// rather than assumed.
    func testTheAddThemeMenuShouldOfferRestoreAsItsLastWayIn() {
        let controller = pane()
        XCTAssertEqual(controller.addThemeChoicesForTesting,
                       [ThemesMenu.addTitle, SettingsWindowController.addThemeFromFileTitle,
                        SettingsWindowController.addThemeFromVSCodeTitle,
                        SettingsWindowController.browseThemesTitle,
                        SettingsWindowController.restoreDefaultThemesTitle])
        controller.window?.close()
    }

    /// The gesture, end to end: a library with the four shipped themes and
    /// one of somebody's own, one shipped theme removed, then Restore.
    ///
    /// The assertion is the library BEFORE and AFTER, not that the call
    /// returned: a restore that does nothing is one failure this is written
    /// against, and a restore that rewrites every shipped theme rather than
    /// the missing one is the other. `kept` is altered first because that
    /// second one is invisible otherwise, the rewrite being byte for byte
    /// what was already there.
    func testRestoreShouldPutBackOnlyTheRemovedShippedThemeAndLeaveEverythingElse() throws {
        _ = store.seedDefaults(from: resources, seeded: [])
        try store.importThemes(from: try write(
            ##"{ "name": "Mine", "type": "dark", "colors": { "editor.background": "#010203" } }"##, to: "mine.json"))
        let gone = DefaultThemes.all[1]
        let kept = DefaultThemes.all[3]
        try alter(kept, to: "#123456")
        Prefs.appearance = AppearanceSettings(lightTheme: "mine", darkTheme: gone.id, accent: "#ff5257")
        Prefs.seededDefaultThemes = Set(DefaultThemes.all.map(\.id))

        var applied: [AppearanceSettings] = []
        var changes = 0
        let controller = pane(applied: { applied.append($0) }, changed: { changes += 1 })

        controller.removeThemeForTesting(gone.id)
        XCTAssertEqual(changes, 1)
        XCTAssertNil(Prefs.appearance.darkTheme, "the slot naming the removed theme is cleared")
        XCTAssertEqual(Prefs.appearance.lightTheme, "mine", "the other slot is untouched")
        let before = store.list().map(\.id)
        XCTAssertEqual(before.count, 4)
        XCTAssertFalse(before.contains(gone.id), "removed from disk, not only from the strip")

        let settingsBefore = Prefs.appearance
        controller.pressAddThemeItemForTesting(4)

        let after = store.list().map(\.id)
        XCTAssertEqual(Set(after).subtracting(before), [gone.id], "exactly the one that was missing came back")
        XCTAssertEqual(after.count, 5)
        XCTAssertEqual(store.theme(id: "mine")?.colors["editor.background"], "#010203",
                       "the theme somebody added themselves is byte for byte what it was")
        XCTAssertEqual(store.theme(id: kept.id)?.colors["editor.background"], "#123456",
                       "a built-in theme still in the library was written over, which Restore promises not to do")
        XCTAssertEqual(Prefs.appearance, settingsBefore,
                       "restoring one theme is a library being filled, never a theme being picked")
        XCTAssertEqual(Prefs.appearance.accent, "#ff5257", "and no other setting moved either")
        XCTAssertEqual(changes, 2, "the app is told the library changed under it")
        XCTAssertTrue(controller.themeLibraryForTesting.map(\.id).contains(gone.id),
                      "the pane re-read the folder rather than drawing what it last had")
        controller.window?.close()
    }

    /// Nothing missing is an answer, not a no-op: the control reports it and
    /// writes nothing.
    func testRestoreWithNothingMissingShouldSaySoAndChangeNothing() {
        _ = store.seedDefaults(from: resources, seeded: [])
        let controller = pane()
        let before = store.list()
        let outcome = controller.restoreDefaultThemesForTesting()
        XCTAssertEqual(outcome.missing, 0)
        XCTAssertEqual(outcome.restored, [])
        XCTAssertEqual(outcome.failures, [])
        XCTAssertEqual(store.list(), before, "a full library is left exactly as it was")
        XCTAssertFalse(SettingsWindowController.nothingToRestoreTitle.isEmpty)
        XCTAssertTrue(SettingsWindowController.nothingToRestoreBody.contains("Nothing was added"))
        controller.window?.close()
    }

    /// Removing the shipped theme in force lands on the system's palette
    /// rather than on a theme that is not there, which is what removing any
    /// other theme already does.
    func testRemovingTheShippedThemeInForceShouldFallBackToTheSystemPalette() {
        _ = store.seedDefaults(from: resources, seeded: [])
        let inForce = DefaultThemes.all[0]
        Prefs.appearance = AppearanceSettings(mode: .light, lightTheme: inForce.id)
        let controller = pane()
        XCTAssertEqual(controller.themeSelectionForTesting, inForce.name)

        controller.removeThemeForTesting(inForce.id)
        XCTAssertNil(Prefs.appearance.lightTheme)
        let resolved = Appearance.resolve(Prefs.appearance, systemIsDark: false) { store.theme(id: $0) }
        XCTAssertNil(resolved.theme, "a slot naming a theme that is gone reads as the system's")
        XCTAssertNil(resolved.themeId)
        XCTAssertEqual(controller.themeSelectionForTesting, "macOS Light")
        controller.window?.close()
    }

    /// A theme imported under a shipped theme's name stands beside it rather
    /// than over it, on the surface a reader actually picks from.
    func testAnImportNamedAfterAShippedThemeShouldDrawAsASecondCardAndRemoveOnItsOwn() throws {
        _ = store.seedDefaults(from: resources, seeded: [])
        let shipped = DefaultThemes.all[0]
        try store.importThemes(from: try write(
            ##"{ "name": "\##(shipped.name)", "type": "light", "colors": { "editor.background": "#0b0b0b" } }"##,
            to: "clash.json"))
        let mine = ThemeStore.slug(shipped.name)

        let controller = pane()
        let qualified = "\(shipped.name) (\(ThemeStore.bundledQualifier))"
        let titles = controller.themeChoicesForTesting
        XCTAssertEqual(titles.filter { $0 == shipped.name || $0 == qualified }.sorted(),
                       [qualified, shipped.name].sorted(),
                       "two cards, and not two cards reading the same")
        XCTAssertEqual(controller.themeLibraryForTesting.filter { $0.id == shipped.id || $0.id == mine }.count, 2)

        // Each card picks its own theme, and the strip rings the one picked.
        controller.chooseThemeForTesting(mine, for: .light)
        XCTAssertEqual(Prefs.appearance.lightTheme, mine)
        XCTAssertEqual(controller.themeSelectionForTesting, shipped.name, "the import keeps the bare name")
        controller.chooseThemeForTesting(shipped.id, for: .light)
        XCTAssertEqual(Prefs.appearance.lightTheme, shipped.id)
        XCTAssertEqual(controller.themeSelectionForTesting, qualified)

        // Removing one leaves the other, and takes the qualifier with it.
        controller.removeThemeForTesting(mine)
        XCTAssertNotNil(store.theme(id: shipped.id), "removing the import took the shipped theme")
        XCTAssertNil(store.theme(id: mine))
        XCTAssertEqual(store.missingDefaults(), [], "an import removed is not a shipped theme missing")
        XCTAssertTrue(controller.themeChoicesForTesting.contains(shipped.name))
        XCTAssertFalse(controller.themeChoicesForTesting.contains(qualified),
                       "the qualifier goes away with the clash that earned it")
        controller.window?.close()
    }
}
