import AppKit
import BirtaJotCore

/// Every menu Jot builds, as one table.
///
/// One table because there are three consumers and they must not drift: the
/// main menu is BUILT from this, the same rows are declared to the page as
/// `hostShortcuts` so the keyboard cheatsheet can print them, and
/// `shared/__tests__/menuChordParity.test.ts` reads the table to hold Jot's
/// chords against the extension's contributed keybindings. A second list
/// maintained by hand would eventually print a key the menu no longer binds,
/// and a cheatsheet that lies is worse than one that omits.
///
/// ## What is here and what is not
///
/// Only Jot's OWN actions. Undo, Cut, Copy, Paste, Select All, Close and
/// Minimize are the system's, bound by AppKit to the standard chords and
/// already known to everyone; printing them would pad the panel with things no
/// reader came to look up. The Window menu's tiling rows (Fill, Center, Move &
/// Resize, Full Screen Tile) are AppKit's own, inserted into whatever menu is
/// `NSApp.windowsMenu`, and their chords are the system's and change between
/// macOS releases: authoring them here would freeze a copy that goes stale
/// silently.
///
/// ## Why the chords are the extension's
///
/// A row that runs an editor command binds the chord the extension contributes
/// for that same command in `package.json`. Jot ships zero behavior Birta
/// lacks, and the keyboard is behavior: a gesture that means "heading 1" in one
/// surface and nothing (or something else) in the other is the same defect as a
/// button that does two things. The extension is the source, because there the
/// binding is a contribution a user can rebind and here the menu IS the
/// binding. Where the two deliberately differ, the divergence is recorded with
/// its reason in `menuChordParity.test.ts` rather than left to be discovered.
///
/// ## Why a command row's chord can be printed and the extension's cannot
///
/// The webview cannot read VS Code's effective keybindings, so it never prints
/// one (`webview/commandChords.ts`). A menu key equivalent is different in kind:
/// AppKit takes the key before the page sees it, so this table is not a claim
/// about the binding, it is the binding.
enum JotMenu {
    /// A top-level menu, in menu-bar order.
    ///
    /// `CaseIterable` so a sweep over the menus is derived rather than
    /// hand-listed: a seventh menu joins every check that walks `allCases`
    /// without an edit, which is the difference between a guard that grows and
    /// one that quietly stops covering the new thing.
    enum Menu: String, CaseIterable {
        case app, file, edit, format, view, help

        /// The heading the keyboard cheatsheet prints above this menu's keys.
        ///
        /// Not the menu-bar title for the app menu: that title is the app's
        /// display name, which differs between the release and the DEVELOPMENT
        /// flavour, and a cheatsheet heading that changes with the build is a
        /// heading no guard can compare.
        var sectionTitle: String {
            switch self {
            case .app: return "Application"
            case .file: return "File"
            case .edit: return "Edit"
            case .format: return "Format"
            case .view: return "View"
            case .help: return "Help"
            }
        }
    }

    /// What a row does when it is picked.
    enum Action {
        /// One of the delegate's own methods (New Note, Save, Settings).
        case app(Selector)
        /// An editor command id (`shared/editorCommands.ts`), run in the page.
        case command(String)
        /// A URL the About window already names, opened in the browser.
        case link(AboutLink)
        /// A row that opens a submenu holding the rows that name it.
        case submenu

        var selector: Selector? {
            switch self {
            case let .app(selector): return selector
            case .command: return #selector(AppDelegate.menuRunEditorCommand(_:))
            case .link: return #selector(AppDelegate.menuOpenLink(_:))
            case .submenu: return nil
            }
        }

        /// What the item carries to its action, in `representedObject`. Each
        /// selector reads exactly one kind, so one field serves both.
        var payload: Any? {
            switch self {
            case let .command(id): return id
            case let .link(link): return link.url
            case .app, .submenu: return nil
            }
        }

        /// The editor command this row runs, for the page's declaration.
        var commandId: String? {
            if case let .command(id) = self { return id }
            return nil
        }

        /// Whether this row only opens a submenu, so the count of them can be
        /// derived from the table rather than written down beside it.
        var opensSubmenu: Bool {
            if case .submenu = self { return true }
            return false
        }
    }

