import XCTest
import AppKit
import BirtaWriterCore
@testable import BirtaWriter

/// The Format menu under a narrowed publishing target.
///
/// Read back off the BUILT menu rather than off the table, for the reason the
/// stateful-row check gives: a row that would have been withdrawn correctly and
/// was never repainted is invisible to a check written over the table alone,
/// and this menu had no repaint at all until targets existed.
///
/// Why the menu needs its own gate when the page has one: AppKit takes a key
/// equivalent before the page ever sees the keystroke, so a row left on this
/// menu is not merely a row, it is a working chord for a tool every other
/// surface in the same window has stopped offering.
@MainActor
final class FormatMenuSyntaxTests: XCTestCase {
    private func formatMenu() -> NSMenu {
        let menu = NSMenu(title: "Format")
        AppMenu.add(.format, to: menu, target: self)
        return menu
    }

    private func allItems(of menu: NSMenu) -> [NSMenuItem] {
        menu.items.flatMap { item -> [NSMenuItem] in
            guard let submenu = item.submenu else { return [item] }
            if submenu.identifier == AppMenu.recentsMenuIdentifier { return [item] }
            return [item] + allItems(of: submenu)
        }
    }

    private func item(_ items: [NSMenuItem], _ id: String) -> NSMenuItem? {
        items.first { ($0.representedObject as? AppMenu.Command)?.id == id }
    }

    func testACommonMarkOnlyTargetShouldWithdrawTheRowsThatWriteBeyondIt() {
        let menu = formatMenu()
        let items = allItems(of: menu)
        AppMenu.applyState(MenuState(), syntaxSets: [], to: menu)

        for id in ["toggleStrikethrough", "toggleHighlight", "toggleTaskList",
                   "insertTable", "insertCallout", "insertMath", "insertFootnote"] {
            XCTAssertEqual(item(items, id)?.isHidden, true, "\(id) should be withdrawn")
        }
    }

    func testTheSameTargetShouldLeaveTheCommonMarkRowsAlone() {
        let menu = formatMenu()
        let items = allItems(of: menu)
        AppMenu.applyState(MenuState(), syntaxSets: [], to: menu)

        // The discriminating half. Without it every assertion above would pass
        // on a repaint that simply hid the whole menu.
        for id in ["toggleBold", "toggleItalic", "toggleInlineCode", "clearFormatting",
                   "setParagraph", "setHeading1", "toggleBlockquote", "insertCodeBlock",
                   "toggleBulletList", "toggleOrderedList", "insertLink",
                   "insertHorizontalRule", "insertImage"] {
            XCTAssertEqual(item(items, id)?.isHidden, false, "\(id) should survive")
        }
    }

    func testTaskEditingShouldSurviveATargetWithNoTaskLists() {
        let menu = formatMenu()
        let items = allItems(of: menu)
        AppMenu.applyState(MenuState(), syntaxSets: [], to: menu)

        // A note holding a task list still renders one, so the rows that act on
        // a box that is already there stay while the row that would make a new
        // one goes. The pair is what makes the rule checkable.
        XCTAssertEqual(item(items, "toggleTaskList")?.isHidden, true)
        XCTAssertEqual(item(items, "toggleTaskChecked")?.isHidden, false)
        XCTAssertEqual(item(items, "uncheckAllTasks")?.isHidden, false)
    }

    func testARowShouldComeBackWithTheTargetThatSpellsIt() {
        let menu = formatMenu()
        let items = allItems(of: menu)

        AppMenu.applyState(MenuState(), syntaxSets: [.gfm], to: menu)
        XCTAssertEqual(item(items, "insertTable")?.isHidden, false)
        XCTAssertEqual(item(items, "toggleHighlight")?.isHidden, true,
                       "highlights are Obsidian's alone")

        AppMenu.applyState(MenuState(), syntaxSets: [.obsidian], to: menu)
        XCTAssertEqual(item(items, "toggleHighlight")?.isHidden, false)

        // And all the way back, so the repaint is a function of the target
        // rather than a one-way withdrawal.
        AppMenu.applyState(MenuState(), syntaxSets: SyntaxScope.all, to: menu)
        for item in allItems(of: menu) {
            XCTAssertFalse(item.isHidden, "\(item.title) should be back")
        }
    }

    func testNoTargetShouldLeaveARuleAgainstNothing() {
        // `tidyRules` is what keeps a withdrawn group from leaving its own
        // separator behind, and every combination is cheap enough to check
        // exhaustively rather than to sample. A menu whose first or last
        // visible row is a rule, or which shows two in a row, is a line under
        // nothing.
        let menu = formatMenu()
        for mask in 0..<(1 << SyntaxSet.allCases.count) {
            let sets = Set(SyntaxSet.allCases.enumerated()
                .filter { mask & (1 << $0.offset) != 0 }
                .map(\.element))
            AppMenu.applyState(MenuState(), syntaxSets: sets, to: menu)
            for container in [menu] + menu.items.compactMap(\.submenu) {
                let visible = container.items.filter { !$0.isHidden }
                XCTAssertFalse(visible.first?.isSeparatorItem ?? false,
                               "\(container.title) opens on a rule under \(sets)")
                XCTAssertFalse(visible.last?.isSeparatorItem ?? false,
                               "\(container.title) ends on a rule under \(sets)")
                for (a, b) in zip(visible, visible.dropFirst()) {
                    XCTAssertFalse(a.isSeparatorItem && b.isSeparatorItem,
                                   "\(container.title) draws two rules together under \(sets)")
                }
            }
        }
    }
}
