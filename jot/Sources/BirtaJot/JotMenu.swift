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

    /// What a command row hands its router: the command, and the argument for
    /// the commands that take one.
    ///
    /// `toggleStyleOption` is the one that does, and it is what makes the
    /// Style Options submenu derivable: fourteen rows share one command and
    /// each names its own category, rather than costing a command apiece in
    /// `shared/editorCommands.ts` and in each of the hand-written tables that
    /// have to grow with an id.
    struct Command: Hashable {
        let id: String
        /// The command's argument, for the commands that take one. Carried to
        /// the page as the `args` the editor-command message already has.
        let arg: String?

        init(_ id: String, arg: String? = nil) {
            self.id = id
            self.arg = arg
        }
    }

    /// What a row does when it is picked.
    enum Action {
        /// One of the delegate's own methods (New Note, Save, Settings).
        case app(Selector)
        /// An editor command id (`shared/editorCommands.ts`), run in the page.
        case command(String, arg: String? = nil)
        /// A URL the About window already names, opened in the browser.
        case link(AboutLink)
        /// A row that opens a submenu holding the rows that name it.
        case submenu
        /// A row that opens a submenu whose CONTENTS are not in this table,
        /// because they are not fixed: the files opened lately.
        ///
        /// The table still owns the row, its title and its place in the menu,
        /// which is what keeps this from being a menu built somewhere else.
        /// `RecentsMenu` fills itself, so neither this table nor the surface
        /// that raised it has to remember to. The selector below is what a
        /// control OUTSIDE the menu bar sends to raise the same list: the
        /// titlebar's recents button is that control, and it finds this row
        /// through `row(for:)` for its label exactly as the other two buttons
        /// find theirs.
        case recents

        var selector: Selector? {
            switch self {
            case let .app(selector): return selector
            case .command: return #selector(AppDelegate.menuRunEditorCommand(_:))
            case .link: return #selector(AppDelegate.menuOpenLink(_:))
            case .recents: return #selector(AppDelegate.menuOpenRecent(_:))
            case .submenu: return nil
            }
        }

        /// What the item carries to its action, in `representedObject`. Each
        /// selector reads exactly one kind, so one field serves both.
        var payload: Any? {
            switch self {
            case .command: return command
            case let .link(link): return link.url
            case .app, .submenu, .recents: return nil
            }
        }

        /// The command this row runs, argument included.
        ///
        /// The whole of it, because the argument is what tells two rows of the
        /// same command apart, and fourteen of them share `toggleStyleOption`.
        var command: Command? {
            if case let .command(id, arg) = self { return Command(id, arg: arg) }
            return nil
        }

        /// The editor command this row runs, for the page's declaration, which
        /// resolves a chord by command id and has no use for the argument.
        var commandId: String? { command?.id }

        /// Whether this row opens a submenu, so the count of them can be
        /// derived from the table rather than written down beside it. True of
        /// `.recents` as well: what differs there is where the ROWS come from,
        /// not whether the item is a disclosure.
        var opensSubmenu: Bool {
            switch self {
            case .submenu, .recents: return true
            case .app, .command, .link: return false
            }
        }
    }

    /// How a row draws the live state of the thing it toggles.
    ///
    /// One mechanism rather than two, because a checkmark and a Show/Hide title
    /// are the same question answered in different ink: both ask a `MenuToggle`
    /// whether the thing is on. Split them and the second row that wants the
    /// other treatment needs a second repaint path, and the two go out of step
    /// where nobody looks. `AppDelegate.menuNeedsUpdate` repaints every one of
    /// them from one `MenuState`, on every opening.
    enum RowState {
        /// A checkmark saying whether the thing is on.
        case checkmark(MenuToggle)
        /// A title naming what picking the row will DO, which is the opposite
        /// of what is on screen. `Row.title` is what it says while the thing is
        /// off; this is what it says while it is on.
        case title(MenuToggle, whenOn: String)

        /// The fact this row draws, whichever way it draws it.
        var toggle: MenuToggle {
            switch self {
            case let .checkmark(toggle): return toggle
            case let .title(toggle, _): return toggle
            }
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
        /// What this row draws of the state it toggles, or nil for a row whose
        /// title and appearance never change.
        let state: RowState?
        /// What has to be ON for this row to be offered at all. Empty for a row
        /// nothing governs.
        ///
        /// Declaring what a row NEEDS and filtering once is the shape the
        /// editor already uses for host-gated toolbar items, and it is what
        /// keeps a gate from growing a branch per governed row: a second gate
        /// is another entry in this list rather than another `if` in the
        /// repaint.
        let needs: [MenuToggle]

        init(title: String, key: String = "", modifiers: NSEvent.ModifierFlags = [],
             action: Action, menu: Menu, submenu: String? = nil, group: Int = 0,
             state: RowState? = nil, needs: [MenuToggle] = []) {
            self.title = title
            self.key = key
            self.modifiers = modifiers
            self.action = action
            self.menu = menu
            self.submenu = submenu
            self.group = group
            self.state = state
            self.needs = needs
        }

        /// What the built item answers to, so a repaint finds it again.
        ///
        /// Derived from where the row IS rather than from what it says,
        /// because one of these rows retitles itself and a lookup by title
        /// would stop finding it the first time it did. The three parts are
        /// what `fill` already treats as a row's address: a submenu is
        /// resolved by title within its menu, so two rows sharing all three
        /// would already be ambiguous to the builder. `JotMenuTests` pins that
        /// they do not.
        var itemIdentifier: NSUserInterfaceItemIdentifier {
            NSUserInterfaceItemIdentifier(
                "com.birtalabs.jot.menu.\(menu.rawValue)/\(submenu ?? "")/\(title)")
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

    /// What the recents submenu answers to, so a check can find it in a built
    /// menu without matching on a title a translation could change.
    static let recentsMenuIdentifier = NSUserInterfaceItemIdentifier("com.birtalabs.jot.openRecent")

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
    /// Rows with a selector OF THEIR OWN, which is `.app` and `.recents`, and
    /// the restriction is what makes the answer mean anything: every
    /// `.command` row shares one selector (`menuRunEditorCommand`), so a lookup
    /// that admitted them would answer any command at all with whichever row
    /// happens to be first, confidently and wrongly. An editor command's chord
    /// is `commandChords`' question on the page side.
    static func row(for selector: Selector) -> Row? {
        rows.first { row in
            switch row.action {
            case let .app(bound): return bound == selector
            case .recents: return row.action.selector == selector
            case .command, .link, .submenu: return false
            }
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
        .init(title: "Open Recent", action: .recents, menu: .file),
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
    /// level is a menu nobody reads to the bottom of. Date is the third of
    /// them: four rows that answer "which date", one of which opens a picker
    /// for the dates the other three do not name.
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
        .init(title: "Date", action: .submenu, menu: .format, group: 7),
        .init(title: "Today",
              action: .command("insertToday"), menu: .format, submenu: "Date", group: 0),
        .init(title: "Tomorrow",
              action: .command("insertTomorrow"), menu: .format, submenu: "Date", group: 0),
        .init(title: "Yesterday",
              action: .command("insertYesterday"), menu: .format, submenu: "Date", group: 0),
        .init(title: "Choose Date…",
              action: .command("insertDate"), menu: .format, submenu: "Date", group: 1),
    ]

    // MARK: view

    /// What the window shows of the document, rather than what the document
    /// says: the zoom trio macOS puts at the top of every View menu, the
    /// content font, folding, and the advisory marks drawn over the text.
    ///
    /// Proofreading is a submenu holding every check and its own master gate,
    /// which is the shape the toolbar's Checks menu already has, and the reason
    /// is that the rows would otherwise be a third of this menu. It is titled
    /// Proofreading rather than Checks because the control names its domain
    /// (docs/DESIGN_PRINCIPLES.md), and the master sits at the top of its own
    /// submenu so the thing that silences the rest is read before them. Every
    /// row in it carries a checkmark: a switch whose position you cannot see is
    /// a switch you have to flip to read.
    ///
    /// Check Spelling and Check Grammar belong here for as long as this shell
    /// answers them: they are lints the page posts OUT for a host to run, and
    /// this one runs them in `SpellService` and declares `spellAndGrammar`. Take
    /// the capability away and the rows have to go with it, which
    /// `menuChordParity.test.ts` enforces by asking `hostHasCommand` under Jot's
    /// own profile. The cost of the other error is quieter and is what these
    /// rows are being added against: a check running on every document with no
    /// control over it anywhere in the menu bar reads, to the person using it,
    /// as a check that does nothing.
    ///
    /// Folding is a submenu by the measure a submenu is worth: four rows is
    /// more than fits, they are two pairs rather than four peers, and only two
    /// of them carry a chord, so on the menu they spent four lines saying what
    /// one disclosure says. It sits beside Font because the two are the same
    /// kind of row, a pocket of view options, and a section holding both reads
    /// as one.
    ///
    /// Table of Contents is a Show/Hide pair spelled as one row that retitles
    /// itself, which is what `RowState.title` exists for. A row saying Show
    /// while the panel is out is worse than one that says neither, so the
    /// title is only allowed to change because `Prefs.tocVisibility` is a live
    /// mirror: the page posts every explicit show and hide as it happens.
    ///
    /// Focus Mode is absent, and the withdrawal is declared on the command
    /// rather than by leaving the row out here: `absentUnder` takes it from
    /// this menu, the toolbar and the palette together. The panel's bar cannot
    /// be hidden, so what the mode moved here was the proofread underlines and
    /// nothing else a reader could see.
    ///
    /// The zoom chords are the one place Jot deliberately parts from the
    /// extension, and the reason is recorded in `menuChordParity.test.ts`:
    /// ⌘+ / ⌘- / ⌘0 are VS Code's own workbench zoom, which an editor inside it
    /// must not take, so the commands ship there with no chord at all.
    ///
    /// Full Width / Fixed Width are absent by the same rule that keeps Edit Raw
    /// Markdown out: `hostHasCommand` withdraws them from a host that declares
    /// no `contentMeasure`, and a panel is already its own reading measure.
    /// The master proofreading gate, named once because four rows are governed
    /// by it and a typo in one of their keys would silently un-gate that row.
    private static let gate = MenuToggle.proofread("proofreading")

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

        .init(title: "Folding", action: .submenu, menu: .view, group: 1),
        .init(title: "Fold", key: "[", modifiers: [.command, .option],
              action: .command("fold"), menu: .view, submenu: "Folding", group: 0),
        .init(title: "Unfold", key: "]", modifiers: [.command, .option],
              action: .command("unfold"), menu: .view, submenu: "Folding", group: 0),
        .init(title: "Fold All",
              action: .command("foldAll"), menu: .view, submenu: "Folding", group: 1),
        .init(title: "Unfold All",
              action: .command("unfoldAll"), menu: .view, submenu: "Folding", group: 1),

        .init(title: "Show Table of Contents",
              action: .command("toggleToc"), menu: .view, group: 2,
              state: .title(.tocShown, whenOn: "Hide Table of Contents")),

        .init(title: "Proofreading", action: .submenu, menu: .view, group: 3,
              // Not gated on itself: the disclosure that holds the gate has to
              // be reachable to turn it back on.
              state: nil),
        // The gate, first and alone in its group, as it leads the toolbar's
        // Checks menu. It never rewrites the rows under it, so turning it back
        // on restores exactly what was on before; while it is off they are
        // WITHDRAWN rather than left ticked and inert, which is
        // `docs/DESIGN_PRINCIPLES.md`'s rule for a master and is carried by the
        // `needs:` on each of them (see `applyState` and `tidyRules`).
        .init(title: "Proofreading",
              action: .command("toggleProofreading"), menu: .view, submenu: "Proofreading", group: 0,
              state: .checkmark(.proofread("proofreading"))),
        .init(title: "Check Spelling",
              action: .command("toggleSpellCheck"), menu: .view, submenu: "Proofreading", group: 1,
              state: .checkmark(.proofread("spellCheck")), needs: [gate]),
        .init(title: "Check Grammar",
              action: .command("toggleGrammarCheck"), menu: .view, submenu: "Proofreading", group: 1,
              state: .checkmark(.proofread("grammarCheck")), needs: [gate]),
        .init(title: "Check Style",
              action: .command("toggleStyleCheck"), menu: .view, submenu: "Proofreading", group: 1,
              state: .checkmark(.proofread("styleCheck")), needs: [gate]),
        // Two gates, because the style options are two levels down: the
        // master silences everything, and Check Style silences these. Declaring
        // both is what keeps the repaint from growing a branch per gate.
        .init(title: "Style Options", action: .submenu, menu: .view, submenu: "Proofreading", group: 1,
              needs: [gate, .proofread("styleCheck")]),
        // The note-marker highlight, below the rule, governed by nothing. Same
        // rank as the gate and separated from it rather than headed, which is
        // the layout the toolbar's menu uses and for the argument
        // docs/DESIGN_PRINCIPLES.md makes: the gate silences the editor's
        // opinions about your prose, and a marker you typed is your own
        // content, so one must not take away the other.
        .init(title: "Highlight Note Markers",
              action: .command("toggleNoteHighlights"), menu: .view, submenu: "Proofreading", group: 2,
              state: .checkmark(.noteHighlight)),
    ] + styleOptionRows

    /// One row per style-check category, derived from `StyleCategory` rather
    /// than written out, and grouped by its section so the reader gets the
    /// toolbar's three clusters with rules where that menu has headings.
    ///
    /// All fourteen run ONE command with the category as its argument. A
    /// command apiece would be fourteen entries in `shared/editorCommands.ts`
    /// and in each of the hand-written tables that must grow with it, none of
    /// which a fifteenth category would join on its own.
    private static let styleOptionRows: [Row] = StyleCategory.allCases.map { category in
        Row(title: category.label,
            action: .command("toggleStyleOption", arg: category.rawValue),
            menu: .view, submenu: "Style Options",
            group: StyleCategory.Section.allCases.firstIndex(of: category.section) ?? 0,
            state: .checkmark(.proofread(category.rawValue)))
    }

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
    /// (`TitlebarDrag`). Enter Full Screen is deliberately absent, and it is
    /// absent from the View menu too, which is where macOS puts it and where it
    /// sat permanently dimmed until `BirtaJotCore.AppKitDefaults` took it away.
    /// Moving it here rather than removing it was the other option and it is
    /// the wrong one: every window this app shows is a `JotPanel`, which is
    /// `.fullScreenAuxiliary` and accompanies another window's full screen
    /// rather than taking one of its own, so the row would be as dead in this
    /// menu as it was in that one. A row that does nothing is worse than a row
    /// that is not there.
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
    ///
    /// No menu ends with a rule, and none may: the system appends nothing after
    /// these rows, so a trailing separator draws a line under nothing.
    /// `BirtaJotCore.AppKitDefaults` is what makes that true of the View menu,
    /// the one menu macOS would otherwise add to, and a menu that starts taking
    /// system rows again needs the separator back along with the reason.
    /// `JotMenuTests` holds the rule.
    @MainActor
    static func add(_ menu: Menu, to nsMenu: NSMenu, target: AnyObject) {
        fill(nsMenu, with: rows.filter { $0.menu == menu && $0.submenu == nil },
             menu: menu, target: target)
    }

    /// Repaint the rows of `nsMenu`, and of its submenus, that draw live state:
    /// the checkmarks, the one title that changes, and which rows a gate is
    /// currently withdrawing.
    ///
    /// Matched by the identifier `fill` gives every item, which is the row's
    /// address in the table rather than anything it says. A side table of items
    /// would be a second thing to keep in step with the menu it describes, and
    /// a lookup by title stops finding the one row here that retitles itself.
    ///
    /// Called from `menuNeedsUpdate` rather than kept up to date as things
    /// change, because there is nothing to be up to date WITH: the page reports
    /// each of these once, when the reader flips it, and the menu is only ever
    /// read at the moment it opens.
    @MainActor
    static func applyState(_ state: MenuState, to nsMenu: NSMenu) {
        for item in nsMenu.items {
            // Not into the recents menu: its rows are files rather than table
            // rows, and it fills itself.
            if let sub = item.submenu, sub.identifier != recentsMenuIdentifier {
                applyState(state, to: sub)
            }
            guard let identifier = item.identifier,
                  let row = rows.first(where: { $0.itemIdentifier == identifier })
            else { continue }
            // Withdrawn rather than dimmed, which is the rule a master and its
            // children have on every surface of this editor
            // (docs/DESIGN_PRINCIPLES.md): a gate that is off hides what it
            // governs instead of leaving controls that are set on and doing
            // nothing. Assigned both ways on every pass, so a row comes back
            // when the gate does.
            item.isHidden = !row.needs.allSatisfy { state.isOn($0) }
            guard let rowState = row.state else { continue }
            let on = state.isOn(rowState.toggle)
            switch rowState {
            case .checkmark: item.state = on ? .on : .off
            case let .title(_, whenOn): item.title = on ? whenOn : row.title
            }
        }
        tidyRules(in: nsMenu)
    }

    /// Hide any rule that a withdrawn group has left with nothing on one side
    /// of it.
    ///
    /// A separator is a claim that there are rows either side, so one drawn
    /// against the top or bottom of a menu, or against another separator, is a
    /// line under nothing. Recomputed from scratch on every pass rather than
    /// toggled, because the rule that is stray depends on which rows are
    /// hidden this time.
    @MainActor
    private static func tidyRules(in nsMenu: NSMenu) {
        var rowSinceLastRule = false
        var trailingRule: NSMenuItem?
        for item in nsMenu.items {
            if item.isSeparatorItem {
                item.isHidden = !rowSinceLastRule
                trailingRule = item.isHidden ? trailingRule : item
                rowSinceLastRule = false
            } else if !item.isHidden {
                rowSinceLastRule = true
                trailingRule = nil
            }
        }
        trailingRule?.isHidden = true
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
            // The row's address, so `applyState` can find this item again
            // whatever its title says by then.
            item.identifier = row.itemIdentifier
            if case .recents = row.action {
                // A menu that fills itself, rather than rows built from this
                // table: the list changes as files are opened, and a submenu
                // filled once here would be the list as it stood when the menu
                // bar was created. The action is cleared because the row's job
                // in a MENU is to open its submenu; the selector it carries is
                // for the titlebar button, which has no submenu to open.
                item.action = nil
                item.target = nil
                item.submenu = RecentsMenu()
            } else if case .submenu = row.action {
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
