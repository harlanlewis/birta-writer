import AppKit
import BirtaWriterCore

/// What the palette lists, gathered from the app's own tables, and what a
/// pick does (MAR-458).
///
/// Five sources, each already the app's one answer to its question, so the
/// palette invents nothing: the menu table (`AppMenu.rows`, performed through
/// the same selector and payload a menu item carries), the page's editor
/// commands that no menu names (`Coordinator.paletteCommands`, run through
/// `runEditorCommand` like a menu row's), the open windows, the Settings rows
/// (`SettingsForm`, one group per pane), and the files a window can reach (the
/// root's `FileIndex` in a directory window, the notes folder and the recents
/// elsewhere).
///
/// The action is kept beside the item rather than encoded in its id, because
/// the id has to be stable across builds (it is what recents remember) and an
/// action holds a live window. `PaletteModel` never sees the actions; it ranks
/// items, and the window looks the pick's action up by id.
enum PaletteAction {
    /// A menu row, performed as its menu item would be.
    case menu(AppMenu.Row)
    /// An editor command the page listed, with no menu row of its own.
    case pageCommand(String)
    /// Bring this window forward, selecting its tab.
    case window(Coordinator)
    /// Open this file, through the same routing a Finder open takes.
    case file(URL)
    /// Open Settings on this pane with the row in view.
    case setting(pane: String, row: SettingsRow)
    /// Put this theme in the slot of the mode in force, on every window, or
    /// the system's palette for nil.
    case theme(String?)
    /// Hold the app to a mode, or hand it back to the system.
    case appearanceMode(AppearanceMode)
}

struct PaletteCatalog {
    private(set) var items: [PaletteItem] = []
    private(set) var actions: [String: PaletteAction] = [:]
    /// Whether the file list was cut short, so the palette can say so rather
    /// than let a file's absence read as the file not existing.
    var filesTruncated = false

    mutating func add(_ item: PaletteItem, does action: PaletteAction?) {
        items.append(item)
        if let action { actions[item.id] = action }
    }

    /// Register the actions of a group's children, whose items travel inside
    /// the group.
    mutating func register(_ action: PaletteAction, for id: String) {
        actions[id] = action
    }

    func action(for id: String) -> PaletteAction? { actions[id] }
}

@MainActor
enum PaletteSources {
    /// The facts the catalog is built from, handed in rather than read, so a
    /// test can build one with no window set and no defaults domain.
    struct Context {
        /// The window the palette was opened over, or nil with none open.
        var front: Coordinator?
        /// Whether a row's action can run right now: `AppDelegate.allows`, the
        /// same gate the menu bar asks per item, so a row the menu dims (no
        /// content to save, no explorer to show, the first-run screen up) is
        /// left out here rather than offered and run. Required rather than
        /// defaulted, so a context built without the gate does not compile.
        let allows: (Selector) -> Bool

        init(front: Coordinator?, allows: @escaping (Selector) -> Bool) {
            self.front = front
            self.allows = allows
        }
        /// Every window, oldest first, as `WindowSet.windows` keeps them.
        var windows: [Coordinator] = []
        var menuState = MenuState()
        var syntaxSets: Set<SyntaxSet> = SyntaxScope.all
        /// The page's editor commands, from the front window.
        var pageCommands: [PaletteCommand] = []
        /// The front window's root and its index, when it is rooted; nil
        /// while the index is still being built.
        var root: URL?
        var rootIndex: FileIndex?
        /// The notes folder and its index, for a window on a loose file.
        var notesFolder: URL?
        var notesIndex: FileIndex?
        var recents: [URL] = []
        /// The themes the app holds, the one in force and the mode, for
        /// View > Theme's rows (`WindowSet.themeStore`, `appearance`).
        var themes: [ThemeSummary] = []
        var currentTheme: String?
        var appearanceMode: AppearanceMode = .auto
    }

    /// Menu rows the palette does not list: the two that open the palette.
    /// A palette offering to open itself is a row that does nothing anybody
    /// can see.
    private static let selfSelectors: [Selector] = [
        #selector(AppDelegate.menuOpenPalette), #selector(AppDelegate.menuGoToFile),
    ]

    /// The settings panes as the palette groups them, each under the name
    /// `SettingsWindowController.show(paneNamed:revealing:)` takes, read from
    /// the window rather than spelled here so a renamed pane cannot leave the
    /// palette opening nothing. The titles and forms are in the window's tab
    /// order, which `PaletteWindowTests` holds against the window's titles.
    static var settingsPanes: [(name: String, title: String, pane: SettingsPane)] {
        let forms: [(String, SettingsPane)] = [
            ("General", SettingsForm.general),
            ("Markdown", SettingsForm.markdown),
            ("Appearance", SettingsForm.appearance),
            ("AI Agent", SettingsForm.aiAgent),
            ("Advanced", SettingsForm.advanced(showsWelcomeScreen: true)),
        ]
        return zip(SettingsWindowController.paneNames, forms).map { ($0, $1.0, $1.1) }
    }

