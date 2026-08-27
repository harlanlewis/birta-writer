import AppKit
import BirtaJotCore
import XCTest
@testable import BirtaJot

/// The menus, BUILT and read back, rather than the table they are built from.
///
/// The distinction is the one `AboutWindowTests` draws: a row decided
/// correctly and then never added to a menu is invisible to every check
/// written over the declaration alone, and the building is where submenus,
/// separators and key equivalents actually happen.
///
/// What is NOT here, on purpose: whether AppKit's own Window-menu rows land
/// where they should. Those are inserted by the system when a menu becomes
/// `NSApp.windowsMenu`, on a running app with a window server, and asserting
/// their titles would be asserting this macOS release's vocabulary. What this
/// holds is the half that is ours: the rows we author, in the order we author
/// them, and that we author none of theirs.
@MainActor
final class JotMenuTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    /// A built menu, for one of Jot's own menus.
    private func build(_ menu: JotMenu.Menu) -> NSMenu {
        let nsMenu = NSMenu(title: menu.rawValue)
        JotMenu.add(menu, to: nsMenu, target: self)
        return nsMenu
    }

    private func titles(of menu: NSMenu) -> [String] {
        menu.items.map { $0.isSeparatorItem ? "-" : $0.title }
    }

    // MARK: the table reaches the menus

    func testEveryMenuShouldBuildRowsOfItsOwn() {
        // The sweep is derived from the enum, so a seventh menu joins it with
        // no edit here; and it asserts a floor rather than a total, because a
        // build that reached nothing is what a check written over an empty
        // menu cannot see.
        for menu in JotMenu.Menu.allCases {
            XCTAssertFalse(build(menu).items.isEmpty, "\(menu.rawValue) built nothing")
        }
    }

    func testTheFormatMenuShouldCarryTheMarksAndOpenItsSubmenus() {
        let format = build(.format)
        XCTAssertEqual(titles(of: format), [
            "Bold", "Italic", "Strikethrough", "Inline Code", "Highlight",
            "-", "Clear Formatting",
            "-", "Paragraph Style", "Lists",
            "-", "Indent", "Outdent",
            "-", "Link…", "Link to Section…",
            "-", "Table", "Image…", "Callout",
            "-", "Math", "Footnote", "Horizontal Rule",
            "-", "Date",
        ])
        for title in ["Paragraph Style", "Lists", "Date"] {
            let item = format.items.first { $0.title == title }
            XCTAssertNotNil(item?.submenu, "\(title) has no submenu")
            XCTAssertFalse(item?.submenu?.items.isEmpty ?? true, "\(title)'s submenu is empty")
        }
    }

    /// Every date the menu can insert is behind the one row that says Date, so
    /// the Format menu names the subject once rather than four times.
    func testTheDateSubmenuShouldHoldEveryDateRow() throws {
        let date = try XCTUnwrap(build(.format).items.first { $0.title == "Date" }?.submenu)
        XCTAssertEqual(titles(of: date),
                       ["Today", "Tomorrow", "Yesterday", "-", "Choose Date…"])
    }

    func testASubmenuRowShouldOpenItsSubmenuAndRouteNothingElse() {
        // "A submenu row has no action" is not the invariant and cannot be:
        // attaching a submenu to an item whose action is nil makes AppKit
        // install its OWN `submenuAction:`, so every submenu row has one. What
        // must hold is that the action is that opener rather than one of ours,
        // because AppKit leaves an action already in place alone, so a row
        // given a router keeps it AND opens the submenu, and picking the
        // parent would fire a command the reader was only navigating past.
        let opener = #selector(NSMenu.submenuAction(_:))
        var seen = 0
        for menu in JotMenu.Menu.allCases {
            for item in allItems(of: build(menu)) where item.submenu != nil {
                XCTAssertEqual(item.action, opener,
                               "\(item.title) opens a submenu and routes \(item.action.map(NSStringFromSelector) ?? "nothing")")
                XCTAssertFalse(item.submenu!.items.isEmpty, "\(item.title)'s submenu is empty")
                seen += 1
            }
        }
        // The sweep says what it reached, against the table rather than a
        // number: a build that attached no submenu at all would otherwise
        // satisfy every assertion above by never running one.
        XCTAssertEqual(seen, JotMenu.rows.filter { $0.action.opensSubmenu }.count,
                       "the sweep did not reach every submenu row the table declares")
        XCTAssertGreaterThan(seen, 0)
    }

    /// The sidebar's row, which exists at all only because the shell now
    /// declares the `toc` capability. `menuChordParity.test.ts` is the arm that
    /// fails if the capability is ever taken away and this row is left behind,
    /// by asking `hostHasCommand` under Jot's own profile; this is the positive
    /// half.
    func testTheViewMenuShouldOfferTheTableOfContents() {
        let item = build(.view).items.first { $0.title == "Table of Contents" }
        XCTAssertNotNil(item)
        XCTAssertEqual(item?.representedObject as? String, "toggleToc")
        XCTAssertNil(item?.submenu, "one row, not a menu about the sidebar")
    }

    func testTheViewMenuShouldPutFoldingBehindOneRow() throws {
        let view = build(.view)
        XCTAssertEqual(titles(of: view), [
            "Zoom In", "Zoom Out", "Actual Size",
            "-", "Font", "Folding",
            "-", "Table of Contents",
            "-", "Check Style", "Highlight Note Markers",
            "-",
        ])
        let folding = try XCTUnwrap(view.items.first { $0.title == "Folding" }?.submenu)
        XCTAssertEqual(titles(of: folding),
                       ["Fold", "Unfold", "-", "Fold All", "Unfold All"])
    }

    /// The rule at the end of the View menu, which is the only menu that has
    /// one and the only menu AppKit appends to.
    ///
    /// Enter Full Screen arrives after this table's last row carrying an IMAGE,
    /// and macOS aligns the titles in a separator-delimited section against the
    /// widest image column in it. Without the rule, whichever group ends up
    /// last is indented by the width of a glyph none of its rows has.
    ///
    /// Derived from `systemAppendsRows` rather than written as "the View menu",
    /// so a second menu that starts taking system rows is covered by declaring
    /// it and nothing here. The negative arm is the one that matters: a
    /// trailing rule on a menu nothing is appended to is a stray line under the
    /// last row.
    func testOnlyAMenuTheSystemAppendsToShouldEndWithARule() {
        var appended = 0
        for menu in JotMenu.Menu.allCases {
            let items = build(menu).items
            let ends = items.last?.isSeparatorItem ?? false
            XCTAssertEqual(ends, menu.systemAppendsRows,
                           "\(menu.rawValue) ends with a rule: \(ends)")
            if menu.systemAppendsRows { appended += 1 }
        }
        XCTAssertGreaterThan(appended, 0,
                             "no menu declares that the system appends to it, so this proved nothing")
    }

    // MARK: open recent

    func testTheFileMenuShouldOpenRecentThroughASubmenuOfItsOwn() {
        let file = build(.file)
        XCTAssertEqual(titles(of: file), ["New Note", "Open…", "Open Recent", "Save", "Save a Copy As…"])
        let item = file.items.first { $0.title == "Open Recent" }
        // A submenu row and nothing else. The selector the table gives this
        // row is for the titlebar's button; leaving it on the menu item would
        // fire it as the reader navigated past the row into the submenu.
        XCTAssertEqual(item?.submenu?.identifier, JotMenu.recentsMenuIdentifier)
        XCTAssertEqual(item?.action, #selector(NSMenu.submenuAction(_:)))
    }

    func testTheRecentsRowShouldBeReachableBySelectorForTheTitlebarButton() {
        // What the titlebar button asks for: the row it repeats, so its label
        // and its tooltip are the menu's rather than literals beside it. The
        // lookup admits `.app` and `.recents` rows and nothing else, so this
        // also pins that it did not start answering command rows.
        let row = JotMenu.row(for: #selector(AppDelegate.menuOpenRecent(_:)))
        XCTAssertEqual(row?.title, "Open Recent")
        XCTAssertNil(JotMenu.row(for: #selector(AppDelegate.menuRunEditorCommand(_:))),
                     "every command row shares one selector, so none may be found this way")
    }

    func testTheHeadingRowsShouldCarryTheirOwnChords() {
        let styles = build(.format).items.first { $0.title == "Paragraph Style" }?.submenu
        XCTAssertNotNil(styles)
        let heading1 = styles?.items.first { $0.title == "Heading 1" }
        XCTAssertEqual(heading1?.keyEquivalent, "1")
        XCTAssertEqual(heading1?.keyEquivalentModifierMask, NSEvent.ModifierFlags([.command, .option]))
    }

    func testTheViewMenuShouldOfferTheZoomTrioAndTheFontSubmenu() {
        let view = build(.view)
        let zoomOut = view.items.first { $0.title == "Zoom Out" }
        // The hyphen is the key, not a separator: the notation the page reads
        // spells both the same way, and this is the row that proves which one
        // this is.
        XCTAssertEqual(zoomOut?.keyEquivalent, "-")
        XCTAssertEqual(zoomOut?.keyEquivalentModifierMask, NSEvent.ModifierFlags([.command]))
        XCTAssertEqual(view.items.first { $0.title == "Font" }?.submenu?.items.count, 3)
    }

    /// The View menu carries only the checks the page answers by itself, on the
    /// menu rather than behind a submenu. Check Spelling and Check Grammar go
    /// to a host lint engine this shell does not have, and Focus Mode is
    /// withdrawn under `fixedToolbarLayout`; all three would be rows that light
    /// up and do nothing. `menuChordParity.test.ts` is what fails when one of
    /// those is added back, by asking `hostHasCommand` under Jot's own profile;
    /// this is the positive half, so a build that lost the rows entirely cannot
    /// pass by having nothing dead in it.
    func testTheViewMenuShouldOfferTheChecksThePageAnswersAndNotTheOthers() throws {
        let view = build(.view)

        let styleCheck = try XCTUnwrap(view.items.first { $0.title == "Check Style" })
        XCTAssertNil(styleCheck.submenu, "the two check rows are the menu's own")
        XCTAssertNotNil(view.items.first { $0.title == "Highlight Note Markers" })
        // Where they sit is `testTheViewMenuShouldPutFoldingBehindOneRow`'s,
        // which asserts the whole order in one place. A second slice of it
        // here would be a copy that a reordering has to be made to agree with
        // twice.
        for absent in ["Focus Mode", "Checks", "Check Spelling", "Check Grammar"] {
            XCTAssertNil(view.items.first { $0.title == absent },
                         "\(absent) is not a row this surface can honour")
        }
    }

    func testEveryCommandRowShouldCarryItsCommandIdToOneRouter() {
        // One selector for every command row, with the id in
        // `representedObject`: the shape that lets a new row be a line in the
        // table and nothing in the delegate.
        let router = #selector(AppDelegate.menuRunEditorCommand(_:))
        var seen = 0
        for menu in JotMenu.Menu.allCases {
            for item in allItems(of: build(menu)) where item.action == router {
                XCTAssertTrue(item.representedObject is String,
                              "\(item.title) routes a command but carries no id")
                XCTAssertFalse((item.representedObject as? String ?? "").isEmpty)
                seen += 1
            }
        }
        XCTAssertGreaterThan(seen, 20, "the sweep found almost no command rows")
    }

    func testTheHelpMenuShouldCarryTheAboutWindowsOwnDestinations() {
        // Same declaration as the About window, so the two cannot name
        // different places; `AboutLink` being `CaseIterable` is what makes a
        // fourth destination reach both with no edit.
        let help = titles(of: build(.help))
        for link in AboutLink.allCases {
            XCTAssertTrue(help.contains(link.title), "Help is missing \(link.title)")
        }
        XCTAssertTrue(help.contains("Keyboard Shortcuts"))
    }

    // MARK: the page's declaration

    func testTheDeclaredShortcutsShouldBeExactlyTheRowsThatBindAKey() {
        let keyed = JotMenu.rows.filter { !$0.key.isEmpty }
        XCTAssertEqual(JotMenu.shortcuts.count, keyed.count)
        XCTAssertGreaterThan(JotMenu.shortcuts.count, 20)
        // A row with no key is a menu row, not a shortcut: printing it would
        // put a blank key column in the cheatsheet.
        XCTAssertFalse(JotMenu.shortcuts.contains { $0.keys.isEmpty })
        for (shortcut, row) in zip(JotMenu.shortcuts, keyed) {
            XCTAssertEqual(shortcut.label, row.title)
            XCTAssertEqual(shortcut.keys, row.chord)
            XCTAssertEqual(shortcut.command, row.action.commandId)
            XCTAssertEqual(shortcut.section, row.menu.sectionTitle)
        }
    }

    func testACommandRowShouldDeclareItsCommandAndAnAppRowShouldNot() {
        let link = JotMenu.shortcuts.first { $0.label == "Link…" }
        XCTAssertEqual(link?.command, "insertLink")
        XCTAssertEqual(link?.keys, "Mod-k")
        // Save is the shell's own gesture and reaches no editor command, so it
        // declares none: the page resolves a chord BY command, and a command
        // that is not there is what stops a tooltip claiming this key.
        XCTAssertNil(JotMenu.shortcuts.first { $0.label == "Save" }?.command)
    }

    // MARK: rows a button repeats

    func testFileShouldOfferOpenOnTheConventionalChord() {
        let open = JotMenu.rows.first { $0.title == "Open…" }
        XCTAssertEqual(open?.menu, .file)
        XCTAssertEqual(open?.chord, "Mod-o")
        XCTAssertEqual(open?.action.selector, #selector(AppDelegate.menuOpenDocument))
        // Between New Note and Open Recent, which is where every macOS File
        // menu puts the pair, and above Save. Asserted on the built menu rather
        // than on the table, because the order a person reads is the one `fill`
        // produces.
        XCTAssertEqual(Array(titles(of: build(.file))[0..<4]),
                       ["New Note", "Open…", "Open Recent", "Save"])
    }

    func testARowShouldBeReachableByItsSelectorAndPrintItsOwnChord() {
        let new = JotMenu.row(for: #selector(AppDelegate.menuNewNote))
        XCTAssertEqual(new?.title, "New Note")
        XCTAssertEqual(new?.symbols, "⌘N")
        XCTAssertEqual(JotMenu.row(for: #selector(AppDelegate.menuOpenDocument))?.symbols, "⌘O")
        // Apple's modifier order, and every modifier drawn: a lookup that
        // dropped one would print a chord that opens something else.
        XCTAssertEqual(JotMenu.row(for: #selector(AppDelegate.menuSaveAs))?.symbols, "⇧⌘S")
        // A row with no key offers nothing to draw rather than a bare modifier
        // string, which reads like a chord and is not one.
        XCTAssertEqual(JotMenu.Row(title: "x", action: .app(#selector(AppDelegate.menuNewNote)),
                                   menu: .file).symbols, "")
    }

    func testTheSelectorLookupShouldRefuseTheCommandRowsSharedSelector() {
        // Every `.command` row runs `menuRunEditorCommand`, so a lookup that
        // admitted them would answer any editor command at all with whichever
        // row happens to be first, and a button's tooltip would name a gesture
        // that does something else.
        XCTAssertNil(JotMenu.row(for: #selector(AppDelegate.menuRunEditorCommand(_:))))
        XCTAssertNil(JotMenu.row(for: #selector(AppDelegate.menuOpenAbout)))
    }

    // MARK: the Window menu

    func testTheWindowMenuShouldAuthorTheAppsOwnRowsAndNoneOfTheSystems() {
        let window = JotMenu.windowMenu()
        XCTAssertEqual(titles(of: window), ["Minimize", "Zoom", "-", "Bring All to Front"])
        XCTAssertEqual(window.items.first?.keyEquivalent, "m")
        // The rows AppKit inserts once this becomes `NSApp.windowsMenu`. If one
        // is ever authored here it will carry a chord this file chose, which is
        // the system's to choose and changes between releases.
        for system in ["Fill", "Center", "Move & Resize", "Full Screen Tile",
                       "Return to Previous Size", "Enter Full Screen"] {
            XCTAssertFalse(titles(of: window).contains(system),
                           "\(system) is AppKit's row, not ours to author")
        }
        // Responder-chain rows: a target here would pin them to one object and
        // they would stop working for the Settings and About windows.
        XCTAssertTrue(window.items.allSatisfy { $0.target == nil })
    }

    // MARK: chords

    func testNoTwoRowsShouldBindTheSameChord() {
        // A duplicate key equivalent is a row that never fires: AppKit gives
        // the key to the first item that claims it.
        var seen: [String: String] = [:]
        for row in JotMenu.rows where !row.key.isEmpty {
            let chord = row.chord
            XCTAssertNil(seen[chord], "\(chord) is bound by both \(seen[chord] ?? "") and \(row.title)")
            seen[chord] = row.title
        }
    }

    /// Every item in a menu and its submenus, EXCEPT inside the recents menu.
    ///
    /// That one's rows are files rather than table rows, so descending into it
    /// would make a sweep over what the table declares depend on how many notes
    /// the machine running the tests happens to have opened, which is a check
    /// that passes or fails for a reason that is not about the code. The row
    /// that opens it is still returned, so the row itself is covered.
    private func allItems(of menu: NSMenu) -> [NSMenuItem] {
        menu.items.flatMap { item -> [NSMenuItem] in
            guard let submenu = item.submenu else { return [item] }
            if submenu.identifier == JotMenu.recentsMenuIdentifier { return [item] }
            return [item] + allItems(of: submenu)
        }
    }
}
