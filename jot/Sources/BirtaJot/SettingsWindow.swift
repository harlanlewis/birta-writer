import AppKit
import BirtaJotCore

/// Jot's Settings window.
///
/// Built to the shape macOS settings windows have: a preference toolbar of
/// tabs across the top (which is what centres the title, `toolbarStyle =
/// .preference` doing the work), one pane at a time, each pane a stack of
/// rounded groups of rows, under an opening paragraph where the pane needs
/// one.
///
/// Panes rather than one long column because the list outgrew a column: a
/// window that scrolls past its own title is a form, and a reader looking for
/// one switch should not have to pass nine others.
///
/// A caption is the exception, not the rule. A row whose label already says
/// what it does gets none; the ones that remain either warn (login is blocked)
/// or name something the label cannot (what `{prompt}` means).
///
/// Everything is built in code. A window this size does not earn a nib, and a
/// nib is the one part of the app a script cannot diff.
@MainActor
final class SettingsWindowController: NSWindowController, NSWindowDelegate, NSTextFieldDelegate, NSToolbarDelegate {
    /// The window's one width, and the insets every row shares. A caption has
    /// to be told the width it wraps at before the first layout pass, or the
    /// window sizes itself around a one-line caption and clips the rest.
    enum Metrics {
        static let content: CGFloat = 480
        static let rowInset: CGFloat = 14
        static let windowPadding: CGFloat = 20
        /// Past this the pane scrolls rather than growing the window off the
        /// screen.
        ///
        /// Raised when General absorbed the first-run questions, and again
        /// when it took the note-mode card off the middle pane. Two things
        /// about the number are worth knowing before touching it again.
        ///
        /// It has to fit the TALLEST General rather than the one in front of
        /// you, and how tall that is depends on the machine: with iCloud Drive
        /// switched off, the Location row and its caption are both on screen,
        /// which is roughly sixty points this Mac does not show while iCloud
        /// is on. That difference is why the old ceiling passed locally and
        /// failed on a runner, and `pnpm test` cannot tell you which arm you
        /// are measuring.
        ///
        /// And it is not the real limit: `fitWindowToPane` takes the smaller
        /// of this and the screen, so a display that cannot show this much
        /// scrolls anyway. What this number decides is the point at which
        /// scrolling is preferable to a taller window, on a screen with room
        /// for either.
        static let maxPaneHeight: CGFloat = 740
        static var captionWidth: CGFloat { content - rowInset * 2 }
    }

    /// The panes, in toolbar order.
    ///
    /// Three, and the middle one names its subject rather than a place: a tab
    /// costs a click to discover what is on it, so it has to be worth the
    /// click. An Editor pane existed, was removed when its only row was
    /// Autosave, and came back holding three unrelated rows and an agent. The
    /// rows that were not about the agent have gone to General, and what is
    /// left is one subject, which is what the tab is now called.
    ///
    /// The split is by WHAT the rows are about. General is Jot as an
    /// application on this Mac: how you reach it, where it puts your bytes,
    /// which note a summon opens, and how it behaves at login and on the
    /// network. AI Agent is the command `/ai` hands a prompt to. Advanced is
    /// the gestures that undo rather than set. Autosave is in General under
    /// the argument that removed the middle pane the first time: it is about
    /// when your bytes reach disk, not about what the editor does with them.
    ///
    /// Which rows are on which pane is `SettingsForm`'s and not this enum's.
    private enum Tab: String, CaseIterable {
        case general, aiAgent, advanced

        var title: String {
            switch self {
            case .general: return "General"
            case .aiAgent: return "AI Agent"
            case .advanced: return "Advanced"
            }
        }

        var symbol: String {
            switch self {
            case .general: return "gearshape"
            // Not a robot and not a brain: the pane is about handing a request
            // to something that answers, which is what this glyph is for
            // everywhere else on the system.
            case .aiAgent: return "sparkles"
            case .advanced: return "wrench.and.screwdriver"
            }
        }
    }

    /// The rows on screen, by the row they are, so availability reaches the
    /// label and the caption together (`SettingsRowView.apply`). Rebuilt with
    /// each pane; a pane is built once and kept, so an entry is live for as
    /// long as the window is.
    private var rowViews: [SettingsRow: SettingsRowView] = [:]

    private let scrollView = NSScrollView()
    /// Built on first visit and kept, so switching back does not rebuild the
    /// controls and lose the state they are showing.
    private var panes: [Tab: NSView] = [:]

    private let hotkeyRecorder = HotkeyRecorderView(combo: Prefs.hotkey)
    private let hotkeyCaption = Caption("")
    private let scratchpadPath = PathLabel(Prefs.scratchpadURL)
    private let networkSwitch = NSSwitch()
    private let agentField = NSTextField(string: Prefs.agentCommand)
    /// A PULL-DOWN rather than a popup, which is what keeps it from claiming
    /// to be the setting: choosing an entry writes the field below and is then
    /// done with, and the field is what `/ai` runs whatever it says a moment
    /// later.
    ///
    /// Shut, it names the tool the command is RUNNING rather than the last
    /// entry anybody picked, which is a different claim and a checkable one:
    /// it is read back out of the field, by program name alone
    /// (`AgentPreset.matching`), so an edited flag cannot make it lie and a
    /// command of somebody's own puts it back to asking.
    private let agentPresetPopup = NSPopUpButton()
    /// Runs the command once with a trivial prompt and shows what came back.
    /// A command is a shell line somebody typed, and until it has been run
    /// nothing on this pane can tell an installed tool from a typo.
    private let agentTestButton = NSButton(title: "Test", target: nil, action: nil)
    /// The selected tool's own documentation, under the command field.
    ///
    /// One button that MOVES rather than a link per preset: what it points at
    /// is read back out of the command (`AgentPreset.matching`), so it names
    /// the tool being run rather than the last entry anybody picked, and a
    /// command this build does not recognise leaves nothing to link to.
    private let agentDocLink = LinkButton(title: AgentPreset.fallback.title,
                                          url: AgentPreset.fallback.documentation)
    /// What the row's stack is arranging, so the link can be taken out of the
    /// layout entirely rather than left as a blank line.
    private var agentDocLinkHolder: NSView?
    private let agentEnabledSwitch = NSSwitch()
    private let newNoteField = NSTextField(string: Prefs.newNoteNameTemplate)
    private let dockSwitch = NSSwitch()
    private let autosaveSwitch = NSSwitch()
    /// The two questions the file settings ask: what a summon opens, and where
    /// notes live. Popups rather than switches because neither is a yes or a
    /// no: one has two named answers and the other has three, and the third
    /// (a folder you pick) used to be a path row that silently outranked the
    /// switch above it.
    private let opensPopup = NSPopUpButton()
    private let iCloudSwitch = NSSwitch()
    private let iCloudCaption = Caption("")
    private let networkCaption = Caption("")
    /// The cards holding a row that comes and goes with the answer above it.
    /// Kept because hiding a row means reaching back into the card that drew
    /// it: Location under Store in iCloud Drive, File name under New windows
    /// open with, and the agent command under the switch that enables it.
    private var filesGroup: NSView?
    private var notesGroup: NSView?
    private var agentGroup: NSView?
    private let newNoteCaption = Caption("")
    private let updateSwitch = NSSwitch()
    private let updateCaption = Caption("")
    private let updateButton = NSButton(title: "Check Now", target: nil, action: nil)
    private let resetButton = NSButton(title: "Reset to defaults", target: nil, action: nil)
    private let welcomeButton = NSButton(title: "Show Welcome", target: nil, action: nil)
    private let loginSwitch = NSSwitch()
    private let loginCaption = Caption(LoginItemState.off.caption)
    private let loginSettingsButton = NSButton(title: "Open System Settings…", target: nil, action: nil)

    /// A runner of this window's own, for the Test button and nothing else.
    ///
    /// Not the Coordinator's. A probe is not a `/ai` run: it is not registered
    /// as one, cannot be cancelled from the panel, and never reaches the note,
    /// so sharing the object that tracks live runs would only give this a way
    /// to interfere with them.
    private let agentProbe = AgentRunner()

    private let onHotkeyChange: () -> OSStatus
    private let onChange: () -> Void
    /// Show the welcome window. Injected rather than built here: the window is
    /// the app delegate's, so it survives this one being closed.
    private let onShowWelcome: () -> Void
    /// Ask for an update check now. The Updater is the app delegate's, so it
    /// outlives this window.
    private let onCheckForUpdates: () -> Void