    static let filesSection = "Files"
    static let windowsSection = "Windows"
    static let settingsSection = "Settings"
    /// What the theme in force says after its name.
    static let currentThemeDetail = "Current"

    static func catalog(_ context: Context) -> PaletteCatalog {
        var catalog = PaletteCatalog()
        addMenuRows(to: &catalog, context)
        addPageCommands(to: &catalog, context)
        addFiles(to: &catalog, context)
        addWindows(to: &catalog, context)
        addSettings(to: &catalog, context)
        return catalog
    }

    // MARK: menu rows

    /// Every top-level row of every menu, in menu order, with a submenu as a
    /// group holding its rows. Gated as the menu bar gates them
    /// (`AppMenu.applyState`): a row the window's state has withdrawn, or a
    /// publishing target does not spell, is not offered here either, because
    /// a palette and a menu must never disagree about whether a tool exists.
    private static func addMenuRows(to catalog: inout PaletteCatalog, _ context: Context) {
        for menu in AppMenu.Menu.allCases {
            let rows = AppMenu.rows.filter { $0.menu == menu && $0.submenu == nil }
            for row in rows {
                guard let item = menuItem(row, context, &catalog) else { continue }
                catalog.add(item, does: .menu(row))
            }
        }
    }

    private static func menuItem(_ row: AppMenu.Row, _ context: Context,
                                 _ catalog: inout PaletteCatalog) -> PaletteItem? {
        guard offered(row, context) else { return nil }
        let section = row.menu.sectionTitle
        switch row.action {
        case .submenu:
            let children = AppMenu.rows
                .filter { $0.menu == row.menu && $0.submenu == row.title }
                .compactMap { child -> PaletteItem? in
                    guard let item = menuItem(child, context, &catalog) else { return nil }
                    catalog.register(.menu(child), for: item.id)
                    return item
                }
            guard !children.isEmpty else { return nil }
            return PaletteItem(id: menuId(row), title: row.title, section: section, kind: .group,
                               children: children)
        case .recents:
            // The recents are file rows in the Files section, where a query
            // finds them once; a second copy under Open Recent would list
            // every recent file twice.
            return nil
        case .themes:
            // The rows View > Theme draws, as a group under its title: the
            // three modes, then the system's palette and each theme, then
            // the way to add one. The mode and the theme in force each say
            // so rather than being left out, because a palette row that
            // names the current state is how somebody finds out what it is.
            let modes = AppearanceMode.allCases.map { mode -> PaletteItem in
                let item = PaletteItem(id: "appearance:" + mode.rawValue, title: mode.title,
                                       detail: mode == context.appearanceMode ? currentThemeDetail : nil,
                                       section: section, kind: .command)
                catalog.register(.appearanceMode(mode), for: item.id)
                return item
            }
            let system = PaletteItem(id: "theme:", title: ThemesMenu.systemTitle,
                                     detail: context.currentTheme == nil ? currentThemeDetail : nil,
                                     section: section, kind: .command)
            catalog.register(.theme(nil), for: system.id)
            let themes = context.themes.map { theme -> PaletteItem in
                let item = PaletteItem(id: "theme:" + theme.id, title: theme.name,
                                       detail: theme.id == context.currentTheme ? currentThemeDetail : nil,
                                       section: section, kind: .command)
                catalog.register(.theme(theme.id), for: item.id)
                return item
            }
            // A separator no theme id can contain: a slug is letters, digits
            // and dashes, and a shipped theme's id is that under a `default_`
            // prefix. So a theme named Add cannot take this id either way.
            let add = PaletteItem(id: "theme/add", title: ThemesMenu.addTitle, section: section, kind: .command)
            catalog.register(.setting(pane: "appearance", row: .theme), for: add.id)
            return PaletteItem(id: menuId(row), title: row.title, section: section, kind: .group,
                               children: modes + [system] + themes + [add])
        case let .app(selector) where selfSelectors.contains(selector):
            return nil
        case .app, .command, .link:
            return PaletteItem(id: menuId(row), title: title(of: row, context),
                               detail: row.symbols.isEmpty ? nil : row.symbols,
                               section: section, kind: .command)
        }
    }

    private static func menuId(_ row: AppMenu.Row) -> String { "menu:" + row.itemIdentifier.rawValue }

    /// Gated as the menu bar gates the same row: withdrawn by state or a
    /// publishing target (`AppMenu.applyState`), or dimmed by what the window
    /// in front can do right now (`AppDelegate.allows`).
    private static func offered(_ row: AppMenu.Row, _ context: Context) -> Bool {
        guard row.needs.allSatisfy({ context.menuState.isOn($0) }) else { return false }
        if let selector = row.action.selector, !context.allows(selector) { return false }
        guard let command = row.action.commandId else { return true }
        return SyntaxScope.allows(command: command, in: context.syntaxSets)
    }

