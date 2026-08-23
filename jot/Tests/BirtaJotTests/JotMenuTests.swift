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
            "-", "Insert",
        ])
        for title in ["Paragraph Style", "Lists", "Insert"] {
            let item = format.items.first { $0.title == title }
            XCTAssertNotNil(item?.submenu, "\(title) has no submenu")
            XCTAssertFalse(item?.submenu?.items.isEmpty ?? true, "\(title)'s submenu is empty")
        }
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

    private func allItems(of menu: NSMenu) -> [NSMenuItem] {
        menu.items.flatMap { item -> [NSMenuItem] in
            if let submenu = item.submenu { return [item] + allItems(of: submenu) }
            return [item]
        }
    }
}