    init(onHotkeyChange: @escaping () -> OSStatus,
         onChange: @escaping () -> Void,
         onShowWelcome: @escaping () -> Void,
         onCheckForUpdates: @escaping () -> Void) {
        self.onHotkeyChange = onHotkeyChange
        self.onChange = onChange
        self.onShowWelcome = onShowWelcome
        self.onCheckForUpdates = onCheckForUpdates
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: Metrics.content + Metrics.windowPadding * 2, height: 300),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        // The app's name, not the pane's. A multi-pane settings window titles
        // itself after the selected pane, and that rule assumes the app is
        // named somewhere else on screen; Jot is an accessory app with no Dock
        // icon, so "General" alone belongs to nothing the user can see. The
        // toolbar below the title already names and highlights the pane.
        window.title = "\(AppFlavor.current.displayName) Settings"
        // No `window.level` here, and that absence is the point. This window
        // used to be raised to `.floating` to match a panel that could float,
        // because an ordinary-level window opened BEHIND the one it was opened
        // from. The panel is at the ordinary level in every case now, so there
        // is nothing left to match and a settings window pinned over every
        // other application would be a bug rather than a setting.
        super.init(window: window)
        window.delegate = self

        let toolbar = NSToolbar(identifier: "BirtaJotSettings")
        toolbar.delegate = self
        toolbar.displayMode = .iconAndLabel
        toolbar.allowsUserCustomization = false
        window.toolbar = toolbar
        // The whole reason for the toolbar: `.preference` is what draws tabs
        // in the titlebar and centres the title above them, which is the shape
        // every other settings window on the machine has.
        window.toolbarStyle = .preference

        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.autohidesScrollers = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        let container = BackgroundView()
        container.addSubview(scrollView)
        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: container.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
        window.contentView = container