    /// What a row is called HERE, which for a toggle is what picking it will
    /// do rather than what it is called on the menu.
    ///
    /// A palette row is a title and nothing else. The menu can say a row's
    /// state in a second channel, and for half of these it does, with a
    /// checkmark; there is no such channel here, so a row carrying one
    /// ("Line Numbers") arrives with its state invisible and picking it is a
    /// coin toss. `RowState.title(offTitle:isOn:)` is the one place that
    /// decides, so the rows that retitle themselves and the rows that tick
    /// cannot come to answer differently.
    private static func title(of row: AppMenu.Row, _ context: Context) -> String {
        guard let state = row.state else { return row.title }
        return state.actionTitle(offTitle: row.title, isOn: context.menuState.isOn(state.toggle))
    }

    // MARK: page commands

    /// The editor commands the page can run that no menu row names, under
    /// the heading the page gave them. A command a menu already lists is
    /// skipped, so Bold appears once, with its chord.
    private static func addPageCommands(to catalog: inout PaletteCatalog, _ context: Context) {
        let onMenus = Set(AppMenu.rows.compactMap(\.action.commandId))
        for command in context.pageCommands where !onMenus.contains(command.id) {
            catalog.add(PaletteItem(id: "command:" + command.id, title: command.title,
                                    section: command.section, kind: .command),
                        does: .pageCommand(command.id))
        }
    }

    // MARK: files

    /// In a rooted window, the root's files; elsewhere the notes folder's;
    /// then, either way, the FILES opened lately that are not already among
    /// them, so Go to File reaches what Open Recent reaches, less the folders
    /// that menu also holds (below). Each as a row
    /// whose title is the file's name and whose detail is its folder (under
    /// the root, or the folder's own name for a file outside it), so a typed
    /// folder name finds the files in it (`PaletteModel` matches a file on
    /// its detail too).
    private static func addFiles(to catalog: inout PaletteCatalog, _ context: Context) {
        var seen = Set<String>()
        func add(_ url: URL, folder: String) {
            let key = url.standardizedFileURL.path
            guard seen.insert(key).inserted else { return }
            catalog.add(fileItem(url, folder: folder), does: .file(url))
        }
        let indexed: (folder: URL, index: FileIndex)? = {
            if let root = context.root { return context.rootIndex.map { (root, $0) } }
            if let notes = context.notesFolder { return context.notesIndex.map { (notes, $0) } }
            return nil
        }()
        if let indexed {
            for relative in indexed.index.paths {
                add(indexed.folder.appendingPathComponent(relative),
                    folder: (relative as NSString).deletingLastPathComponent)
            }
            catalog.filesTruncated = indexed.index.truncated
        }
        // Files only. The recents list also remembers the FOLDERS opened as
        // directory windows (`WindowSet.openDirectory`), and this is Go to
        // File: a folder row here would be a row in a Files section that does
        // not go to a file, and the one branch that would take it treats
        // anything under the root as a file to move this tab to. Asked of the
        // name rather than of the disk, which is the same question
        // `WindowSet.openDocument` asks before it opens anything, and which
        // costs no stat per row every time the palette is built.
        for url in context.recents where DocumentTypes.accepts(url) {
            add(url, folder: url.deletingLastPathComponent().lastPathComponent)
        }
    }

    private static func fileItem(_ url: URL, folder: String) -> PaletteItem {
        PaletteItem(id: "file:" + url.standardizedFileURL.path, title: url.lastPathComponent,
                    detail: folder.isEmpty ? nil : folder, section: filesSection, kind: .file)
    }

    // MARK: windows

    /// The other windows and tabs, most recently used first, named by their
    /// file with the folder they are rooted at as the detail. The window the
    /// palette is over is left out: it is already in front.
    private static func addWindows(to catalog: inout PaletteCatalog, _ context: Context) {
        for window in context.windows.reversed() where window !== context.front {
            let file = window.boundFile
            let detail = window.explorerRoot?.lastPathComponent
                ?? WindowTitle.displayName(of: file.deletingLastPathComponent())
            catalog.add(PaletteItem(id: "window:" + file.standardizedFileURL.path,
                                    title: WindowTitle.displayName(of: file), detail: detail,
                                    section: windowsSection, kind: .window),
                        does: .window(window))
        }
    }

    // MARK: settings

    /// One group per pane, holding the pane's rows top to bottom, so a query
    /// reaches a row as "Settings › General › Show in Dock" and picking it
    /// opens the pane with the row in view.
    ///
    /// The word Settings is the pane group's `crumb` rather than part of its
    /// title, because the two surfaces need different things. Unfiltered, the
    /// panes sit under a SETTINGS heading and a row reading "Settings ›
    /// General" would say it twice; matched on a query there is no heading,
    /// and "General › Show in Dock" reads as a command called General.
    private static func addSettings(to catalog: inout PaletteCatalog, _ context: Context) {
        for pane in settingsPanes {
            let children = SettingsForm.rows(of: pane.pane).map { row -> PaletteItem in
                let item = PaletteItem(id: "setting:" + row.rawValue, title: row.rawValue,
                                       section: settingsSection, kind: .setting)
                catalog.register(.setting(pane: pane.name, row: row), for: item.id)
                return item
            }
            catalog.add(PaletteItem(id: "settings:" + pane.name, title: pane.title,
                                    section: settingsSection, kind: .group,
                                    crumb: settingsSection, children: children),
                        does: nil)
        }
    }
}
