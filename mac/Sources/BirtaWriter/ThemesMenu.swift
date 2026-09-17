import AppKit
import BirtaWriterCore

/// Something that can build the Theme menu knowing which themes the app
/// holds and which is in force. Answered by `AppDelegate` alone, as
/// `RecentsMenuProviding` is.
@MainActor
protocol ThemesMenuProviding: AnyObject {
    func makeThemesMenu() -> ThemesMenu
}

/// View > Theme, as a menu that fills itself.
///
///     ✓ Auto
///       Light
///       Dark
///     ─────────
///     ✓ System Theme
///       Harlan Paper
///       Harlan Slate
///     ─────────
///       Add Theme…
///
/// The first group is the MODE (`AppearanceMode`): whether the app follows
/// macOS through light and dark or is held to one. The second is what is
/// drawn in the mode in force: the page's own palette for it, or a VS Code
/// colour theme the reader has added (`ThemeStore`); picking one puts it in
/// that mode's slot, so the row ticked is the slot for the mode you are
/// looking at, and the other mode keeps its own. The list changes whenever
/// a theme is added, which is why this rebuilds on every open, for the
/// reason `RecentsMenu` gives. The checkmarks are the one setting every
/// surface reads (`Prefs.appearance`): the Appearance pane and the
/// palette's rows say the same thing, and a pick on any moves the others.
///
/// The rows have no target so a pick travels the responder chain to the app
/// delegate, and the payload is the theme's id, with "" for the system row:
/// `representedObject` cannot carry nil and still be told from a row that
/// was never given one.
@MainActor
final class ThemesMenu: NSMenu, NSMenuDelegate {
    /// What the system row is called, on every surface that lists it.
    static let systemTitle = "System Theme"
    static let addTitle = "Add Theme…"

    private let source: () -> [ThemeSummary]
    private let current: () -> String?
    private let mode: () -> AppearanceMode

    init(source: @escaping () -> [ThemeSummary] = { [] },
         current: @escaping () -> String? = { nil },
         mode: @escaping () -> AppearanceMode = { .auto }) {
        self.source = source
        self.current = current
        self.mode = mode
        super.init(title: "Theme")
        identifier = AppMenu.themesMenuIdentifier
        delegate = self
        rebuild()
    }

    required init(coder: NSCoder) { fatalError("not used") }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === self else { return }
        rebuild()
    }

    private func rebuild() {
        removeAllItems()
        let held = mode()
        for candidate in AppearanceMode.allCases {
            let item = NSMenuItem(title: candidate.title, action: #selector(AppDelegate.menuSetAppearanceMode(_:)),
                                  keyEquivalent: "")
            item.target = nil
            item.representedObject = candidate.rawValue
            item.state = candidate == held ? .on : .off
            addItem(item)
        }
        addItem(.separator())
        let picked = current()
        addItem(themeRow(title: Self.systemTitle, id: "", on: picked == nil))
        let themes = source()
        if !themes.isEmpty { addItem(.separator()) }
        for theme in themes {
            addItem(themeRow(title: theme.name, id: theme.id, on: theme.id == picked))
        }
        addItem(.separator())
        addItem(withTitle: Self.addTitle, action: #selector(AppDelegate.menuOpenThemeSettings),
                keyEquivalent: "").target = nil
        AppDelegate.suppressAutomaticIcons(in: self)
    }

    private func themeRow(title: String, id: String, on: Bool) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(AppDelegate.menuSelectTheme(_:)),
                              keyEquivalent: "")
        item.target = nil
        item.representedObject = id
        item.state = on ? .on : .off
        return item
    }
}

extension ThemeStore {
    /// The store this install reads and writes: under Application Support,
    /// named for the flavour so a development build's themes stand beside
    /// the release's rather than in for them. `BIRTA_MAC_THEMES_DIR` points a
    /// probe at a throwaway folder, as `BIRTA_MAC_DEFAULTS_SUITE` does for
    /// the settings, so a scripted run leaves the person's own themes alone.
    static let installed: ThemeStore = {
        if let dir = ProcessInfo.processInfo.environment["BIRTA_MAC_THEMES_DIR"], !dir.isEmpty {
            return ThemeStore(directory: URL(fileURLWithPath: dir, isDirectory: true))
        }
        return ThemeStore(directory: ThemeStore.directory(
            applicationSupport: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? FileManager.default.homeDirectoryForCurrentUser
                    .appendingPathComponent("Library/Application Support", isDirectory: true),
            appName: AppFlavor.current.displayName))
    }()
}

extension NSColor {
    /// The colour a theme names, for the chrome the app paints in the page's
    /// own paper. Nil for anything that is not a hex colour.
    convenience init?(themeHex hex: String) {
        guard let rgb = VSCodeTheme.rgb(hex) else { return nil }
        self.init(srgbRed: rgb.r, green: rgb.g, blue: rgb.b, alpha: 1)
    }
}
