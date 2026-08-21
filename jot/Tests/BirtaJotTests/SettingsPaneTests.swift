import AppKit
import BirtaJotCore
import XCTest
@testable import BirtaJot

/// The drawing half of the settings invariant.
///
/// `SettingsFormTests` compares two declarations and cannot see a renderer:
/// with `SettingsWindowController.render` filtering a row out of the group it
/// builds, that file still passes and the row is simply not on screen. This
/// builds the real controller, lets it build a real pane, and reads the labels
/// back off the live view hierarchy, so what is asserted is what a person
/// would find in the window.
///
/// Nothing is shown. The window is built, laid out, read and closed, and is
/// never ordered on screen, so this runs unattended beside every other test.
/// It is not a claim to run without a window server: the process holds a
/// connection to one and AppKit allocates a real window number. What it does
/// not do is put anything in front of anybody.
@MainActor
final class SettingsPaneTests: XCTestCase {
    override func setUp() {
        super.setUp()
        // AppKit wants its application object to exist before a window does.
        // Accessing it is enough; nothing is run and nothing is activated.
        _ = NSApplication.shared
    }

    private func makeController() -> SettingsWindowController {
        SettingsWindowController(onHotkeyChange: { 0 }, onChange: {},
                                 onShowWelcome: {}, onCheckForUpdates: {})
    }

    /// The labels of the ROWS on screen, top to bottom.
    ///
    /// A row is drawn as a plain `NSView` holding exactly its label and its
    /// control, which is what tells a row label apart from the other text on a
    /// pane: a group heading is a bare field in the pane's stack, a caption is
    /// alone in its holder, and the Location row's path is an `NSTextField` of
    /// its own inside an `NSStackView` beside the Choose button.
    ///
    /// Hidden rows are read too. Whether the Location row is on screen depends
    /// on iCloud Drive being switched on for whoever is running this, and the
    /// claim here is that the pane DRAWS every declared row, not which ones an
    /// answer above them is currently taking away.
    private func rowLabels(in view: NSView) -> [String] {
        var found: [String] = []
        if let field = view as? NSTextField, !(field is Caption), !(field is PathLabel),
           let line = field.superview, type(of: line) == NSView.self,
           line.subviews.count == 2, line.subviews.first === field {
            found.append(field.stringValue)
        }
        for subview in view.subviews { found += rowLabels(in: subview) }
        return found
    }

    private func labels(of controller: SettingsWindowController, tab: String) -> [String] {
        controller.selectTabForTesting(tab)
        guard let content = controller.window?.contentView else {
            XCTFail("the settings window has no content view")
            return []
        }
        content.layoutSubtreeIfNeeded()
        return rowLabels(in: content)
    }

    func testTheGeneralPaneShouldDrawEveryRowItDeclares() {
        let controller = makeController()
        defer { controller.window?.close() }
        let drawn = labels(of: controller, tab: "general")
        let declared = SettingsForm.rows(of: SettingsForm.general).map(\.rawValue)
        XCTAssertEqual(drawn, declared,
                       "the General pane and its declaration disagree; drawn: "
                       + drawn.joined(separator: " | "))
    }

    func testTheEditorPaneShouldDrawEveryRowItDeclares() {
        let controller = makeController()
        defer { controller.window?.close() }
        let drawn = labels(of: controller, tab: "editor")
        let declared = SettingsForm.rows(of: SettingsForm.editor).map(\.rawValue)
        XCTAssertEqual(drawn, declared,
                       "the Editor pane and its declaration disagree; drawn: "
                       + drawn.joined(separator: " | "))
    }

    func testTheAdvancedPaneShouldDrawEveryRowItDeclares() {
        let controller = makeController()
        defer { controller.window?.close() }
        let drawn = labels(of: controller, tab: "advanced")
        let declared = SettingsForm.rows(of: SettingsForm.advanced).map(\.rawValue)
        XCTAssertEqual(drawn, declared,
                       "the Advanced pane and its declaration disagree; drawn: "
                       + drawn.joined(separator: " | "))
    }

    /// The three arms above name their panes by hand, which is the shape that
    /// let an Editor pane be added with nothing checking it. This one is
    /// derived from the tab list instead, so a FOURTH pane is covered the day
    /// it lands rather than the day somebody remembers to write its arm.
    ///
    /// Both directions matter and neither is visible from one side: a tab with
    /// no declared pane draws an empty window, and a declared pane no tab
    /// reaches is rows nobody can get to.
    func testEveryTabShouldDrawExactlyTheRowsItsPaneDeclares() {
        let controller = makeController()
        defer { controller.window?.close() }
        let names = SettingsWindowController.tabNames
        XCTAssertEqual(names.count, SettingsForm.panes.count,
                       "a pane has no tab, or a tab has no pane: tabs "
                       + names.joined(separator: ", "))
        for name in names {
            guard let declared = SettingsWindowController.declaredRows(forTab: name) else {
                XCTFail("tab \(name) declares no pane")
                continue
            }
            XCTAssertFalse(declared.isEmpty, "tab \(name) declares an empty pane")
            XCTAssertEqual(labels(of: controller, tab: name), declared.map(\.rawValue),
                           "the \(name) pane and its declaration disagree")
        }
    }

    /// The reason this file exists, stated as its own check: every row the
    /// first-run screen asks about is a row somebody can go back to in
    /// Settings, worded the same, ON SCREEN rather than in an array.
    func testEveryFirstRunRowShouldBeDrawnInTheGeneralPane() {
        let controller = makeController()
        defer { controller.window?.close() }
        let drawn = Set(labels(of: controller, tab: "general"))
        let welcome = SettingsForm.rows(of: SettingsForm.welcome).map(\.rawValue)
        XCTAssertFalse(welcome.isEmpty)
        // General is meant to hold rows the first run does not ask about, so a
        // pane that drew exactly the first-run set would be the two screens
        // having become one. `SettingsFormTests` makes the same claim about
        // the declaration; this one is about the pane.
        XCTAssertGreaterThan(drawn.count, welcome.count)
        for label in welcome {
            XCTAssertTrue(drawn.contains(label),
                          "the first run asks about \(label) and the General pane draws no such row")
        }
    }
}