    struct Row {
        let title: String
        /// The key equivalent, or "" for a row with no chord.
        let key: String
        let modifiers: NSEvent.ModifierFlags
        let action: Action
        /// Which menu it belongs to.
        let menu: Menu
        /// The submenu that holds it, by the title of the `.submenu` row that
        /// opens it; nil for a row on the menu itself.
        let submenu: String?
        /// Separator control: a separator is drawn wherever this changes
        /// between consecutive rows OF THE SAME CONTAINER. Counted per
        /// container, so a submenu's groups are its own.
        let group: Int

        init(title: String, key: String = "", modifiers: NSEvent.ModifierFlags = [],
             action: Action, menu: Menu, submenu: String? = nil, group: Int = 0) {
            self.title = title
            self.key = key
            self.modifiers = modifiers
            self.action = action
            self.menu = menu
            self.submenu = submenu
            self.group = group
        }

        /// The chord in the page's notation, which is what the cheatsheet
        /// prints. Derived rather than written twice.
        var chord: String {
            HostShortcut.chord(
                key: key,
                command: modifiers.contains(.command),
                shift: modifiers.contains(.shift),
                option: modifiers.contains(.option),
                control: modifiers.contains(.control))
        }

        /// The chord in menu-bar symbols (⇧⌘S), in Apple's modifier order.
        ///
        /// For a control that is NOT a menu row and therefore draws its own
        /// chord: the titlebar's buttons put it in a tooltip. Same rule as
        /// `chord` and the same reason, one level further out. A tooltip
        /// naming a gesture is a claim about a binding, and the only chord a
        /// surface may print is one it can derive from the binding itself
        /// (`webview/commandChords.ts` states the rule for the page).
        ///
        /// Empty for a row with no key, so a caller gets nothing to draw
        /// rather than a bare modifier string that reads like a chord.
        var symbols: String {
            guard !key.isEmpty else { return "" }
            return HostShortcut.symbols(
                key: key,
                command: modifiers.contains(.command),
                shift: modifiers.contains(.shift),
                option: modifiers.contains(.option),
                control: modifiers.contains(.control))
        }
    }

    /// The rows, in menu order within each menu and submenu.
    static let rows: [Row] = appRows + fileRows + editRows + formatRows + viewRows + helpRows

    /// The `.app` row that runs `selector`, for a control outside the menu bar
    /// that performs the same action.
    ///
    /// The titlebar's buttons are the callers, and this is what keeps them
    /// from restating a title or a chord: a button is a second way to reach a
    /// row, so it takes its label and its key from that row rather than from a
    /// literal beside it. Nil when nothing binds the selector, which a caller
    /// must handle rather than force, because that is exactly the state a
    /// deleted row leaves behind.
    ///
    /// `.app` rows ONLY, and the restriction is what makes the answer mean
    /// anything: every `.command` row shares one selector
    /// (`menuRunEditorCommand`), so a lookup that admitted them would answer
    /// any command at all with whichever row happens to be first, confidently
    /// and wrongly. An editor command's chord is `commandChords`' question on
    /// the page side.
    static func row(for selector: Selector) -> Row? {
        rows.first { row in
            guard case .app(let bound) = row.action else { return false }
            return bound == selector
        }
    }

    // MARK: app