        toolbar.selectedItemIdentifier = NSToolbarItem.Identifier(Tab.general.rawValue)
        show(.general)
        window.center()
    }

    /// Put `tab` on screen and size the window to it, the way a settings
    /// window does: the window is as tall as the pane needs, up to a ceiling
    /// past which the pane scrolls instead.
    private func show(_ tab: Tab) {
        // The window is `fitWindowToPane`'s to find; this only needs the pane.
        let pane = panes[tab] ?? {
            let built = buildPane(tab)
            panes[tab] = built
            return built
        }()
        scrollView.documentView = pane
        // Re-pinned on every show, which is correct rather than wasteful:
        // setting `documentView` takes the previous pane out of the view
        // hierarchy, and AppKit drops the constraints that referenced it, so a
        // pane pinned only when it was built comes back unpinned. Measured:
        // after cycling every pane twice, the scroll view holds three
        // constraints, the ones for the pane actually on screen.
        pane.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            pane.topAnchor.constraint(equalTo: scrollView.contentView.topAnchor),
            pane.leadingAnchor.constraint(equalTo: scrollView.contentView.leadingAnchor),
            pane.trailingAnchor.constraint(equalTo: scrollView.contentView.trailingAnchor),
        ])
        shown = tab
        fitWindowToPane()
    }

    /// Which pane is on screen, so `fitWindowToPane` knows what to measure.
    private var shown: Tab?

    /// Size the window to the pane on screen.
    ///
    /// Separate from `show` because a pane's height is not fixed once it is
    /// built: a row that comes and goes with the answer above it (Location,
    /// under Store in iCloud Drive) changes what the pane needs while somebody
    /// is looking at it. Without this the window keeps the height it was first
    /// sized to and a scroller appears over two rows of settings, which reads
    /// as a pane too big for its window rather than a window that did not
    /// follow.
    ///
    /// The ceiling is the smaller of `maxPaneHeight` and the screen.
    /// `maxPaneHeight` is what a pane may take before scrolling is the lesser
    /// evil; a display that cannot show even that is the only case where the
    /// scroller earns its keep.
    private func fitWindowToPane() {
        // Nothing while a pane is being built. `buildPane` puts its rows in
        // step as it goes, and those calls end here, but the pane being built
        // is not in `panes` yet and `shown` still names the previous one: the
        // window would be resized to the pane being left, and then resized
        // again a moment later by the `show` that asked for the build. Harmless
        // to look at and wrong to leave, because it is a measurement of the
        // wrong subject that happens to be corrected by the next line.
        guard !building else { return }
        guard let window, let pane = shown.flatMap({ panes[$0] }) else { return }
        pane.layoutSubtreeIfNeeded()
        let screenHeight = (window.screen ?? NSScreen.main)?.visibleFrame.height ?? Metrics.maxPaneHeight
        let wanted = min(pane.fittingSize.height, Metrics.maxPaneHeight, screenHeight)
        let frame = window.frameRect(forContentRect: NSRect(
            x: 0, y: 0, width: Metrics.content + Metrics.windowPadding * 2, height: wanted))
        guard abs(frame.height - window.frame.height) > 0.5 else { return }
        // Traced because the failure is a window that simply does not follow,
        // which looks like a pane too tall rather than a resize that did not
        // happen. `jot/scripts/measure.sh` reads it.
        //
        // `content` and `pane` are the pair worth comparing, and `to` is not:
        // a frame height carries the titlebar and the toolbar as well, so a
        // window whose CONTENT is shorter than its pane still reads as taller
        // than it by that much. `content` is what the pane is given, capped at
        // `cap`; `pane` is what it asked for.
        if ProcessInfo.processInfo.environment["BIRTA_JOT_MEASURE"] == "1" {
            FileHandle.standardError.write(Data(
                ("jot-trace settingsfit from=\(Int(window.frame.height)) to=\(Int(frame.height))"
                 + " content=\(Int(wanted)) pane=\(Int(pane.fittingSize.height))"
                 + " cap=\(Int(min(Metrics.maxPaneHeight, screenHeight)))\n").utf8))
        }
        var target = window.frame
        // Grow downward from the title bar, which is where a settings window
        // grows: the top edge is what the eye is anchored to.
        target.origin.y += target.height - frame.height
        target.size = frame.size
        // Never animated. A settings window that slides between two heights
        // draws the eye to the chrome moving rather than to the pane that
        // arrived, and it does it on every tab click, which is the gesture
        // somebody makes most. The window is simply the size of what it is
        // showing, at the moment it is showing it.
        window.setFrame(target, display: true)
    }

    // MARK: toolbar

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        Tab.allCases.map { NSToolbarItem.Identifier($0.rawValue) }
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarAllowedItemIdentifiers(toolbar)
    }

    /// The selectable set IS the whole set: every item is a pane, and a
    /// preference toolbar with no selectable items draws tabs that never
    /// highlight.
    func toolbarSelectableItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarAllowedItemIdentifiers(toolbar)
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        guard let tab = Tab(rawValue: identifier.rawValue) else { return nil }
        let item = NSToolbarItem(itemIdentifier: identifier)
        item.label = tab.title
        item.paletteLabel = tab.title
        item.image = NSImage(systemSymbolName: tab.symbol, accessibilityDescription: tab.title)
        item.target = self
        item.action = #selector(selectTab(_:))
        return item
    }

    /// Every pane's name, in toolbar order.
    ///
    /// Exposed because `Tab` is private and the thing worth checking is the
    /// CORRESPONDENCE: a tab with no declared pane draws an empty window, and
    /// a declared pane with no tab is rows nothing shows. Neither is visible
    /// from either side alone.
    static var tabNames: [String] { Tab.allCases.map(\.rawValue) }

    /// The rows a pane declares, by that same name. Paired with `tabNames` so
    /// a test can walk the panes without knowing which array is which.
    static func declaredRows(forTab name: String) -> [SettingsRow]? {
        guard let tab = Tab(rawValue: name) else { return nil }
        switch tab {
        case .general: return SettingsForm.rows(of: SettingsForm.general)
        case .aiAgent: return SettingsForm.rows(of: SettingsForm.aiAgent)
        case .advanced: return SettingsForm.rows(of: SettingsForm.advanced)
        }
    }

    /// One row of the pane on screen, so a check can read back the label and
    /// the caption availability was applied to rather than assert against the
    /// rule that produced it.
    ///
    /// The thing worth checking here is the WIRING: `RowAvailability` is
    /// checkable on its own, and what it cannot tell you is whether the pane
    /// ever hands a row its answer.
    func rowForTesting(_ row: SettingsRow) -> SettingsRowView? { rowViews[row] }

    /// Show a pane by name, for `BIRTA_JOT_OPEN_SETTINGS`. Unknown names are
    /// ignored rather than fatal: the variable is a probe, and a typo in it
    /// should not stop the app.
    func selectTabForTesting(_ name: String) {
        guard let tab = Tab(rawValue: name) else { return }
        window?.toolbar?.selectedItemIdentifier = NSToolbarItem.Identifier(tab.rawValue)
        show(tab)
    }

    /// Show every row an answer above it can take away, and every caption that
    /// only some machines see.
    ///
    /// So a height check measures the TALLEST a pane gets rather than the one
    /// this Mac happens to draw. Which rows are on screen depends on the
    /// machine: with iCloud Drive switched off, General carries the Location
    /// row and a caption saying so, which is roughly sixty points a Mac with
    /// iCloud on never shows. That is not a corner case, it is half the
    /// machines, and it is why a ceiling that fits here can fail on a runner
    /// with the suite green both times.
    ///
    /// Deliberately one-way: it only reveals. Putting the rows back is what
    /// `showFiles`, `showAgent` and `showNoteMode` do from the real settings,
    /// so nothing here has to remember a previous state.
    func showEveryConditionalRowForTesting() {
        let cards: [(NSView?, SettingsRow, SettingsPane)] = [
            (filesGroup, .location, SettingsForm.general),
            (notesGroup, .newNoteName, SettingsForm.general),
            (agentGroup, .agentCommand, SettingsForm.aiAgent),
        ]
        for (card, row, pane) in cards {
            guard let card, let index = SettingsForm.index(of: row, inPane: pane) else { continue }
            Self.setRowHidden(card, row: index, hidden: false)
        }
        // The captions that only appear on some machines, said here so the
        // measurement carries their height too.
        iCloudCaption.say("iCloud Drive is off in System Settings, so notes stay on this Mac.", bad: false)
        rowViews[.startAtLogin]?.apply(.startAtLogin(.blocked))
        fitWindowToPane()
    }

    /// Move the iCloud switch the way a click does, for `BIRTA_JOT_TOGGLE_ICLOUD`.
    ///
    /// The Location row under it comes and goes with this answer, which is the
    /// one thing that changes a pane's height after it is built. Without a way
    /// to drive it, a check on the window following its pane can only ever see
    /// the FIRST sizing, which happens whether or not the following works.
    func toggleICloudForTesting() {
        // Traced either way. The switch is disabled when iCloud Drive is off
        // in System Settings, which is a fact about the machine running the
        // check and not about the product; without this line the arm reads a
        // missing second resize and blames the window for not following.
        if ProcessInfo.processInfo.environment["BIRTA_JOT_MEASURE"] == "1" {
            FileHandle.standardError.write(Data(
                "jot-trace icloudtoggle available=\(iCloudSwitch.isEnabled ? 1 : 0)\n".utf8))
        }
        guard iCloudSwitch.isEnabled, let action = iCloudSwitch.action else { return }
        iCloudSwitch.state = iCloudSwitch.state == .on ? .off : .on
        NSApp.sendAction(action, to: iCloudSwitch.target, from: iCloudSwitch)
    }

    @objc private func selectTab(_ sender: NSToolbarItem) {
        guard let tab = Tab(rawValue: sender.itemIdentifier.rawValue) else { return }
        show(tab)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: content

    /// Wire every control once, whichever pane ends up holding it.
    private func wireControls() {
        hotkeyRecorder.onCombo = { [weak self] combo in self?.hotkeyChosen(combo) }

        // Titles come from the types, so a case added to `NoteMode` or
        // `AgentPreset` appears here without this file being edited. The
        // menu's own order is the type's declaration order.
        opensPopup.removeAllItems()
        opensPopup.addItems(withTitles: NoteMode.allCases.map(\.title))
        opensPopup.controlSize = .small
        opensPopup.target = self
        opensPopup.action = #selector(chooseNoteMode)

        // Item 0 is the button's own title under `pullsDown`, never an answer,
        // which is why the presets start at 1.
        agentPresetPopup.pullsDown = true
        agentPresetPopup.removeAllItems()
        agentPresetPopup.addItems(withTitles: [Self.presetMenuPrompt] + AgentPreset.allCases.map(\.title))
        agentPresetPopup.controlSize = .small
        agentPresetPopup.target = self
        agentPresetPopup.action = #selector(chooseAgentPreset)

        updateButton.target = self
        updateButton.action = #selector(checkForUpdatesNow)
        updateButton.controlSize = .small
        agentTestButton.target = self
        agentTestButton.action = #selector(testAgentCommand)
        agentTestButton.controlSize = .small
        resetButton.target = self
        resetButton.action = #selector(resetAllSettings)
        resetButton.controlSize = .small
        welcomeButton.target = self
        welcomeButton.action = #selector(showWelcomeAgain)
        welcomeButton.controlSize = .small

        agentField.placeholderString = "claude -p {prompt}"
        agentField.delegate = self
        agentField.font = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        // No width constraint: this one is the full width of its card, under
        // the row rather than beside it. A command is long, monospaced and
        // edited character by character, and 260pt of it is a slot to squint
        // at rather than a field to work in.

        newNoteField.delegate = self
        newNoteField.font = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        newNoteField.placeholderString = NoteNameTemplate.default
        newNoteField.alignment = .right
        newNoteField.widthAnchor.constraint(equalToConstant: 200).isActive = true
        // Aligned with the field it answers rather than with the prose, so the
        // template and the name it produces sit in one column.
        newNoteCaption.alignment = .right

        loginSettingsButton.target = self
        loginSettingsButton.action = #selector(openLoginItemSettings)
        loginSettingsButton.controlSize = .small

        for (control, on, action) in [
            (networkSwitch, Prefs.networkEnabled, #selector(toggleNetwork)),
            (iCloudSwitch, Prefs.noteHome == .iCloud, #selector(toggleICloud)),
            (updateSwitch, Prefs.autoUpdate, #selector(toggleAutoUpdate)),
            (agentEnabledSwitch, Prefs.agentEnabled, #selector(toggleAgentEnabled)),
            (autosaveSwitch, Prefs.autosave, #selector(toggleAutosave)),
            (dockSwitch, Prefs.showInDock, #selector(toggleShowInDock)),
            (loginSwitch, false, #selector(toggleLoginItem)),
        ] {
            // The size a settings row uses. A regular NSSwitch is drawn for a
            // control that is the point of its own view; in a list of rows it
            // is the loudest thing on the pane. `SettingsSwitchTests` pins
            // that the system still draws `.small` smaller, and holds the trap
            // in checking it: a switch reports the regular size until it has
            // been laid out in a view hierarchy.
            control.controlSize = .small
            control.state = on ? .on : .off
            control.target = self
            control.action = action
        }
        syncControlsFromPrefs()
    }

    /// Put every control back in step with what is stored.
    ///
    /// Extracted because `wireControls` runs exactly once, from the first
    /// `buildPane`, so before this existed there was NO way to redraw a pane
    /// from `Prefs`. That is fine while the only writer is the control itself
    /// and fatal the moment something changes several settings at once, which
    /// is exactly what Reset does: without this the pane would go on showing
    /// the values it was built with while the app ran on the defaults.
    private func syncControlsFromPrefs() {
        networkSwitch.state = Prefs.networkEnabled ? .on : .off
        // Not `showAutoUpdate` and `showLoginItem` here: both draw through
        // `rowViews`, so they are `showRowAvailability`'s and are called again
        // once the pane exists. What stays here is the switch positions, which
        // are properties and are safe to set before anything is laid out.
        networkCaption.say("Renders some YouTube, Loom, Figma, Google Docs, and links from "
                           + "other services as interactive embedded content. Requires internet "
                           + "access.", bad: false)
        autosaveSwitch.state = Prefs.autosave ? .on : .off
        dockSwitch.state = Prefs.showInDock ? .on : .off
        hotkeyRecorder.setCombo(Prefs.hotkey)
        agentField.stringValue = Prefs.agentCommand
        newNoteField.stringValue = Prefs.newNoteNameTemplate
        agentEnabledSwitch.state = Prefs.agentEnabled ? .on : .off
        showAgentPreset()
        showAgent()
        showRowAvailability()
        showNoteMode()
        showNoteNamePreview()
        showFiles()
    }

    /// The rows whose availability is a fact about the build or the system
    /// rather than a stored setting.
    ///
    /// Together, because they are the two rows that can be dead, and both draw
    /// through `rowViews`: what they set is a label's ink and a sentence, so
    /// they can only run once the pane holding those views exists.
    private func showRowAvailability() {
        showAutoUpdate()
        showLoginItem(LoginItem.state)
    }

    /// The agent command exists only when the switch above it is on.
    ///
    /// Off is not "on but ignored": with `/ai` withdrawn there is no command
    /// to name, and a field sitting there editable would be a setting for a
    /// thing that does not run.
    private func showAgent() {
        guard let agentGroup else { return }
        SettingsWindowController.setRowHidden(
            agentGroup,
            row: SettingsForm.index(of: .agentCommand, inPane: SettingsForm.aiAgent) ?? 1,
            hidden: !Prefs.agentEnabled)
        fitWindowToPane()
    }

    /// The file-name template exists only when a summon makes a new note.
    ///
    /// With the same note opening every time there is never a name to choose,
    /// so the row would be a setting that decides nothing.
    private func showNoteMode() {
        opensPopup.selectItem(withTitle: Prefs.noteMode.title)
        guard let notesGroup else { return }
        SettingsWindowController.setRowHidden(
            notesGroup,
            row: SettingsForm.index(of: .newNoteName, inPane: SettingsForm.general) ?? 1,
            hidden: Prefs.noteMode != .newEachSession)
        fitWindowToPane()
    }

    /// Put the file rows where the machine and the settings actually are.
    ///
    /// The caption belongs to the home row and carries the two things the menu
    /// itself cannot say: WHERE that choice put the file, and the one case
    /// where the choice is overruled. Asking for iCloud Drive on a Mac with
    /// iCloud Drive switched off lands in Documents, silently in behaviour and
    /// not in the interface.
    private func showFiles() {
        scratchpadPath.setURL(Prefs.scratchpadURL)
        iCloudSwitch.state = Prefs.noteHome == .iCloud ? .on : .off
        iCloudSwitch.isEnabled = Prefs.iCloudAvailable
        // The Location row exists only when the answer above is no. With
        // iCloud Drive on there is one place the note can be and it is the
        // same place on every Mac, so the row would be a read-only fact; with
        // it off the folder is a real choice, and this is where it is made.
        if let filesGroup {
            SettingsWindowController.setRowHidden(
                filesGroup,
                row: SettingsForm.index(of: .location, inPane: SettingsForm.general) ?? 1,
                hidden: Prefs.noteHome == .iCloud)
            // The pane just got shorter or taller, so the window follows it.
            fitWindowToPane()
        }
        iCloudCaption.say(Prefs.iCloudAvailable
                          ? ""
                          : "iCloud Drive is off in System Settings, so notes stay on this Mac.",
                          bad: false)
    }

    /// Put the update row where this build actually stands.
    ///
    /// A development build cannot update itself, and the row says why rather
    /// than sitting there switched on and doing nothing: replacing it would
    /// delete the change it was installed to show.
    private func showAutoUpdate() {
        let availability = RowAvailability.autoUpdate(updatesItself: AppFlavor.current.updatesItself)
        updateSwitch.isEnabled = availability.isEnabled
        updateButton.isEnabled = availability.isEnabled
        updateSwitch.state = Prefs.autoUpdate && availability.isEnabled ? .on : .off
        rowViews[.autoUpdate]?.apply(availability)
    }

    @objc private func toggleAutoUpdate() {
        Prefs.autoUpdate = updateSwitch.state == .on
    }

    @objc private func checkForUpdatesNow() {
        onCheckForUpdates()
    }

    /// What the pull-down reads with its menu shut when the command below it
    /// names no tool this build knows.
    private static let presetMenuPrompt = "Select AI"

    /// What it reads for a given command: the tool being run, or the prompt.
    ///
    /// A PULL-DOWN still, so this is not the menu claiming to be the setting:
    /// the field below it is what `/ai` runs, and choosing an entry writes
    /// that field and is then done with. What the title says is the answer to
    /// a question somebody looking at a shell command should not have to
    /// parse, which is which of these tools it is. Matched on the program
    /// alone (`AgentPreset.matching`), so an edited flag does not make the
    /// menu forget the tool it is still running.
    private static func presetMenuTitle(for command: String) -> String {
        AgentPreset.matching(command: command)?.title ?? presetMenuPrompt
    }

    /// Put the pull-down's title back in step with the command field.
    private func showAgentPreset() {
        showAgentPreset(for: Prefs.agentCommand)
    }

    /// Draw the pull-down and the link against `command`, whatever is stored.
    ///
    /// Split out so a check can drive both against a command of its own
    /// without writing a setting: what is worth checking is that the pane
    /// FOLLOWS the command, and a version that read `Prefs` once at build time
    /// would look identical against the default.
    func showAgentPreset(for command: String) {
        agentPresetPopup.item(at: 0)?.title = Self.presetMenuTitle(for: command)
        // Item 0 IS the button's title under `pullsDown`, and AppKit caches
        // what it drew: without this the button keeps the old word until
        // something else makes it re-lay out.
        agentPresetPopup.synchronizeTitleAndSelectedItem()
        // The link follows the same answer the pull-down's title does, so a
        // command naming a tool this build does not know leaves no link rather
        // than one pointing at somebody else's documentation.
        let preset = AgentPreset.matching(command: command)
        if let preset {
            agentDocLink.point(at: preset.documentation, titled: preset.title)
        }
        agentDocLinkHolder?.isHidden = preset == nil
        fitWindowToPane()
    }

    /// Draw a screen from its declaration.
    ///
    /// `SettingsForm` says which rows a pane holds and in what order; this says
    /// what each row is wired to. Splitting them is what lets the first-run
    /// screen show a SUBSET under the same words without a second layout to
    /// keep in step: `WelcomeView` renders the same declaration with its own
    /// controls, and `SettingsFormTests` compares the two lists.
    private func render(_ pane: SettingsPane) -> [NSView] {
        var sections: [NSView] = []
        // The pane's own opening sentences, under the tab that names them.
        // No heading is drawn above them: the toolbar already carries one, and
        // a second copy of the tab's title at the top of its own pane is the
        // window saying where you are twice.
        sections.append(contentsOf: pane.intro.map(Self.intro))
        for group in pane.groups {
            let box = Self.group(group.rows.map { row in
                let parts = wiring(for: row)
                let view = Self.row(row, control: parts.control, below: parts.below,
                                    caption: parts.caption)
                rowViews[row] = view
                return view
            })
            // Remembered, because each of these cards holds a row that is
            // shown and hidden by the answer above it, and hiding a row means
            // reaching back into the card that drew it.
            if group.rows.contains(.location) { filesGroup = box }
            if group.rows.contains(.newNoteName) { notesGroup = box }
            if group.rows.contains(.agentCommand) { agentGroup = box }
            sections.append(box)
        }
        return sections
    }

    /// What one row is made of: the control at its trailing edge, anything
    /// drawn full width beneath it, and the sentence under both.
    private typealias Wiring = (control: NSView, below: [NSView], caption: Caption?)

    /// What each row is wired to. A switch over the enum, so a row added to
    /// `SettingsForm` fails to compile until it has a control.
    private func wiring(for row: SettingsRow) -> Wiring {
        switch row {
        case .summon: return (hotkeyRecorder, [], hotkeyCaption)
        case .storeInICloud: return (iCloudSwitch, [], iCloudCaption)
        case .location:
            return (Self.pathControl(scratchpadPath, self, #selector(chooseScratchpad)), [], nil)
        // No caption. The label is the whole of it, and what OFF means is
        // what off means in every other Mac application: nothing is written
        // until you ask. `AutosavePolicy` is where that promise is kept.
        case .autosave: return (autosaveSwitch, [], nil)
        case .showInDock: return (dockSwitch, [], nil)
        case .startAtLogin:
            return (Self.trailingControls([loginSettingsButton, loginSwitch]), [], loginCaption)
        case .autoUpdate:
            return (Self.trailingControls([updateButton, updateSwitch]), [], updateCaption)
        case .richLinks: return (networkSwitch, [], networkCaption)
        case .opens: return (opensPopup, [], nil)
        case .newNoteName:
            // The worked example goes FIRST, under the field and aligned with
            // it, because it is the field's own answer rather than a note
            // about the syntax: the eye reads the template and then what it
            // produces, in the same column. The vocabulary follows, in the
            // caption column where reference text belongs.
            return (newNoteField,
                    [Self.captionRow(newNoteCaption),
                     Self.helpWithLink(NoteNameTemplate.helpText,
                                       linkTitle: NoteNameTemplate.referenceLinkTitle,
                                       to: NoteNameTemplate.referenceURL)],
                    nil)
        case .agentEnabled: return (agentEnabledSwitch, [], nil)
        case .agentCommand:
            // The field is BELOW rather than beside: a shell command is long
            // and monospaced, and the pull-down is what sits at the trailing
            // edge because it is the shortcut rather than the setting. Test is
            // beside the pull-down, since both act on the command rather than
            // describing it.
            let link = Self.link(agentDocLink)
            agentDocLinkHolder = link
            return (Self.trailingControls([agentTestButton, agentPresetPopup]),
                    [agentField, link],
                    Caption("Terminal command executed by /ai in Jot."))
        case .resetSettings:
            return (resetButton, [],
                    Caption("Revert \(AppFlavor.current.displayName) to default settings. Will not "
                            + "move, delete, or modify any of your files."))
        case .welcomeScreen:
            return (welcomeButton, [], Caption("The questions Jot asks the first time it runs."))
        }
    }

    /// Whether a pane is being constructed right now. See `fitWindowToPane`.
    private var building = false

    private func buildPane(_ tab: Tab) -> NSView {
        building = true
        defer { building = false }
        if panes.isEmpty { wireControls() }
        let sections: [NSView]
        switch tab {
        case .general: sections = render(SettingsForm.general)
        case .aiAgent: sections = render(SettingsForm.aiAgent)
        case .advanced: sections = render(SettingsForm.advanced)
        }
        // After the sections exist, not before. `wireControls` runs at the top
        // of this method and `showFiles` hides a row of a card that this
        // method is about to build, so the sync above reaches a `filesGroup`
        // that is still nil and the Location row stays on screen with iCloud
        // Drive switched on.
        showFiles()
        showNoteMode()
        showAgent()
        // After the pane exists, or the documentation link is never told what
        // the command names: `wireControls` runs once, from the FIRST pane
        // built, and the link is a view the AI Agent pane creates later. Left
        // out, a command naming no tool still shows the link the button was
        // constructed with, pointing at the wrong tool's documentation.
        showAgentPreset()
        showNoteNamePreview()
        // Also after, and for a second reason: these two write through
        // `rowViews`, which `render` is what fills. Called from
        // `syncControlsFromPrefs` alone they would reach an empty map and the
        // rows would be drawn with no sentence and no dimming at all.
        showRowAvailability()
        return Self.pane(sections)
    }

    /// One pane: sections down the page, padded, sized to its content.
    static func pane(_ sections: [NSView]) -> NSView {
        let stack = NSStackView(views: sections)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        // 20 after each group, so the next heading starts a section rather
        // than reading as a caption on the group above it.
        for (index, view) in stack.arrangedSubviews.enumerated() where view is NSBox {
            if index + 1 < stack.arrangedSubviews.count { stack.setCustomSpacing(20, after: view) }
        }
        stack.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView()
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: Metrics.windowPadding),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: Metrics.windowPadding),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -Metrics.windowPadding),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -Metrics.windowPadding),
            stack.widthAnchor.constraint(equalToConstant: Metrics.content),
        ])
        // A leading-aligned vertical stack sizes each arranged view to its own
        // content; the groups are the full width and only the headings sit at
        // their own.
        for view in stack.arrangedSubviews where view is NSBox {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        return container
    }

    // MARK: pieces

    /// The ground a settings group sits on.
    ///
    /// NOT `controlBackgroundColor`, which is the obvious choice and resolves
    /// to the SAME colour as `windowBackgroundColor` in both appearances, so a
    /// card painted with it is invisible and the groups read as one long list.
    /// `SettingsCardTests` pins that, and is what would tell us if a future
    /// macOS separated the two and made the obvious colour right again.
    ///
    /// A translucent lift instead, which composites over whatever the window
    /// ground is: it settles into a light window and lifts off a dark one,
    /// which is the direction System Settings' own cards go in each. The group
    /// draws no border, so this fill is the whole of what bounds a card.
    static let settingsCard = NSColor(name: "birtaJotSettingsCard") { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(white: 1, alpha: 0.06)
            : NSColor(white: 0, alpha: 0.035)
    }

    /// One paragraph of a pane's intro, above its first card.
    ///
    /// Outside the card rather than in it, because it belongs to the whole
    /// pane rather than to any row: a paragraph inside a grouped list reads
    /// as a row that forgot its control. Full content width, since it is prose
    /// and the card's insets are for rows.
    static func intro(_ text: String) -> NSTextField {
        let label = Caption(text, wrapAt: Metrics.content)
        label.say(text, bad: false)
        // `wrapAt` is what makes it wrap, and it is load-bearing rather than a
        // default worth keeping: `pane` sizes only its BOXES to the stack, so
        // a paragraph is left to resolve its own width, and a wrapping label
        // with no maximum resolves that from the text. A heading gets away
        // with it by being short. `SettingsWindowSizeTests` holds the height.
        return label
    }

    /// A caption that is FIXED rather than live: reference text a row needs
    /// once, which nothing later rewrites.
    static func help(_ text: String) -> NSView {
        inset(Caption(text))
    }

    /// Reference text with its link at the end of the sentence.
    ///
    /// One line rather than two, because the link is part of what the sentence
    /// says: the tokens above are a shortlist and this is where the rest are.
    /// A separate line under it reads as a second, unrelated thing to read.
    ///
    /// Still a real button rather than an attributed string, for the reason
    /// `link` gives. Baseline-aligned, so the link sits on the sentence's line
    /// rather than on the centre of a caption that has wrapped.
    static func helpWithLink(_ text: String, linkTitle: String, to url: URL) -> NSView {
        let caption = Caption(text)
        // Free to wrap if the sentence outgrows the row, which keeps the link
        // at the end rather than pushing it off the card.
        caption.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let button = LinkButton(title: linkTitle, url: url)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.setContentHuggingPriority(.required, for: .horizontal)
        let stack = NSStackView(views: [caption, button])
        stack.orientation = .horizontal
        stack.alignment = .firstBaseline
        // The link button carries its own bezel inset, so the gap here is
        // narrower than the space between two words would suggest.
        stack.spacing = 0
        let holder = NSView()
        stack.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: Metrics.rowInset),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: holder.trailingAnchor,
                                            constant: -Metrics.rowInset),
            stack.topAnchor.constraint(equalTo: holder.topAnchor),
            stack.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
        ])
        return holder
    }

    /// A caption-sized link out to documentation we do not own.
    ///
    /// A real button rather than an attributed-string link: this has to be
    /// reachable from the keyboard, and an `NSTextField` carrying a link is
    /// not in the key view loop.
    static func link(_ title: String, to url: URL) -> NSView {
        link(LinkButton(title: title, url: url))
    }

    /// The same, around a link that already exists, for one whose destination
    /// moves with a selection above it.
    static func link(_ button: LinkButton) -> NSView {
        // Leading-aligned with the label above it, and hugging its own title
        // so the clickable area is the words rather than the row.
        let holder = NSView()
        button.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(button)
        NSLayoutConstraint.activate([
            button.leadingAnchor.constraint(equalTo: holder.leadingAnchor,
                                            constant: Metrics.rowInset - 2),
            button.topAnchor.constraint(equalTo: holder.topAnchor),
            button.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            button.trailingAnchor.constraint(lessThanOrEqualTo: holder.trailingAnchor),
        ])
        return holder
    }

    /// A full-width view inset to the label's leading edge, so anything drawn
    /// under a row starts under the name it belongs to.
    static func inset(_ view: NSView) -> NSView {
        let holder = NSView()
        view.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: Metrics.rowInset),
            view.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -Metrics.rowInset),
            view.topAnchor.constraint(equalTo: holder.topAnchor),
            view.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
        ])
        return holder
    }

    /// A caption drawn as one of a row's `below` views rather than as its
    /// trailing sentence.
    ///
    /// It has to be inset by hand, because `row` insets a `below` view only
    /// when it is a plain field: a Caption there would otherwise run to the
    /// card's own edges, which is a whole `rowInset` further out than the
    /// column every other sentence starts in. The holder is wired up so an
    /// empty caption still takes itself out of the layout.
    static func captionRow(_ caption: Caption) -> NSView {
        let holder = inset(caption)
        caption.holder = holder
        holder.isHidden = caption.isHidden
        return holder
    }

    /// Several controls as one trailing control, in the order given.
    static func trailingControls(_ views: [NSView]) -> NSView {
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.spacing = 8
        stack.alignment = .centerY
        return stack
    }

    /// One rounded section. Rows are separated by a hairline, inset from the
    /// leading edge the way a grouped list insets its separators.
    static func group(_ rows: [NSView]) -> NSView {
        var arranged: [NSView] = []
        for (index, row) in rows.enumerated() {
            if index > 0 { arranged.append(separator()) }
            arranged.append(row)
        }
        let stack = NSStackView(views: arranged)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false

        let box = NSBox()
        box.boxType = .custom
        // No stroke. A settings group is grouped by its fill and the space
        // around it; an outline as well draws a box around something already
        // bounded, and three of them down a pane read as a form.
        box.borderWidth = 0
        box.cornerRadius = 10
        box.fillColor = SettingsWindowController.settingsCard
        box.contentViewMargins = .zero
        box.contentView = stack
        box.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: box.topAnchor),
            stack.bottomAnchor.constraint(equalTo: box.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: box.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: box.trailingAnchor),
        ])
        // Rows and hairlines both span the group; a vertical stack sizes its
        // arranged views to their content otherwise, and a hairline's content
        // is nothing.
        for view in arranged { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        return box
    }

    /// Show or hide one row of a `group`, hairline and all.
    ///
    /// A row that comes and goes has to take its separator with it, or hiding
    /// it leaves two hairlines touching where a row used to be. The index
    /// arithmetic is `group`'s own layout read back: it interleaves
    /// `[row, separator, row, separator, row]`, so row `i` sits at `2i` and
    /// the hairline that belongs to it is the one before it. Tied to that
    /// construction on purpose rather than searching for hairlines by type,
    /// which would silently pick up any future one.
    static func setRowHidden(_ group: NSView, row index: Int, hidden: Bool) {
        guard let box = group as? NSBox,
              let stack = box.contentView as? NSStackView else { return }
        let views = stack.arrangedSubviews
        let position = index * 2
        guard position < views.count else { return }
        views[position].isHidden = hidden
        if position > 0 { views[position - 1].isHidden = hidden }
    }

    private static func separator() -> NSView {
        let line = NSBox()
        line.boxType = .separator
        line.translatesAutoresizingMaskIntoConstraints = false
        let holder = NSView()
        holder.addSubview(line)
        NSLayoutConstraint.activate([
            line.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: Metrics.rowInset),
            line.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
            line.topAnchor.constraint(equalTo: holder.topAnchor),
            line.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            holder.heightAnchor.constraint(equalToConstant: 1),
        ])
        return holder
    }

    /// A row, labelled from the shared vocabulary. Every row on either screen
    /// goes through here, so a label has one spelling.
    static func row(_ row: SettingsRow, control: NSView, below: [NSView] = [],
                    caption: Caption? = nil) -> SettingsRowView {
        self.row(row.rawValue, control: control, below: below, caption: caption)
    }

    /// A settings row: the name on the left, the control on the right, and an
    /// optional sentence under both.
    ///
    /// The vertical axis is an NSStackView rather than constraints, and that is
    /// the whole reason it is one: NSStackView is the only thing here that
    /// takes a hidden view OUT of the layout. A caption that is empty right now
    /// but may fill later (the login row goes from silent to a warning) has to
    /// collapse to nothing meanwhile, and under plain constraints a hidden
    /// NSTextField keeps its line height and leaves a blank gap.
    static func row(_ title: String, control: NSView, below: [NSView] = [],
                    caption: Caption? = nil) -> SettingsRowView {
        let label = NSTextField(labelWithString: title)
        let line = NSView()
        for view in [label, control] {
            view.translatesAutoresizingMaskIntoConstraints = false
            line.addSubview(view)
        }
        label.setContentCompressionResistancePriority(.required, for: .horizontal)
        label.setContentHuggingPriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: line.leadingAnchor, constant: Metrics.rowInset),
            label.topAnchor.constraint(greaterThanOrEqualTo: line.topAnchor),
            label.centerYAnchor.constraint(equalTo: line.centerYAnchor),
            control.trailingAnchor.constraint(equalTo: line.trailingAnchor, constant: -Metrics.rowInset),
            control.centerYAnchor.constraint(equalTo: line.centerYAnchor),
            control.topAnchor.constraint(greaterThanOrEqualTo: line.topAnchor),
            control.bottomAnchor.constraint(lessThanOrEqualTo: line.bottomAnchor),
            control.leadingAnchor.constraint(greaterThanOrEqualTo: label.trailingAnchor, constant: 12),
            line.bottomAnchor.constraint(greaterThanOrEqualTo: label.bottomAnchor),
        ])

        // The line, then anything drawn full width under it, then the
        // sentence. A view in `below` is a CONTROL rather than prose (the
        // agent command field is the case this exists for), so it is inset to
        // the label's edge the way a caption is but is not one.
        var arranged: [NSView] = [line]
        arranged += below.map { $0 is NSTextField && !($0 is Caption) ? inset($0) : $0 }
        if let caption {
            caption.translatesAutoresizingMaskIntoConstraints = false
            // Inset to the label's leading edge, so the sentence starts under
            // the name it belongs to rather than at the card's edge.
            let holder = NSView()
            holder.addSubview(caption)
            NSLayoutConstraint.activate([
                caption.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: Metrics.rowInset),
                caption.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -Metrics.rowInset),
                caption.topAnchor.constraint(equalTo: holder.topAnchor),
                caption.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            ])
            // The HOLDER follows the caption's own hidden state, because it is
            // the holder the stack is arranging.
            caption.holder = holder
            holder.isHidden = caption.isHidden
            arranged.append(holder)
        }

        let stack = SettingsRowView(label: label, caption: caption, arranged: arranged)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.edgeInsets = NSEdgeInsets(top: 10, left: 0, bottom: 10, right: 0)
        stack.translatesAutoresizingMaskIntoConstraints = false
        for view in arranged { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        return stack
    }

    /// A path and the button that changes it, as one trailing control.
    static func pathControl(_ path: PathLabel, _ button: NSButton) -> NSView {
        let stack = NSStackView(views: [path, button])
        stack.orientation = .horizontal
        stack.spacing = 8
        stack.alignment = .centerY
        return stack
    }

    static func pathControl(_ path: PathLabel, _ target: AnyObject, _ action: Selector) -> NSView {
        pathControl(path, NSButton(title: "Choose…", target: target, action: action))
    }

    // MARK: hotkey

    /// Choose a hotkey the way the recorder does, for a check over what the
    /// row says when macOS refuses one. Nothing else reaches this path: the
    /// refusal is the system's answer and cannot be provoked by hand.
    func chooseHotkeyForTesting(_ combo: HotkeyCombo) { hotkeyChosen(combo) }

    private func hotkeyChosen(_ combo: HotkeyCombo) {
        guard combo != Prefs.hotkey else { return }
        Prefs.hotkey = combo
        let status = onHotkeyChange()
        rowViews[.summon]?.apply(status == 0
            ? .available()
            : .warning("macOS refused \(combo.symbols); another app may own it."))
        hotkeyRecorder.setCombo(combo)
    }

    // MARK: files

    /// The three popups and the two buttons Advanced grew.
    ///
    /// Each writes ONE setting and then re-reads the pane, because these rows
    /// decide each other: the mode dims the file row, and the home changes the
    /// path that row shows.
    @objc private func chooseNoteMode() {
        Prefs.noteMode = NoteMode.allCases.first { $0.title == opensPopup.titleOfSelectedItem }
            ?? Prefs.noteMode
        showNoteMode()
    }

    /// Where notes live. Off hands the decision to the Location row below,
    /// which is the folder chooser; on takes it back. Clearing the chosen path
    /// is what makes iCloud reachable again, since a chosen path outranks both
    /// homes and would otherwise overrule this switch invisibly.
    @objc private func toggleICloud() {
        if iCloudSwitch.state == .on {
            Prefs.scratchpadURL = nil
            Prefs.storeInICloud = true
        } else {
            Prefs.storeInICloud = false
        }
        showFiles()
        onChange()
    }

    /// A template is a SHORTCUT INTO the field below, never a second place the
    /// setting lives. It writes the command and is then done with; the field
    /// is what `/ai` runs, whatever it says a moment later.
    @objc private func chooseAgentPreset() {
        guard let preset = AgentPreset.allCases
            .first(where: { $0.title == agentPresetPopup.titleOfSelectedItem }) else { return }
        Prefs.agentCommand = preset.template
        agentField.stringValue = preset.template
        showAgentPreset()
        onChange()
    }

    @objc private func toggleAgentEnabled() {
        Prefs.agentEnabled = agentEnabledSwitch.state == .on
        showAgent()
        // The page is reloaded because this withdraws a host CAPABILITY rather
        // than flipping an editor setting: the slash row and the command are
        // built from the profile at boot, so the panel has to be told again.
        onChange()
    }

    /// Everything back to defaults, in the order that leaves nothing stale.
    ///
    /// A sheet first, because this is not undoable and the window has no
    /// Cancel of its own. Then `Prefs.reset`, then re-apply each thing that
    /// was read at launch and cached somewhere: the Dock policy, the hotkey
    /// registration, and finally the page, which is last because
    /// `onChange` is the only path that flushes the buffer to the old file
    /// before rebinding to the new one. Reversing those two loses whatever is
    /// in the panel.
    @objc private func resetAllSettings() {
        let alert = NSAlert()
        alert.messageText = "Reset all settings?"
        alert.informativeText = "Every setting goes back to its default, including the hotkey. "
            + "Your notes are left exactly where they are, and Jot reopens the default one."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Reset")
        alert.addButton(withTitle: "Cancel")
        guard let window else { return }
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            Prefs.reset()
            AppDelegate.applyActivationPolicy()
            _ = self.onHotkeyChange()
            self.syncControlsFromPrefs()
            self.onChange()
        }
    }

    /// Ask the first-launch questions again. This clears the flag that gates
    /// the screen and nothing else; the screen it opens is what writes.
    @objc private func showWelcomeAgain() {
        Prefs.hasSeenWelcome = false
        onShowWelcome()
    }

    @objc private func chooseScratchpad() {
        let panel = NSSavePanel()
        panel.title = "Scratchpad location"
        panel.nameFieldStringValue = Prefs.scratchpadURL.lastPathComponent
        panel.directoryURL = Prefs.scratchpadURL.deletingLastPathComponent()
        panel.allowedContentTypes = [.init(filenameExtension: "md") ?? .plainText]
        panel.beginSheetModal(for: window!) { [weak self] resp in
            guard resp == .OK, let url = panel.url, let self else { return }
            Prefs.scratchpadURL = url
            // The iCloud row above stops deciding anything the moment a path
            // is chosen here, and has to say so in the same gesture.
            self.showFiles()
            self.onChange()
        }
    }


    /// Put the row where the system says it is. Called on every toggle and
    /// whenever the window comes forward, because System Settings changes the
    /// same registration and Jot is never told.
    private func showLoginItem(_ state: LoginItemState) {
        let availability = RowAvailability.startAtLogin(state)
        loginSwitch.state = state.isOn ? .on : .off
        loginSwitch.isEnabled = availability.isEnabled
        loginSettingsButton.isHidden = state != .blocked
        rowViews[.startAtLogin]?.apply(availability)
    }

    @objc private func toggleLoginItem() {
        do {
            showLoginItem(try LoginItem.set(loginSwitch.state == .on))
        } catch {
            // Put the switch back where the system still has it, then say what
            // happened. A switch left where the user pushed it would claim a
            // registration that does not exist.
            showLoginItem(LoginItem.state)
            rowViews[.startAtLogin]?.apply(
                .warning("macOS refused: \(error.localizedDescription)"))
        }
    }

    @objc private func openLoginItemSettings() {
        LoginItem.openSystemSettings()
    }

    /// The window is reused rather than rebuilt, and the trip to System
    /// Settings that `blocked` asks for ends by coming back to it, so the row
    /// is re-read on the way in rather than only when it is first built.
    func windowDidBecomeKey(_ notification: Notification) {
        showLoginItem(LoginItem.state)
        // Same reason: iCloud Drive is switched on in System Settings, and Jot
        // is never told. A row that said "iCloud Drive is off" until the next
        // launch would be lying about a thing the user has just changed.
        showFiles()
    }

    /// Committed on every edit rather than only on Return: the window has no
    /// OK button, and a command typed and then dismissed by closing the window
    /// would otherwise be lost without a word.
    func controlTextDidChange(_ notification: Notification) {
        switch notification.object as? NSTextField {
        case let field where field === agentField:
            Prefs.agentCommand = agentField.stringValue
        case let field where field === newNoteField:
            // Stored as typed, including a half-finished token: expansion is
            // `NoteNameTemplate`'s and it falls back rather than failing, so a
            // template mid-edit can never stop a new note being made. The
            // caption underneath shows what today's name would be, which is
            // where a broken format is visible.
            Prefs.newNoteNameTemplate = newNoteField.stringValue
            showNoteNamePreview()
        default: return
        }
    }

    /// What the template would call a note made right now.
    ///
    /// A worked example rather than a description of the syntax: `%Y-%m-%d` is
    /// only obvious to somebody who already knows, and the one question a
    /// person actually has here is what their file will be called.
    private func showNoteNamePreview() {
        newNoteCaption.say(NoteNameTemplate.expand(Prefs.newNoteNameTemplate), bad: false)
    }

    // MARK: the agent test

    /// Run the command in the field once, with a trivial prompt, and show what
    /// came back.
    ///
    /// The one thing on this pane that can tell an installed tool from a typo.
    /// Everything else here is a claim about a shell line nobody has run: the
    /// pull-down names the program, the link points at its documentation, and
    /// both are just as confident about a command that is not on PATH.
    @objc private func testAgentCommand() {
        let template = Prefs.agentCommand.trimmingCharacters(in: .whitespaces)
        let name = Self.toolName(for: template)
        guard !template.isEmpty else {
            showAgentTestResult(name: name, result: AgentProbeResult(
                succeeded: false, transcript: "",
                failure: "There is no command to run. Choose a tool, or type one."))
            return
        }
        // The button IS the progress indicator. A run takes as long as the
        // tool takes to answer, which is seconds, and a spinner beside a
        // button that still says Test invites a second click that starts a
        // second child process.
        agentTestButton.isEnabled = false
        agentTestButton.title = "Testing…"
        agentProbe.probe(template: template) { [weak self] result in
            guard let self else { return }
            self.agentTestButton.isEnabled = true
            self.agentTestButton.title = "Test"
            self.showAgentTestResult(name: name, result: result)
        }
    }

    /// What to call the tool in the sheet: the preset's name where the command
    /// names one, and otherwise the program it runs, which is the most this
    /// can honestly say about somebody's own command line.
    private static func toolName(for command: String) -> String {
        AgentPreset.matching(command: command)?.title
            ?? AgentRequest.harnessName(from: command)
            ?? "The agent"
    }

    /// The sheet: what happened, which tool it was, and what it printed.
    ///
    /// The transcript is in an accessory view rather than in `informativeText`
    /// because an agent's answer is arbitrarily long and a sheet built around
    /// one label grows until it is taller than the screen. It is selectable,
    /// so a failure can be copied into a search.
    private func showAgentTestResult(name: String, result: AgentProbeResult) {
        // Only onto a window that is still on screen. A test takes as long as
        // the tool takes, and Settings can be shut in the meantime: a sheet
        // begun on a closed window either goes nowhere or brings the window
        // back, and neither is an answer to a question the person stopped
        // asking.
        guard let window, window.isVisible else { return }
        Self.agentTestAlert(name: name, result: result).beginSheetModal(for: window)
    }

    /// The sheet itself, built rather than presented, so what it says is
    /// checkable without a window and without anything appearing on screen.
    static func agentTestAlert(name: String, result: AgentProbeResult) -> NSAlert {
        let alert = NSAlert()
        // Not "did not run": a command that started, authenticated and then
        // exited with an error DID run, and that is the ordinary failure here.
        // The pair says what the person asked, which is whether it works.
        alert.messageText = result.succeeded ? "It works!" : "It did not work."
        // The tool's name above whatever it printed, because the answer means
        // nothing without knowing which tool gave it.
        alert.informativeText = name
        alert.alertStyle = result.succeeded ? .informational : .warning
        // What the tool said, and where it said nothing, our own account of
        // how it ended. Never both: two explanations of one failure read as
        // two failures.
        let body = result.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        alert.accessoryView = transcript(body.isEmpty ? (result.failure ?? "") : body)
        // Acknowledge and nothing else. A test that has finished leaves
        // nothing to decide, so a second button would be a question with no
        // question behind it.
        alert.addButton(withTitle: "Close")
        return alert
    }

    /// A scrollable, selectable, monospaced block of whatever a command
    /// printed.
    static func transcript(_ text: String) -> NSView {
        let view = NSTextView()
        view.string = text
        view.isEditable = false
        view.isSelectable = true
        view.drawsBackground = false
        view.font = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        view.textContainerInset = NSSize(width: 4, height: 4)
        let scroll = NSScrollView()
        scroll.documentView = view
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.borderType = .bezelBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            // Wide enough for a wrapped shell line, tall enough for a short
            // answer without becoming a window of its own.
            scroll.widthAnchor.constraint(equalToConstant: 380),
            scroll.heightAnchor.constraint(equalToConstant: 140),
        ])
        return scroll
    }

    @objc private func toggleAutosave() {
        Prefs.autosave = autosaveSwitch.state == .on
    }

    /// The Dock icon, and Cmd+Tab with it. Applied HERE and now rather than
    /// through `onChange`, which flushes the buffer and reloads the page: that
    /// would leave the user watching a switch they moved with nothing
    /// happening for a round trip. Nothing else needs re-reading for it.
    @objc private func toggleShowInDock() {
        Prefs.showInDock = dockSwitch.state == .on
        AppDelegate.applyActivationPolicy()
    }

    @objc private func toggleNetwork() {
        Prefs.networkEnabled = networkSwitch.state == .on
        onChange()
    }
}

