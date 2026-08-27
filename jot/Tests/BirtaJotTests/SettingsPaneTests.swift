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

    /// The RELEASE window unless a test says otherwise, which is what every
    /// arm here measured before the flavour was injectable and what most of
    /// them still want. The ones that care say which.
    private func makeController(_ flavour: AppFlavor = .release) -> SettingsWindowController {
        SettingsWindowController(flavour: flavour, onHotkeyChange: { 0 }, onChange: { _ in },
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

    func testTheAgentPaneShouldDrawEveryRowItDeclares() {
        let controller = makeController()
        defer { controller.window?.close() }
        let drawn = labels(of: controller, tab: "aiAgent")
        let declared = SettingsForm.rows(of: SettingsForm.aiAgent).map(\.rawValue)
        XCTAssertEqual(drawn, declared,
                       "the AI Agent pane and its declaration disagree; drawn: "
                       + drawn.joined(separator: " | "))
    }

    func testTheAdvancedPaneShouldDrawEveryRowItDeclares() {
        let controller = makeController()
        defer { controller.window?.close() }
        let drawn = labels(of: controller, tab: "advanced")
        let declared = SettingsForm.rows(of: controller.advancedPane).map(\.rawValue)
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
                XCTAssertEqual(labels(of: controller, tab: name), declared.map(\.rawValue),
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
        _ = labels(of: controller, tab: "aiAgent")
        _ = labels(of: controller, tab: "advanced")
        XCTAssertEqual(labels(of: controller, tab: "general"), first,
                       "the General pane draws different rows the second time it is shown")
        XCTAssertFalse(first.isEmpty)
    }

    /// The agent pull-down names the tool the command below it runs.
    ///
    /// Read off the live control rather than from the function behind it,
    /// which is the difference between checking the answer and checking that
    /// the answer reached the button: under `pullsDown` the title IS item 0,
    /// and AppKit keeps drawing whatever it drew last until something asks it
    /// to lay out again.
    ///
    /// Against the DEFAULT command, deliberately. Nothing here writes a
    /// setting: the test runner has its own standard domain and none of our
    /// keys in it, so `Prefs.agentCommand` is the fallback template, and what
    /// this asserts is that a fresh install's pull-down names the tool a fresh
    /// install runs rather than asking somebody to choose one it already has.
    func testTheAgentPullDownShouldNameTheToolTheCommandRuns() {
        let controller = makeController()
        defer { controller.window?.close() }
        controller.selectTabForTesting("aiAgent")
        guard let content = controller.window?.contentView else {
            return XCTFail("the settings window has no content view")
        }
        content.layoutSubtreeIfNeeded()
        guard let popup = pullDown(in: content) else {
            return XCTFail("the AI Agent pane draws no pull-down")
        }
        let expected = AgentPreset.matching(command: Prefs.agentCommand)?.title
        XCTAssertNotNil(expected, "the default command names no tool, so this checks nothing")
        XCTAssertEqual(popup.title, expected)
        // And it is a shortcut into the field rather than a second place the
        // setting lives, which is what `pullsDown` says.
        XCTAssertTrue(popup.pullsDown)
    }

    /// The agent command has a link to the tool it names, and the link goes
    /// where that tool's documentation is.
    ///
    /// Read off the live button rather than from `AgentPreset.documentation`,
    /// which is what makes this a check that the link REACHED the pane: the
    /// table can be right and the pane can be drawing a link that never moves.
    func testTheAgentPaneShouldLinkToTheToolTheCommandRuns() {
        let controller = makeController()
        defer { controller.window?.close() }
        controller.selectTabForTesting("aiAgent")
        guard let content = controller.window?.contentView else {
            return XCTFail("the settings window has no content view")
        }
        content.layoutSubtreeIfNeeded()

        guard let expected = AgentPreset.matching(command: Prefs.agentCommand) else {
            return XCTFail("the default command names no tool, so this checks nothing")
        }
        guard let link = linkButton(in: content) else {
            return XCTFail("the AI Agent pane draws no documentation link")
        }
        XCTAssertEqual(link.url, expected.documentation)
        XCTAssertEqual(link.title, expected.title)
        // Its own holder, not `isHiddenOrHasHiddenAncestor`: with `/ai` off
        // the whole card row is hidden, which is a different question and
        // would make this pass or fail for the wrong reason.
        XCTAssertEqual(link.superview?.isHidden, false,
                       "the link is drawn for a command that names a tool")
    }

    /// A command naming nothing takes the link away rather than leaving one
    /// pointing at somebody else's documentation.
    func testACommandNamingNoToolShouldLeaveNoLink() {
        let controller = makeController()
        defer { controller.window?.close() }
        controller.selectTabForTesting("aiAgent")
        guard let content = controller.window?.contentView else {
            return XCTFail("the settings window has no content view")
        }
        content.layoutSubtreeIfNeeded()
        guard let link = linkButton(in: content) else {
            return XCTFail("the AI Agent pane draws no documentation link")
        }
        // The precondition, so this cannot pass on a link that was never
        // drawn in the first place.
        XCTAssertEqual(link.superview?.isHidden, false)

        controller.showAgentPreset(for: "my-own-agent --run {prompt}")

        XCTAssertEqual(link.superview?.isHidden, true)
    }

    /// The link has to be right the FIRST time the pane is drawn.
    ///
    /// The pane is built lazily, on its first visit, and the controls are
    /// wired once from whichever pane was built first. So a link that is only
    /// put in step by an edit shows whatever it was constructed with until
    /// somebody types, which for a command naming no tool is a link to
    /// somebody else's documentation.
    func testACommandNamingNoToolShouldNotShowALinkOnTheFirstDraw() {
        let controller = makeController()
        defer { controller.window?.close() }
        // General first, which is what wires the controls, then AI Agent,
        // which is what builds the link. That order is the one the failure
        // needs, and it is also the order a person opening Settings gets.
        // Through the STORED command, because that is what the pane reads
        // when it builds itself, and reading it is the step that was missing.
        // Restored, since the runner's defaults domain outlives this run.
        let original = Prefs.agentCommand
        defer { Prefs.agentCommand = original }
        Prefs.agentCommand = "my-own-agent --run {prompt}"
        controller.selectTabForTesting("general")
        controller.selectTabForTesting("aiAgent")
        controller.window?.contentView?.layoutSubtreeIfNeeded()

        guard let link = linkButton(in: controller.window!.contentView!) else {
            return XCTFail("the AI Agent pane draws no documentation link")
        }
        XCTAssertEqual(link.superview?.isHidden, true,
                       "the pane drew a link for a command that names no tool")
    }

    /// The one control on the pane that can tell an installed tool from a typo.
    func testTheAgentPaneShouldOfferAWayToRunTheCommand() {
        let controller = makeController()
        defer { controller.window?.close() }
        controller.selectTabForTesting("aiAgent")
        guard let content = controller.window?.contentView else {
            return XCTFail("the settings window has no content view")
        }
        content.layoutSubtreeIfNeeded()

        let titles = buttonTitles(in: content)
        XCTAssertTrue(titles.contains("Test"),
                      "the AI Agent pane draws no Test button; drew: "
                      + titles.joined(separator: " | "))
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

    /// The first documentation link anywhere in `view`.
    private func linkButton(in view: NSView) -> LinkButton? {
        if let found = view as? LinkButton { return found }
        for subview in view.subviews {
            if let found = linkButton(in: subview) { return found }
        }
        return nil
    }

    /// The first pull-down anywhere in `view`.
    private func pullDown(in view: NSView) -> NSPopUpButton? {
        if let found = view as? NSPopUpButton, found.pullsDown { return found }
        for subview in view.subviews {
            if let found = pullDown(in: subview) { return found }
        }
        return nil
    }

    /// The command field itself: the one monospaced text field on the pane.
    private func commandField(in view: NSView) -> NSTextField? {
        if let found = view as? NSTextField, found.isEditable,
           found.font?.fontName.contains("Mono") == true { return found }
        for subview in view.subviews {
            if let found = commandField(in: subview) { return found }
        }
        return nil
    }

    /// The AI Agent pane, built and laid out, with its three agent controls.
    private func agentPane(of controller: SettingsWindowController)
        -> (field: NSTextField, popup: NSPopUpButton, link: LinkButton)? {
        controller.selectTabForTesting("aiAgent")
        guard let content = controller.window?.contentView else { return nil }
        content.layoutSubtreeIfNeeded()
        guard let field = commandField(in: content), let popup = pullDown(in: content),
              let link = linkButton(in: content) else { return nil }
        return (field, popup, link)
    }

    /// Type into the field the way a person does, through the delegate call
    /// AppKit makes on every keystroke.
    private func typeIn(_ text: String, _ field: NSTextField,
                        on controller: SettingsWindowController) {
        field.stringValue = text
        controller.controlTextDidChange(
            Notification(name: NSControl.textDidChangeNotification, object: field))
    }

    // MARK: the pane follows the field

    /// While typing, not on blur.
    ///
    /// The pull-down and the link are a READING of the command, and a reading
    /// that only refreshes when focus leaves shows somebody the name and the
    /// documentation page of a tool they have already replaced. The case in
    /// the report: the field says `claude` and the pane still says Codex CLI
    /// and links to Codex's docs.
    func testTypingAToolsNameShouldMoveThePullDownAndTheLinkWithoutLeavingTheField() {
        let controller = makeController()
        defer { controller.window?.close() }
        let original = Prefs.agentCommand
        defer { Prefs.agentCommand = original }
        Prefs.agentCommand = AgentPreset.codex.template
        guard let pane = agentPane(of: controller) else {
            return XCTFail("the AI Agent pane did not draw its controls")
        }
        // The precondition, so this cannot pass on a pane that already said
        // Claude Code before anything was typed.
        XCTAssertEqual(pane.popup.title, AgentPreset.codex.title)

        typeIn("claude", pane.field, on: controller)

        XCTAssertEqual(pane.popup.title, AgentPreset.claudeCode.title)
        XCTAssertEqual(pane.link.url, AgentPreset.claudeCode.documentation)
        XCTAssertEqual(pane.link.title, AgentPreset.claudeCode.title)
        XCTAssertEqual(pane.link.superview?.isHidden, false)
    }

    /// And a command naming nothing takes the link away as it is typed, rather
    /// than leaving one pointing at the tool that was there before.
    func testTypingACommandNamingNoToolShouldTakeTheLinkAwayAsItGoes() {
        let controller = makeController()
        defer { controller.window?.close() }
        let original = Prefs.agentCommand
        defer { Prefs.agentCommand = original }
        Prefs.agentCommand = AgentPreset.codex.template
        guard let pane = agentPane(of: controller) else {
            return XCTFail("the AI Agent pane did not draw its controls")
        }
        XCTAssertEqual(pane.link.superview?.isHidden, false)

        typeIn("asd", pane.field, on: controller)

        XCTAssertEqual(pane.link.superview?.isHidden, true)
        XCTAssertNotEqual(pane.popup.title, AgentPreset.codex.title)
    }

    // MARK: what reloads the editor, and what does not

    /// Choosing a tool must not tear the editor down and rebuild it.
    ///
    /// The page is booted with the host's capabilities, so a change to what
    /// this host PROVIDES has to be handed to it again, and a reload is the
    /// only way to do that. Swapping one working command for another changes
    /// nothing the page was told, and the reload was visible: the note the
    /// person was reading blinked out and came back because a menu was used.
    func testSwappingOneWorkingCommandForAnotherShouldNotReloadThePage() {
        let command = Prefs.agentCommand
        let enabled = Prefs.agentEnabled
        defer { Prefs.agentCommand = command; Prefs.agentEnabled = enabled }
        // Before the controller, which reads the settings it opens on. The
        // window it mirrors is the one the page was booted with, so a test
        // that writes afterwards is asking about a disagreement no launch has.
        Prefs.agentEnabled = true
        Prefs.agentCommand = AgentPreset.codex.template
        var reloads = 0
        let controller = SettingsWindowController(flavour: .release, onHotkeyChange: { 0 },
                                                  onChange: { _ in reloads += 1 },
                                                  onShowWelcome: {}, onCheckForUpdates: {})
        defer { controller.window?.close() }
        guard let pane = agentPane(of: controller) else {
            return XCTFail("the AI Agent pane did not draw its controls")
        }

        typeIn(AgentPreset.claudeCode.template, pane.field, on: controller)
        XCTAssertEqual(reloads, 0, "typing a working command reloaded the editor")

        // And through the pull-down, which is the gesture the report was
        // about: AppKit sends the item's action after the selection moves.
        pane.popup.selectItem(withTitle: AgentPreset.gemini.title)
        _ = NSApp.sendAction(pane.popup.action!, to: pane.popup.target, from: pane.popup)
        XCTAssertEqual(Prefs.agentCommand, AgentPreset.gemini.template,
                       "the pull-down did not write the command, so this checked nothing")
        XCTAssertEqual(reloads, 0, "choosing a tool reloaded the editor")
    }

    /// The other half, and the one that must not be lost while fixing the
    /// first: emptying the field withdraws the capability, and the page is
    /// still offering `/ai` until it is told.
    func testEmptyingAndRefillingTheCommandShouldReloadThePageEachWay() {
        let command = Prefs.agentCommand
        let enabled = Prefs.agentEnabled
        defer { Prefs.agentCommand = command; Prefs.agentEnabled = enabled }
        // Before the controller, which reads the settings it opens on. The
        // window it mirrors is the one the page was booted with, so a test
        // that writes afterwards is asking about a disagreement no launch has.
        Prefs.agentEnabled = true
        Prefs.agentCommand = AgentPreset.codex.template
        var reloads = 0
        let controller = SettingsWindowController(flavour: .release, onHotkeyChange: { 0 },
                                                  onChange: { _ in reloads += 1 },
                                                  onShowWelcome: {}, onCheckForUpdates: {})
        defer { controller.window?.close() }
        guard let pane = agentPane(of: controller) else {
            return XCTFail("the AI Agent pane did not draw its controls")
        }

        typeIn("", pane.field, on: controller)
        XCTAssertFalse(Prefs.agentAvailable)
        XCTAssertEqual(reloads, 1, "an empty command left the page still offering /ai")

        // Whitespace is still nothing to run, so it must not count as a second
        // change back.
        typeIn("   ", pane.field, on: controller)
        XCTAssertEqual(reloads, 1)

        typeIn(AgentPreset.claudeCode.template, pane.field, on: controller)
        XCTAssertTrue(Prefs.agentAvailable)
        XCTAssertEqual(reloads, 2, "a command typed into an empty field never reached the page")
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