    private static let appRows: [Row] = [
        .init(title: "Settings…", key: ",", modifiers: [.command],
              action: .app(#selector(AppDelegate.menuOpenSettings)), menu: .app),
    ]

    // MARK: file

    private static let fileRows: [Row] = [
        .init(title: "New Note", key: "n", modifiers: [.command],
              action: .app(#selector(AppDelegate.menuNewNote)), menu: .file),
        .init(title: "Open…", key: "o", modifiers: [.command],
              action: .app(#selector(AppDelegate.menuOpenDocument)), menu: .file),
        .init(title: "Save", key: "s", modifiers: [.command],
              action: .app(#selector(AppDelegate.menuSaveNow)), menu: .file),
        .init(title: "Save a Copy As…", key: "s", modifiers: [.command, .shift],
              action: .app(#selector(AppDelegate.menuSaveAs)), menu: .file),
    ]

    // MARK: edit

    /// Find is a submenu, which is where macOS has put it since the Find bar
    /// existed: one row per direction on the Edit menu itself would put six
    /// rows about searching above the two that edit.
    private static let editRows: [Row] = [
        .init(title: "Find", action: .submenu, menu: .edit, group: 0),
        .init(title: "Find…", key: "f", modifiers: [.command],
              action: .command("openFind"), menu: .edit, submenu: "Find", group: 0),
        .init(title: "Find and Replace…", key: "f", modifiers: [.command, .option],
              action: .command("openFindReplace"), menu: .edit, submenu: "Find", group: 0),
        .init(title: "Find Next", key: "g", modifiers: [.command],
              action: .command("findNext"), menu: .edit, submenu: "Find", group: 0),
        .init(title: "Find Previous", key: "g", modifiers: [.command, .shift],
              action: .command("findPrevious"), menu: .edit, submenu: "Find", group: 0),
        .init(title: "Select Next Occurrence", key: "d", modifiers: [.command],
              action: .command("findSelection"), menu: .edit, submenu: "Find", group: 1),
        .init(title: "Change All Occurrences", key: "l", modifiers: [.command, .shift],
              action: .command("selectAllOccurrences"), menu: .edit, submenu: "Find", group: 1),
        .init(title: "Edit Block as Markdown", key: "/", modifiers: [.command],
              action: .command("editBlockSource"), menu: .edit, group: 1),
        .init(title: "Delete Block", key: "k", modifiers: [.command, .shift],
              action: .command("deleteBlock"), menu: .edit, group: 1),
        .init(title: "Join Lines", key: "j", modifiers: [.control],
              action: .command("joinLines"), menu: .edit, group: 1),
    ]

    // MARK: format

    /// The formatting controls the panel's second toolbar row carries, in a
    /// menu. The marks sit on the menu itself, as they do in every macOS text
    /// app, and so do the inserts: putting something in a document is a
    /// different kind of act from restyling what is already there, and a
    /// reader who wants a table should not have to know it was filed under
    /// formatting first. Paragraph Style and Lists stay submenus because each
    /// is one question with many answers, and a flat list of every heading
    /// level is a menu nobody reads to the bottom of.
    private static let formatRows: [Row] = [
        .init(title: "Bold", key: "b", modifiers: [.command],
              action: .command("toggleBold"), menu: .format, group: 0),
        .init(title: "Italic", key: "i", modifiers: [.command],
              action: .command("toggleItalic"), menu: .format, group: 0),
        .init(title: "Strikethrough", key: "x", modifiers: [.command, .shift],
              action: .command("toggleStrikethrough"), menu: .format, group: 0),
        .init(title: "Inline Code", key: "e", modifiers: [.command],
              action: .command("toggleInlineCode"), menu: .format, group: 0),
        .init(title: "Highlight",
              action: .command("toggleHighlight"), menu: .format, group: 0),
        .init(title: "Clear Formatting",
              action: .command("clearFormatting"), menu: .format, group: 1),

        .init(title: "Paragraph Style", action: .submenu, menu: .format, group: 2),
        .init(title: "Body", key: "0", modifiers: [.command, .option],
              action: .command("setParagraph"), menu: .format, submenu: "Paragraph Style", group: 0),
        .init(title: "Heading 1", key: "1", modifiers: [.command, .option],
              action: .command("setHeading1"), menu: .format, submenu: "Paragraph Style", group: 0),
        .init(title: "Heading 2", key: "2", modifiers: [.command, .option],
              action: .command("setHeading2"), menu: .format, submenu: "Paragraph Style", group: 0),
        .init(title: "Heading 3", key: "3", modifiers: [.command, .option],
              action: .command("setHeading3"), menu: .format, submenu: "Paragraph Style", group: 0),
        .init(title: "Heading 4", key: "4", modifiers: [.command, .option],
              action: .command("setHeading4"), menu: .format, submenu: "Paragraph Style", group: 0),
        .init(title: "Heading 5", key: "5", modifiers: [.command, .option],
              action: .command("setHeading5"), menu: .format, submenu: "Paragraph Style", group: 0),
        .init(title: "Heading 6", key: "6", modifiers: [.command, .option],
              action: .command("setHeading6"), menu: .format, submenu: "Paragraph Style", group: 0),
        .init(title: "Blockquote",
              action: .command("toggleBlockquote"), menu: .format, submenu: "Paragraph Style", group: 1),
        .init(title: "Code Block",
              action: .command("insertCodeBlock"), menu: .format, submenu: "Paragraph Style", group: 1),

        .init(title: "Lists", action: .submenu, menu: .format, group: 2),
        .init(title: "Bullet List", key: "8", modifiers: [.command, .shift],
              action: .command("toggleBulletList"), menu: .format, submenu: "Lists", group: 0),
        .init(title: "Numbered List", key: "7", modifiers: [.command, .shift],
              action: .command("toggleOrderedList"), menu: .format, submenu: "Lists", group: 0),
        .init(title: "Task List", key: "9", modifiers: [.command, .shift],
              action: .command("toggleTaskList"), menu: .format, submenu: "Lists", group: 0),
        .init(title: "Toggle Task Done", key: "d", modifiers: [.command, .shift],
              action: .command("toggleTaskChecked"), menu: .format, submenu: "Lists", group: 1),
        .init(title: "Uncheck All Tasks",
              action: .command("uncheckAllTasks"), menu: .format, submenu: "Lists", group: 1),

        .init(title: "Indent", key: "]", modifiers: [.command],
              action: .command("indentBlock"), menu: .format, group: 3),
        .init(title: "Outdent", key: "[", modifiers: [.command],
              action: .command("outdentBlock"), menu: .format, group: 3),

        .init(title: "Link…", key: "k", modifiers: [.command],
              action: .command("insertLink"), menu: .format, group: 4),
        .init(title: "Link to Section…",
              action: .command("insertSectionLink"), menu: .format, group: 4),
        .init(title: "Table",
              action: .command("insertTable"), menu: .format, group: 5),
        .init(title: "Image…",
              action: .command("insertImage"), menu: .format, group: 5),
        .init(title: "Callout",
              action: .command("insertCallout"), menu: .format, group: 5),
        .init(title: "Math",
              action: .command("insertMath"), menu: .format, group: 6),
        .init(title: "Footnote",
              action: .command("insertFootnote"), menu: .format, group: 6),
        .init(title: "Horizontal Rule",
              action: .command("insertHorizontalRule"), menu: .format, group: 6),
        .init(title: "Date…",
              action: .command("insertDate"), menu: .format, group: 7),
        .init(title: "Today",
              action: .command("insertToday"), menu: .format, group: 7),
        .init(title: "Tomorrow",
              action: .command("insertTomorrow"), menu: .format, group: 7),
        .init(title: "Yesterday",
              action: .command("insertYesterday"), menu: .format, group: 7),
    ]

    // MARK: view

    /// What the window shows of the document, rather than what the document
    /// says: the zoom trio macOS puts at the top of every View menu, the
    /// content font, folding, and the advisory marks drawn over the text.
    ///
    /// Checks holds the two the page answers by itself. Check Spelling and
    /// Check Grammar are absent because they are lints posted to a host engine
    /// this shell does not have, and `hostHasCommand` withdraws them from the
    /// toolbar's own menu for the same reason.
    ///
    /// Focus Mode is absent, and the withdrawal is declared on the command
    /// rather than by leaving the row out here: `absentUnder` takes it from
    /// this menu, the toolbar and the palette together. The panel's bar cannot
    /// be hidden and it has no table of contents, so the row silenced the
    /// proofread underlines and moved nothing a reader could see.
    ///
    /// The zoom chords are the one place Jot deliberately parts from the
    /// extension, and the reason is recorded in `menuChordParity.test.ts`:
    /// ⌘+ / ⌘- / ⌘0 are VS Code's own workbench zoom, which an editor inside it
    /// must not take, so the commands ship there with no chord at all.
    ///
    /// Full Width / Fixed Width are absent by the same rule that keeps Edit Raw
    /// Markdown out: `hostHasCommand` withdraws them from a host that declares
    /// no `contentMeasure`, and a panel is already its own reading measure.
    private static let viewRows: [Row] = [
        .init(title: "Zoom In", key: "+", modifiers: [.command],
              action: .command("increaseFontSize"), menu: .view, group: 0),
        .init(title: "Zoom Out", key: "-", modifiers: [.command],
              action: .command("decreaseFontSize"), menu: .view, group: 0),
        .init(title: "Actual Size", key: "0", modifiers: [.command],
              action: .command("resetFontSize"), menu: .view, group: 0),

        .init(title: "Font", action: .submenu, menu: .view, group: 1),
        .init(title: "Sans-Serif",
              action: .command("fontSans"), menu: .view, submenu: "Font", group: 0),
        .init(title: "Serif",
              action: .command("fontSerif"), menu: .view, submenu: "Font", group: 0),
        .init(title: "Monospace",
              action: .command("fontMono"), menu: .view, submenu: "Font", group: 0),

        .init(title: "Fold", key: "[", modifiers: [.command, .option],
              action: .command("fold"), menu: .view, group: 2),
        .init(title: "Unfold", key: "]", modifiers: [.command, .option],
              action: .command("unfold"), menu: .view, group: 2),
        .init(title: "Fold All",
              action: .command("foldAll"), menu: .view, group: 2),
        .init(title: "Unfold All",
              action: .command("unfoldAll"), menu: .view, group: 2),

        .init(title: "Checks", action: .submenu, menu: .view, group: 3),
        .init(title: "Check Style",
              action: .command("toggleStyleCheck"), menu: .view, submenu: "Checks", group: 0),
        .init(title: "Highlight Note Markers",
              action: .command("toggleNoteHighlights"), menu: .view, submenu: "Checks", group: 0),
    ]

    // MARK: help

    /// No help book, so no "<App> Help" row: an item named Help that opens a
    /// product page is a row that lies about where it goes. What the menu holds
    /// is the cheatsheet, which is the thing somebody opening Help in a text
    /// editor is usually after, and the three destinations the About window
    /// already names, from the same declaration so they cannot drift.
    ///
    /// The system's own search field arrives with `NSApp.helpMenu`, and it
    /// searches menu items, which is what a reader who cannot find a row in the
    /// Format menu and its three submenus reaches for.
    private static let helpRows: [Row] = [
        .init(title: "Keyboard Shortcuts",
              action: .command("openShortcutsHelp"), menu: .help, group: 0),
    ] + AboutLink.allCases.map { link in
        Row(title: link.title, action: .link(link), menu: .help, group: 1)
    }

    // MARK: building

    /// Every row that binds a key, as the page's own declaration.
    ///
    /// The cheatsheet's inventory: a row with no chord is a menu row and not a
    /// shortcut, and printing it would fill the panel with blank key columns.
    static var shortcuts: [HostShortcut] {
        rows.filter { !$0.key.isEmpty }.map {
            HostShortcut(keys: $0.chord, label: $0.title,
                         command: $0.action.commandId, section: $0.menu.sectionTitle)
        }
    }

    /// The Window menu, with the rows that are OURS to author and no others.
    ///
    /// Minimize and Zoom in the first group, then Bring All to Front. What
    /// sits between them is AppKit's: assigning `NSApp.windowsMenu` is what
    /// makes the system insert Fill, Center, Move & Resize and Full Screen
    /// Tile, with the chords THIS macOS gives them, and append the list of
    /// open windows below. Authoring any of that here would freeze a copy that
    /// goes stale on the next release with nothing to say so, and the copy
    /// would be wrong about the chords the day it was written, because they
    /// are the system's to choose (they are fn and Control based, and they
    /// moved between releases).
    ///
    /// The app's own rows are also what gives the system's a place in the
    /// order: inserted into a menu holding only Minimize they have nothing to
    /// arrive after and nothing to be bracketed by, and read as arbitrary.
    ///
    /// Zoom is what a double click on the titlebar already does
    /// (`TitlebarDrag`). Enter Full Screen is deliberately absent: the panel is
    /// `fullScreenAuxiliary`, so it accompanies another window's full screen
    /// rather than taking one of its own, and a row that does nothing is worse
    /// than a row that is not there.
    ///
    /// Targets stay nil so each row travels the responder chain to whichever
    /// window is in front, which is what makes them work for the Settings and
    /// About windows as well as the panel.
    @MainActor
    static func windowMenu() -> NSMenu {
        let menu = NSMenu(title: "Window")
        menu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)),
                     keyEquivalent: "m")
        menu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)),
                     keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Bring All to Front",
                     action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        return menu
    }

    /// Append `menu`'s rows, with their chords and submenus, targeting `target`.
    @MainActor
    static func add(_ menu: Menu, to nsMenu: NSMenu, target: AnyObject) {
        fill(nsMenu, with: rows.filter { $0.menu == menu && $0.submenu == nil },
             menu: menu, target: target)
    }

    @MainActor
    private static func fill(_ nsMenu: NSMenu, with rows: [Row], menu: Menu, target: AnyObject) {
        var lastGroup: Int?
        for row in rows {
            if let last = lastGroup, last != row.group {
                nsMenu.addItem(.separator())
            }
            lastGroup = row.group
            let item = nsMenu.addItem(withTitle: row.title, action: row.action.selector,
                                      keyEquivalent: row.key)
            item.keyEquivalentModifierMask = row.modifiers
            if case .submenu = row.action {
                let sub = NSMenu(title: row.title)
                fill(sub, with: Self.rows.filter { $0.menu == menu && $0.submenu == row.title },
                     menu: menu, target: target)
                item.submenu = sub
            } else {
                item.target = target
                item.representedObject = row.action.payload
            }
        }
    }
}
