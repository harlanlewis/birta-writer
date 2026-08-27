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

    // MARK: the bar

    /// The menu bar, left to right.
    ///
    /// Nothing asserted this, and the order is not in the table: it is the
    /// sequence of `addItem` calls in `AppDelegate.mainMenu()`, so the only
    /// thing that had ever said what it should be was a comment beside them.
    /// The expectation is written out here rather than read from the code it
    /// checks, which is what keeps it from agreeing with a reordering.
    ///
    /// The bar draws each item's SUBMENU title, not the item's own: the items
    /// are created untitled, and a probe that titled the item and left the
    /// submenu called something else showed the submenu's word in the bar.
    ///
    /// `mainMenu()` builds and installs nothing, which is why a test may call
    /// it: assigning `NSApp.windowsMenu` is what makes the system insert its
    /// tiling rows, and that belongs to a running app rather than to this.
    func testTheMenuBarShouldReadLeftToRightInTheStandardOrder() {
        let built = AppDelegate().mainMenu()
        XCTAssertEqual(built.menu.items.map { $0.submenu?.title ?? $0.title },
                       [AppFlavor.current.displayName,
                        "File", "Edit", "View", "Format", "Window", "Help"])
        // The two the caller has to install, returned rather than looked up
        // again by title.
        XCTAssertEqual(built.windows.title, "Window")
        XCTAssertEqual(built.help.title, "Help")
        XCTAssertTrue(built.menu.items.contains { $0.submenu === built.windows })
        XCTAssertTrue(built.menu.items.contains { $0.submenu === built.help })
        // Every top-level item opens a menu. An item with no submenu is a row
        // in the bar that does nothing, and it would still satisfy an order
        // read off `title` alone.
        XCTAssertTrue(built.menu.items.allSatisfy { $0.submenu != nil })
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
    ///
    /// It is titled for what picking it will DO, so the title in the table is
    /// the one a hidden panel gets; `testTheOutlineRowShouldSayWhatPickingItDoes`
    /// is the half about the other state.
    func testTheViewMenuShouldOfferTheTableOfContents() {
        let item = build(.view).items.first { $0.title == "Show Table of Contents" }
        XCTAssertNotNil(item)
        XCTAssertEqual((item?.representedObject as? JotMenu.Command)?.id, "toggleToc")
        XCTAssertNil(item?.submenu, "one row, not a menu about the sidebar")
    }

    func testTheViewMenuShouldPutFoldingBehindOneRow() throws {
        let view = build(.view)
        XCTAssertEqual(titles(of: view), [
            "Zoom In", "Zoom Out", "Actual Size",
            "-", "Font", "Folding",
            "-", "Show Table of Contents",
            "-", "Proofreading",
        ])
        let folding = try XCTUnwrap(view.items.first { $0.title == "Folding" }?.submenu)
        XCTAssertEqual(titles(of: folding),
                       ["Fold", "Unfold", "-", "Fold All", "Unfold All"])
    }

    /// No menu ends with a rule.
    ///
    /// A trailing separator is only ever right under rows the system appends,
    /// and it is right there because Enter Full Screen arrives carrying an
    /// IMAGE: macOS aligns the titles in a separator-delimited section against
    /// the widest image column in it, so without a rule between them the last
    /// group is indented by the width of a glyph none of its rows has.
    /// `AppKitDefaults` removes that row, so the separator that bracketed it
    /// now draws a line under nothing. If a menu ever starts taking system rows
    /// again, this is the check to change, along with `JotMenu.add`.
    ///
    /// Derived from the enum, so a seventh menu joins with no edit here, and it
    /// says what it reached: a sweep over no menus asserts nothing.
    func testNoMenuShouldEndWithARule() {
        var swept = 0
        for menu in JotMenu.Menu.allCases {
            let items = build(menu).items
            XCTAssertFalse(items.last?.isSeparatorItem ?? false,
                           "\(menu.rawValue) ends with a rule, which draws a line under nothing")
            swept += 1
        }
        XCTAssertEqual(swept, JotMenu.Menu.allCases.count)
        XCTAssertGreaterThan(swept, 0)
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

    /// Every check the panel runs, behind one row that names the domain.
    ///
    /// Check Spelling and Check Grammar are here now, and the negative arm they
    /// used to be in was a claim that had stopped being true: they go to a host
    /// lint engine, and this shell HAS one (`SpellService`, and the profile
    /// declares `spellAndGrammar`). What that left was two checks running on
    /// every document with no control over either in the menu bar.
    ///
    /// The two arms that still mean something are kept. Focus Mode is withdrawn
    /// under `fixedToolbarLayout`, so it would light up and do nothing;
    /// `menuChordParity.test.ts` is the half that fails if it is added back, by
    /// asking `hostHasCommand` under Jot's own profile. And the submenu is
    /// called Proofreading rather than Checks, because a control names its
    /// domain (docs/DESIGN_PRINCIPLES.md).
    func testTheProofreadingSubmenuShouldHoldEveryCheckThisSurfaceRuns() throws {
        let view = build(.view)
        let proofreading = try XCTUnwrap(view.items.first { $0.title == "Proofreading" }?.submenu)
        XCTAssertEqual(titles(of: proofreading), [
            "Proofreading",
            "-", "Check Spelling", "Check Grammar", "Check Style", "Style Options",
            "-", "Highlight Note Markers",
        ])
        for absent in ["Focus Mode", "Checks"] {
            XCTAssertNil(allItems(of: view).first { $0.title == absent },
                         "\(absent) is not a row this surface can honour")
        }
    }

    /// The Style Options submenu, derived from `StyleCategory` rather than
    /// written out, and grouped by section with rules where the toolbar's own
    /// menu has headings.
    ///
    /// The count is asserted against the enum rather than against a number, so
    /// a fifteenth category joins this by existing;
    /// `shared/__tests__/styleCategories.test.ts` is what holds that enum
    /// against the page's own list.
    func testTheStyleOptionsSubmenuShouldOfferEveryCategoryThePageToggles() throws {
        let proofreading = try XCTUnwrap(
            build(.view).items.first { $0.title == "Proofreading" }?.submenu)
        let options = try XCTUnwrap(
            proofreading.items.first { $0.title == "Style Options" }?.submenu)
        let rows = options.items.filter { !$0.isSeparatorItem }
        XCTAssertEqual(rows.map { $0.title }, StyleCategory.allCases.map { $0.label })
        XCTAssertEqual(rows.count, StyleCategory.allCases.count)
        XCTAssertGreaterThan(rows.count, 10)
        // One command for all of them, each row naming its own category. A row
        // that lost its argument would toggle nothing and read as a live row.
        for (row, category) in zip(rows, StyleCategory.allCases) {
            let command = row.representedObject as? JotMenu.Command
            XCTAssertEqual(command?.id, "toggleStyleOption", row.title)
            XCTAssertEqual(command?.arg, category.rawValue, row.title)
        }
        // The three sections, so the rules fall where the toolbar's headings
        // do: two separators for three groups.
        XCTAssertEqual(options.items.filter { $0.isSeparatorItem }.count,
                       StyleCategory.Section.allCases.count - 1)
    }

    // MARK: what a row says of the state it toggles

    /// Every stateful row repainted from one `MenuState`, checkmarks and title
    /// together.
    ///
    /// Read back off the BUILT menu, because a row that decided its state
    /// correctly and was never repainted is invisible to a check written over
    /// the table alone. The rows are found by their command rather than by
    /// title, since one of them is about to have a different title.
    func testEveryStatefulRowShouldDrawTheStateItIsGiven() throws {
        let view = build(.view)
        let items = allItems(of: view)

        JotMenu.applyState(MenuState(proofreadOptions: ["spellCheck": false, "fillers": false],
                                     noteHighlight: false,
                                     tocShown: true),
                           to: view)
        XCTAssertEqual(row(items, "toggleSpellCheck")?.state, .off)
        XCTAssertEqual(row(items, "toggleGrammarCheck")?.state, .on,
                       "an option the reader never touched is on, because that is its default")
        XCTAssertEqual(row(items, "toggleProofreading")?.state, .on)
        XCTAssertEqual(row(items, "toggleNoteHighlights")?.state, .off)
        XCTAssertEqual(row(items, "toggleStyleOption", arg: "fillers")?.state, .off)
        XCTAssertEqual(row(items, "toggleStyleOption", arg: "passive")?.state, .on)
        XCTAssertEqual(row(items, "toggleToc")?.title, "Hide Table of Contents")

        // And back, so the repaint is a function of the state rather than a
        // one-way flip: a row that only ever turned off would pass every line
        // above.
        JotMenu.applyState(MenuState(proofreadOptions: ["spellCheck": true, "fillers": true],
                                     noteHighlight: true,
                                     tocShown: false),
                           to: view)
        XCTAssertEqual(row(items, "toggleSpellCheck")?.state, .on)
        XCTAssertEqual(row(items, "toggleNoteHighlights")?.state, .on)
        XCTAssertEqual(row(items, "toggleStyleOption", arg: "fillers")?.state, .on)
        XCTAssertEqual(row(items, "toggleToc")?.title, "Show Table of Contents")
    }

    /// The sweep reached every row that declares a state, and no others.
    ///
    /// The floor the check above cannot assert for itself: a repaint that
    /// matched nothing would leave every item at its built value, which for a
    /// checkmark is `.off` and reads exactly like a row that was told to be
    /// off.
    func testTheRepaintShouldReachEveryRowThatDeclaresAState() {
        let view = build(.view)
        let items = allItems(of: view)
        // Everything on, which is not the state a built menu is in: an item
        // starts at `.off`, so a row left untouched fails here.
        JotMenu.applyState(MenuState(proofreadOptions: [:], noteHighlight: true, tocShown: false),
                           to: view)
        let declared = JotMenu.rows.filter { $0.menu == .view && $0.state != nil }
        var checked = 0
        for declaredRow in declared {
            guard let command = declaredRow.action.command,
                  let item = items.first(where: { ($0.representedObject as? JotMenu.Command) == command })
            else {
                XCTFail("\(declaredRow.title) declares a state and is not in the built menu")
                continue
            }
            if case .checkmark = declaredRow.state {
                XCTAssertEqual(item.state, .on, declaredRow.title)
                checked += 1
            }
        }
        XCTAssertEqual(checked, declared.filter {
            if case .checkmark = $0.state { return true }
            return false
        }.count)
        XCTAssertGreaterThan(checked, 15, "the sweep found almost no stateful rows")
        // Nothing OUTSIDE the declaration was touched: a repaint that marked
        // every command row would look right on the rows it was written for.
        let stateless = JotMenu.rows.filter { $0.menu == .view && $0.state == nil && $0.action.command != nil }
        XCTAssertGreaterThan(stateless.count, 5)
        for statelessRow in stateless {
            let item = items.first { ($0.representedObject as? JotMenu.Command) == statelessRow.action.command }
            XCTAssertEqual(item?.state, .off, statelessRow.title)
        }
    }

    private func row(_ items: [NSMenuItem], _ id: String, arg: String? = nil) -> NSMenuItem? {
        items.first { ($0.representedObject as? JotMenu.Command) == JotMenu.Command(id, arg: arg) }
    }

    func testEveryCommandRowShouldCarryItsCommandIdToOneRouter() {
        // One selector for every command row, with the command in
        // `representedObject`: the shape that lets a new row be a line in the
        // table and nothing in the delegate.
        let router = #selector(AppDelegate.menuRunEditorCommand(_:))
        var seen = 0
        for menu in JotMenu.Menu.allCases {
            for item in allItems(of: build(menu)) where item.action == router {
                guard let command = item.representedObject as? JotMenu.Command else {
                    XCTFail("\(item.title) routes a command but carries no id")
                    continue
                }
                XCTAssertFalse(command.id.isEmpty)
                seen += 1
            }
        }
        XCTAssertGreaterThan(seen, 20, "the sweep found almost no command rows")
    }

    /// No two rows run the same command with the same argument.
    ///
    /// `JotMenu.applyState` finds a row by what its item carries, so a
    /// duplicate would give one row's state to another; and a reader offered
    /// the same command in two places has a menu that has grown a copy rather
    /// than a second route. The argument is part of the identity, which is what
    /// lets fourteen Style Options rows share one command.
    func testNoTwoRowsShouldRunTheSameCommand() {
        var seen: [JotMenu.Command: String] = [:]
        var counted = 0
        for row in JotMenu.rows {
            guard let command = row.action.command else { continue }
            counted += 1
            XCTAssertNil(seen[command],
                         "\(command.id) is run by both \(seen[command] ?? "") and \(row.title)")
            seen[command] = row.title
        }
        XCTAssertGreaterThan(counted, 40, "the sweep found almost no command rows")
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