/// One settings row, holding the two views availability is drawn on.
///
/// A row is otherwise a stack of anonymous views, so a surface wanting to dim
/// one had to keep a reference to its label and its caption separately and
/// remember to move both. This keeps them together and gives the pairing one
/// implementation, which is the whole of what `RowAvailability` means on
/// screen: the label follows `isEnabled`, the sentence follows `tone`.
@MainActor
final class SettingsRowView: NSStackView {
    /// The row's name, dimmed when the row cannot be operated.
    let titleLabel: NSTextField
    /// The sentence under it, when it has one.
    let caption: Caption?

    init(label: NSTextField, caption: Caption?, arranged: [NSView]) {
        self.titleLabel = label
        self.caption = caption
        super.init(frame: .zero)
        for view in arranged { addArrangedSubview(view) }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Draw the row as `availability` says it stands.
    ///
    /// The label is the part worth insisting on. A disabled switch is dim on
    /// its own and easy to read as a switch that is simply off, so the NAME
    /// goes to the system's disabled ink too: the row reads as unavailable
    /// before anybody looks at the control.
    func apply(_ availability: RowAvailability) {
        titleLabel.textColor = availability.isEnabled ? .labelColor : .disabledControlTextColor
        caption?.say(availability.note, bad: availability.isProblem)
    }
}

/// A sentence under a row: secondary, wrapping, and occasionally an error.
final class Caption: NSTextField {
    init(_ text: String, wrapAt width: CGFloat = SettingsWindowController.Metrics.captionWidth) {
        super.init(frame: .zero)
        isEditable = false
        isBordered = false
        drawsBackground = false
        isSelectable = false
        lineBreakMode = .byWordWrapping
        maximumNumberOfLines = 0
        font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        preferredMaxLayoutWidth = width
        say(text, bad: false)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// A wrapping label needs to be told the width it wraps at; it is the
    /// width it has just been given.
    override func layout() {
        if abs(preferredMaxLayoutWidth - bounds.width) > 0.5 {
            preferredMaxLayoutWidth = bounds.width
            invalidateIntrinsicContentSize()
        }
        super.layout()
    }

    /// An empty caption is HIDDEN, not blank: a row whose label says it all
    /// should be one line tall, and a zero-height label still contributes its
    /// spacing to the row above and below it.
    /// The view the row's stack is arranging, so hiding an empty caption takes
    /// its inset holder out of the layout too. Weak: the holder owns it.
    weak var holder: NSView?

    /// An empty caption is HIDDEN, not blank, and hiding it collapses the row
    /// because the row's vertical axis is a stack. Both this and the holder
    /// have to go, or the stack keeps arranging an empty box.
    ///
    /// Called directly only for a sentence that is always ordinary prose. A
    /// row whose sentence can turn RED goes through `SettingsRowView.apply`
    /// instead, so the ink and the row's own availability are decided by one
    /// `RowAvailability` rather than by two call sites that can disagree about
    /// whether something is wrong.
    func say(_ text: String, bad: Bool) {
        stringValue = text
        textColor = bad ? .systemRed : .secondaryLabelColor
        isHidden = text.isEmpty
        holder?.isHidden = isHidden
    }
}

/// A file path shown the way a settings row shows one: the name in full, the
/// directory truncated from the middle, and the whole path on hover.
final class PathLabel: NSTextField {
    init(_ url: URL?) {
        super.init(frame: .zero)
        isEditable = false
        isBordered = false
        drawsBackground = false
        isSelectable = false
        lineBreakMode = .byTruncatingMiddle
        alignment = .right
        font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        setURL(url)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Not `isEnabled`, which NSControl already owns: this is only how the
    /// path reads when the setting above it is switched off.
    var isDimmed: Bool = false {
        didSet { textColor = isDimmed ? .tertiaryLabelColor : .secondaryLabelColor }
    }

    func setURL(_ url: URL?) {
        stringValue = url.map { $0.path.replacingOccurrences(of: NSHomeDirectory(), with: "~") } ?? "None chosen"
        toolTip = url?.path
        textColor = isDimmed ? .tertiaryLabelColor : .secondaryLabelColor
    }
}

/// A view that paints the window ground.
///
/// A plain NSView draws nothing, so the settings card's translucency would
/// composite over whatever happened to be behind the window. Painting it here
/// with a dynamic NSColor, in `draw` rather than a layer, is what keeps the
/// ground correct when the system flips between light and dark: a CGColor on a
/// layer is resolved once and then stale.
final class BackgroundView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        dirtyRect.fill()
    }
}


/// A caption-sized link out to documentation we do not own.
///
/// The button OWNS its destination. The first version kept a shared dictionary
/// keyed by `ObjectIdentifier` instead, which is an address: a button that has
/// been deallocated leaves its entry behind, and the next allocation at that
/// address inherits somebody else's URL. Settings windows are built and closed
/// repeatedly by the tests, which is exactly the traffic that recycles one.
///
/// A real button rather than an attributed-string link, because this has to be
/// reachable from the keyboard and an `NSTextField` carrying a link is not in
/// the key view loop.
@MainActor
final class LinkButton: NSButton {
    /// Settable, because one of these follows the agent pull-down and has to
    /// point at whichever tool the command below it names. Still OWNED by the
    /// button rather than looked up from a table keyed on its address.
    private(set) var url: URL

    /// Point at somewhere else, title and destination together, so the two
    /// cannot be moved separately and disagree.
    func point(at url: URL, titled title: String) {
        self.url = url
        self.title = title
        toolTip = url.absoluteString
    }

    init(title: String, url: URL) {
        self.url = url
        super.init(frame: .zero)
        self.title = title
        bezelStyle = .inline
        isBordered = false
        controlSize = .small
        contentTintColor = .linkColor
        font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        toolTip = url.absoluteString
        target = self
        action = #selector(open)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func open() { NSWorkspace.shared.open(url) }
}
