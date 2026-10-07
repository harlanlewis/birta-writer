import AppKit
import BirtaWriterCore
import XCTest
@testable import BirtaWriter

/// What a store build leaves OUT, drawn.
///
/// The windows take their channel as an argument so that this arm can be
/// reached at all: the test process is never sandboxed, so
/// `Distribution.current` is `.direct` here and every store branch would
/// otherwise go unexecuted. `DistributionTests` decides which rows a channel
/// offers; this asks whether each surface that draws rows actually leaves
/// them out.
///
/// Every case is a pair, store against direct, so a surface that ignored the
/// channel entirely fails the store half rather than passing both.
@MainActor
final class DistributionSettingsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    private func makeController(_ distribution: Distribution) -> SettingsWindowController {
        SettingsWindowController(flavour: .release, distribution: distribution, onHotkeyChange: { 0 },
                                 onChange: { _ in }, onChangeEverywhere: {},
                                 onShowWelcome: {}, onCheckForUpdates: {})
    }

    private static let omitted: [SettingsRow] = [.agentEnabled, .agentCommand, .commandLine, .commandName, .autoUpdate,
                                                 .storeInICloud]

    func testAStoreBuildShouldDrawNoAIAgentTab() {
        let direct = makeController(.direct)
        defer { direct.window?.close() }
        let store = makeController(.appStore)
        defer { store.window?.close() }

        XCTAssertEqual(direct.drawnTabNames, SettingsWindowController.tabNames)
        XCTAssertEqual(store.drawnTabNames, SettingsWindowController.tabNames.filter { $0 != "aiAgent" })
        XCTAssertEqual(store.window?.toolbar?.items.map(\.itemIdentifier.rawValue), store.drawnTabNames)
        XCTAssertNil(store.declaredRows(forTab: "aiAgent"))
    }

    /// Read off the panes as drawn rather than the declaration, so a pane that
    /// filtered its declaration and then rendered the unfiltered one is red.
    func testAStoreBuildShouldDrawNoneOfTheRowsItsSandboxTakesAway() {
        for distribution in Distribution.allCases {
            let controller = makeController(distribution)
            defer { controller.window?.close() }
            for tab in controller.drawnTabNames { controller.selectTabForTesting(tab) }
            for row in Self.omitted {
                if distribution == .appStore {
                    XCTAssertNil(controller.rowForTesting(row), "a store build drew \(row.rawValue)")
                } else if row != .agentCommand && row != .commandName && row != .storeInICloud {
                    // The two dependents are built with their cards but may be
                    // hidden under a switch that is off; the questions are drawn.
                    XCTAssertNotNil(controller.rowForTesting(row), "a direct build lost \(row.rawValue)")
                }
            }
            // The rest of Advanced is still there on both.
            XCTAssertNotNil(controller.rowForTesting(.resetSettings), distribution.rawValue)
        }
    }

    /// A row picked in the palette opens its pane; a pane the store build does
    /// not have is not opened, rather than drawn with nothing on it.
    func testAStoreBuildShouldNotOpenAPaneItDoesNotHave() {
        let store = makeController(.appStore)
        defer { store.window?.close() }
        store.selectTabForTesting("advanced")
        store.show(paneNamed: "aiAgent", revealing: .agentEnabled)
        XCTAssertEqual(store.window?.toolbar?.selectedItemIdentifier?.rawValue, "advanced")
    }

    func testAddThemeShouldOfferTheInstalledEditorOnlyWhereItCanBeRead() {
        let direct = makeController(.direct)
        defer { direct.window?.close() }
        let store = makeController(.appStore)
        defer { store.window?.close() }

        XCTAssertTrue(direct.addThemeTitlesForTesting.contains(SettingsWindowController.addThemeFromVSCodeTitle))
        XCTAssertFalse(store.addThemeTitlesForTesting.contains(SettingsWindowController.addThemeFromVSCodeTitle))
        // The other ways in stay, in the same order.
        XCTAssertEqual(store.addThemeTitlesForTesting,
                       direct.addThemeTitlesForTesting.filter { $0 != SettingsWindowController.addThemeFromVSCodeTitle })
        XCTAssertEqual(store.addThemeTitlesForTesting.count, 3)
    }

    func testThePaletteShouldListNoSettingAStoreBuildOmits() {
        let store = PaletteSources.settingsPanes(offeredBy: .appStore)
        let direct = PaletteSources.settingsPanes(offeredBy: .direct)
        XCTAssertEqual(direct.count, SettingsWindowController.paneNames.count)
        XCTAssertFalse(store.map(\.name).contains("aiAgent"))
        XCTAssertEqual(store.count, direct.count - 1)
        let listed = store.flatMap { SettingsForm.rows(of: $0.pane) }
        XCTAssertFalse(listed.isEmpty)
        for row in Self.omitted { XCTAssertFalse(listed.contains(row), row.rawValue) }
    }

    func testTheMenuShouldOfferCheckForUpdatesOnlyWhereTheCopyUpdatesItself() {
        let check = #selector(AppDelegate.menuCheckForUpdates)
        let direct = AppMenu.rows(offeredBy: .direct)
        let store = AppMenu.rows(offeredBy: .appStore)
        XCTAssertTrue(direct.contains { $0.action.selector == check })
        XCTAssertFalse(store.contains { $0.action.selector == check })
        XCTAssertEqual(store.count, direct.count - 1, "the store table lost more than the one row")
    }

    func testTheAboutWindowShouldDrawNoCheckButtonWithoutAnAction() {
        func titles(_ controller: AboutWindowController) -> [String] {
            var found: [String] = []
            func walk(_ view: NSView) {
                if let button = view as? NSButton { found.append(button.title) }
                view.subviews.forEach(walk)
            }
            if let content = controller.window?.contentView { walk(content) }
            return found
        }
        let with = AboutWindowController(onCheckForUpdates: {})
        defer { with.window?.close() }
        let without = AboutWindowController(onCheckForUpdates: nil)
        defer { without.window?.close() }
        XCTAssertTrue(titles(with).contains("Check for Updates…"))
        XCTAssertFalse(titles(without).contains("Check for Updates…"))
        XCTAssertFalse(titles(without).isEmpty, "the sweep found no buttons at all")
    }

    func testTheFirstRunScreenShouldNotAskAStoreBuildAboutUpdating() {
        let direct = WelcomeView(flavour: .release, distribution: .direct, onHotkeyChange: { 0 })
        let store = WelcomeView(flavour: .release, distribution: .appStore, onHotkeyChange: { 0 })
        XCTAssertNotNil(direct.rowForTesting(.autoUpdate))
        XCTAssertNil(store.rowForTesting(.autoUpdate))
        XCTAssertNotNil(store.rowForTesting(.startAtLogin), "the card the update row shared is gone too")
        XCTAssertNil(store.rowForTesting(.storeInICloud))
        XCTAssertNotNil(store.rowForTesting(.location))
    }

    /// The Location row is found by its place in its card, and leaving the
    /// iCloud switch out moves it up one. Indexed in the declaration rather
    /// than the drawn pane, the hide would land on Autosave instead.
    func testAStoreBuildShouldDrawTheLocationRowItsSwitchNoLongerHides() {
        let store = makeController(.appStore)
        defer { store.window?.close() }
        store.selectTabForTesting("general")
        let location = store.rowForTesting(.location)
        let autosave = store.rowForTesting(.autosave)
        XCTAssertNotNil(location)
        XCTAssertEqual(location?.isHidden, false, "the store build hid the one way to choose a folder")
        XCTAssertEqual(autosave?.isHidden, false, "the hide landed on the row below")
    }
}
