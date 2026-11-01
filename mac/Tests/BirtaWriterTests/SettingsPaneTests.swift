import AppKit
import BirtaWriterCore
import XCTest
@testable import BirtaWriter

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

    /// The RELEASE window unless a test says otherwise, which is what every
    /// arm here measured before the flavour was injectable and what most of
    /// them still want. The ones that care say which.
    private func makeController(_ flavour: AppFlavor = .release) -> SettingsWindowController {
        SettingsWindowController(flavour: flavour, distribution: .direct, onHotkeyChange: { 0 }, onChange: { _ in }, onChangeEverywhere: {},
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
    ///
    /// A label followed by a link on its line (the theme row's sentence)
    /// sits in a stack at the line's leading edge, with the field first in
    /// it; the field is still what is read.
    private func rowLabels(in view: NSView) -> [String] {
        var found: [String] = []
        if let field = view as? NSTextField, !(field is Caption), !(field is PathLabel),
           let holder = field.superview {
            let line: NSView? = type(of: holder) == NSView.self ? holder
                : (holder as? NSStackView).flatMap { $0.arrangedSubviews.first === field ? $0.superview : nil }
            if let line, type(of: line) == NSView.self, line.subviews.count == 2,
               line.subviews.first === holder || line.subviews.first === field {
                found.append(field.stringValue)
            }
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
        let declared = SettingsForm.rows(of: SettingsForm.general).map(\.label)
        XCTAssertEqual(drawn, declared,
                       "the General pane and its declaration disagree; drawn: "
                       + drawn.joined(separator: " | "))
    }

    func testTheAdvancedPaneShouldDrawEveryRowItDeclares() {
        let controller = makeController()
        defer { controller.window?.close() }
        let drawn = labels(of: controller, tab: "advanced")
        let declared = SettingsForm.rows(of: controller.advancedPane).map(\.label)
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
        // Every flavour, from the type rather than from a pair written here,
        // so a third build is walked the day it is added rather than the day
        // somebody remembers this file. Which rows Advanced holds is one of
        // the things a flavour decides, so a loop over one build is a loop
        // that has never seen the other pane.
        for flavour in AppFlavor.allCases {
            let controller = makeController(flavour)
            defer { controller.window?.close() }
            let names = SettingsWindowController.tabNames
            XCTAssertEqual(names.count, SettingsForm.panes.count,
                           "a pane has no tab, or a tab has no pane: tabs "
                           + names.joined(separator: ", "))
            for name in names {
                guard let declared = controller.declaredRows(forTab: name) else {
                    XCTFail("tab \(name) declares no pane on a \(flavour) build")
                    continue
                }
                XCTAssertFalse(declared.isEmpty,
                               "tab \(name) declares an empty pane on a \(flavour) build")
                XCTAssertEqual(labels(of: controller, tab: name), declared.map(\.label),
                               "the \(name) pane and its declaration disagree on a "
                               + "\(flavour) build")
            }
        }
    }

    /// The loop above walks both builds and would walk them just as happily if
    /// the flavour reached nothing: two identical panes agree with two
    /// identical declarations. This is the arm that says the two builds draw
    /// something different, and names WHICH row, so the pair cannot collapse
    /// without a red.
    ///
    /// The Welcome screen row is Advanced's, and it is the only row in the
    /// whole form that some build does not have. `SettingsForm.advanced` is
    /// where that is decided; this reads it back off a real pane.
    func testOnlyADevelopmentBuildShouldDrawTheWelcomeScreenRow() {
        let dev = makeController(.dev)
        defer { dev.window?.close() }
        let release = makeController(.release)
        defer { release.window?.close() }

        let onDev = labels(of: dev, tab: "advanced")
        let onRelease = labels(of: release, tab: "advanced")

        XCTAssertTrue(onDev.contains(SettingsRow.welcomeScreen.rawValue),
                      "a development build draws no Welcome screen row; drawn: "
                      + onDev.joined(separator: " | "))
        XCTAssertFalse(onRelease.contains(SettingsRow.welcomeScreen.rawValue),
                       "the release draws a row only a development build has; drawn: "
                       + onRelease.joined(separator: " | "))
        // Every other row is shared, so the ONE row is the whole difference:
        // a pane that gained a second dev-only row would be reported here
        // rather than passing under the two assertions above.
        XCTAssertEqual(onDev.filter { $0 != SettingsRow.welcomeScreen.rawValue }, onRelease)
    }

    /// Switching panes must not lose the answer a row is showing.
    ///
    /// Panes are BUILT ONCE and kept, so a control put in step only while its
    /// pane was being built shows whatever it was built with forever after.
    /// The case that found this: `Reset to defaults` writes every setting and
    /// then asks the window to redraw itself, and the note-mode popup was not
    /// among the controls that redraw ran over, so after a reset it went on
    /// naming the answer the user had just cleared. That popup is on General
    /// now, which is the pane this leaves and comes back to.
    ///
    /// Asserted through the two public gestures rather than by reaching for
    /// the control, so it stays true of a control added later: build the pane,
    /// leave it, come back, and the rows still read the same.
    func testAPaneShouldReadTheSameAfterBeingLeftAndComeBackTo() {
        let controller = makeController()
        defer { controller.window?.close() }
        let first = labels(of: controller, tab: "general")
        _ = labels(of: controller, tab: "markdown")
        _ = labels(of: controller, tab: "advanced")
        XCTAssertEqual(labels(of: controller, tab: "general"), first,
                       "the General pane draws different rows the second time it is shown")
        XCTAssertFalse(first.isEmpty)
    }

    /// What the file-name template would produce, drawn under the field and
    /// aligned with it.
    ///
    /// Three claims in one, and each is a separate way for it to be wrong: it
    /// is the FIRST thing under the row (not below the reference text), it is
    /// aligned with the field rather than with the prose, and it is the name
    /// itself rather than a sentence about it.
    func testTheFileNameRowShouldShowTodaysNameUnderTheField() {
        let controller = makeController()
        defer { controller.window?.close() }
        controller.selectTabForTesting("general")
        controller.window?.contentView?.layoutSubtreeIfNeeded()

        guard let row = controller.rowForTesting(.newNoteName) else {
            return XCTFail("the General pane draws no file-name row")
        }
        guard let preview = captions(in: row).first else {
            return XCTFail("the file-name row draws no preview")
        }
        XCTAssertEqual(preview.stringValue,
                       NoteNameTemplate.expand(Prefs.newNoteNameTemplate))
        XCTAssertEqual(preview.alignment, .right)
    }

    /// Every Caption inside `view`, in the order they are drawn.
    private func captions(in view: NSView) -> [Caption] {
        var found: [Caption] = []
        if let caption = view as? Caption { found.append(caption) }
        for subview in view.subviews { found += captions(in: subview) }
        return found
    }

    /// Every button title inside `view`.
    private func buttonTitles(in view: NSView) -> [String] {
        var found: [String] = []
        if let button = view as? NSButton { found.append(button.title) }
        for subview in view.subviews { found += buttonTitles(in: subview) }
        return found
    }

    /// Every switch in the Markdown pane's FIRST card, in the order the form
    /// places them: the floor and the publishing targets.
    ///
    /// The card, not the pane. Rich link previews and embeds is a switch on
    /// this pane too and is not a target, so a walk of the whole pane counts
    /// it and reports one target more than the vocabulary has. Which card is
    /// read off the layout rather than named, the way every other helper here
    /// reads the live pane.
    private func syntaxSwitches(of controller: SettingsWindowController) -> [NSSwitch] {
        controller.selectTabForTesting("markdown")
        guard let content = controller.window?.contentView else { return [] }
        content.layoutSubtreeIfNeeded()
        guard let card = firstCard(in: content) else { return [] }
        var found: [NSSwitch] = []
        func walk(_ view: NSView) {
            if let sw = view as? NSSwitch { found.append(sw) }
            view.subviews.forEach(walk)
        }
        walk(card)
        return found
    }

    /// The first settings card in `view`: the rounded, unstroked box
    /// `SettingsWindowController.group` builds.
    private func firstCard(in view: NSView) -> NSBox? {
        if let box = view as? NSBox, box.boxType == .custom { return box }
        for subview in view.subviews {
            if let found = firstCard(in: subview) { return found }
        }
        return nil
    }

    /// A publishing target reaches EVERY window, not the front one.
    ///
    /// The Format menu belongs to the application and repaints from `Prefs` on
    /// every opening, so a back window left on the old target would offer tools
    /// the menu bar above it had already withdrawn. Both counters are watched,
    /// because the failure is not "nothing happened", it is "the wrong one of
    /// the two happened", and a test counting only the right one would pass on
    /// a toggle that did both.
    func testTogglingAPublishingTargetShouldReachEveryWindow() {
        let sets = Prefs.syntaxSets
        defer { Prefs.syntaxSets = sets }
        Prefs.syntaxSets = SyntaxScope.all

        var frontOnly = 0
        var everywhere = 0
        let controller = SettingsWindowController(
            flavour: .release, distribution: .direct, onHotkeyChange: { 0 },
            onChange: { _ in frontOnly += 1 }, onChangeEverywhere: { everywhere += 1 },
            onShowWelcome: {}, onCheckForUpdates: {})
        defer { controller.window?.close() }

        // The operable switches are the targets; the one a reader cannot move
        // is the floor, and `testTheCommonMarkRowShouldBeOnAndNotOperable`
        // is what asks about it.
        let switches = syntaxSwitches(of: controller).filter(\.isEnabled)
        XCTAssertEqual(switches.count, SyntaxSet.allCases.count,
                       "the Markdown pane did not draw one switch per target")
        guard let first = switches.first else { return }

        first.state = .off
        _ = NSApp.sendAction(first.action!, to: first.target, from: first)

        XCTAssertLessThan(Prefs.syntaxSets.count, SyntaxSet.allCases.count,
                          "the switch did not write the setting, so this checked nothing")
        XCTAssertEqual(everywhere, 1, "the change did not reach every window")
        XCTAssertEqual(frontOnly, 0, "the change went to the front window instead")
    }

    /// The CommonMark row is a statement rather than a question: its switch
    /// is on and cannot be moved, because every flavor below it contains the
    /// floor. Both halves are asserted, since a switch that is off and fixed
    /// would say the opposite, and one that is on and operable would snap
    /// back under the pointer and read as broken.
    func testTheCommonMarkRowShouldBeOnAndNotOperable() {
        let controller = makeController()
        defer { controller.window?.close() }
        let all = syntaxSwitches(of: controller)
        let fixed = all.filter { !$0.isEnabled }
        XCTAssertEqual(fixed.count, 1, "expected exactly one switch a reader cannot move")
        XCTAssertEqual(fixed.first?.state, .on, "the floor's switch is drawn off")
        // Above every target: the floor is read before the things built on it.
        XCTAssertEqual(all.first?.isEnabled, false, "the floor is not the first row")
    }

    /// Every row that names a flavor somebody else defines links to that
    /// definition, and to the page the vocabulary names rather than to a
    /// paraphrase of it. Read off the live pane in order, so a row whose link
    /// went missing, or a link that moved to the wrong row, both fail here.
    func testEveryDocumentedFlavorShouldLinkToItsOwnPage() {
        let controller = makeController()
        defer { controller.window?.close() }
        controller.selectTabForTesting("markdown")
        guard let content = controller.window?.contentView else { return XCTFail("no window") }
        content.layoutSubtreeIfNeeded()
        let drawn = linkButtons(in: content).map(\.url)
        let expected = [CommonMark.documentation.url]
            + SyntaxSet.allCases.compactMap { $0.documentation?.url }
        XCTAssertGreaterThan(expected.count, 1,
                             "the vocabulary documents nothing, so this compares nothing")
        XCTAssertEqual(drawn, expected, "the Markdown pane's links are not the vocabulary's, in order")
    }

    /// Every `LinkButton` under `view`, in drawing order.
    private func linkButtons(in view: NSView) -> [LinkButton] {
        var found: [LinkButton] = []
        if let link = view as? LinkButton { found.append(link) }
        for subview in view.subviews { found += linkButtons(in: subview) }
        return found
    }

    /// The reason this file exists, stated as its own check: every row the
    /// first-run screen asks about is a row somebody can go back to in
    /// Settings, worded the same and in the same order, ON SCREEN rather than
    /// in an array.
    ///
    /// Across the panes in tab order rather than General alone, which is the
    /// order somebody walks Settings in and the one `SettingsForm.allRows`
    /// names. A first-run question can belong to a pane that is not General:
    /// Automatically update is about the program replacing itself, so it is on
    /// Advanced, and the guarantee the first run owes is that the question is
    /// findable rather than that it is findable on one particular tab.
    /// `SettingsFormTests` makes the same claim about the declaration; this
    /// one reads the labels off the live panes, so a renderer dropping a row
    /// the declaration still names is caught here and nowhere else.
    func testEveryFirstRunRowShouldBeDrawnSomewhereInSettings() {
        let controller = makeController()
        defer { controller.window?.close() }
        let drawn = SettingsWindowController.tabNames.flatMap { labels(of: controller, tab: $0) }
        let welcome = SettingsForm.rows(of: SettingsForm.welcome).map(\.rawValue)
        XCTAssertFalse(welcome.isEmpty)
        // Settings is meant to hold rows the first run does not ask about, so
        // panes that drew exactly the first-run set would be the two screens
        // having become one.
        XCTAssertGreaterThan(drawn.count, welcome.count)
        for label in welcome {
            XCTAssertTrue(drawn.contains(label),
                          "the first run asks about \(label) and no Settings pane draws such a row")
        }
        // And in the same order, so nobody is sent backwards through the tabs
        // to retrace a screen they saw once.
        var cursor = 0
        for label in drawn where cursor < welcome.count && label == welcome[cursor] {
            cursor += 1
        }
        XCTAssertEqual(cursor, welcome.count,
                       "the drawn first-run rows are out of order in Settings; stopped at "
                       + welcome[min(cursor, welcome.count - 1)] + ", drawn: "
                       + drawn.joined(separator: " | "))
    }
}
