import AppKit
import BirtaJotCore

/// Jot's Settings window.
///
/// Built to the shape macOS settings windows have: a preference toolbar of
/// tabs across the top (which is what centres the title, `toolbarStyle =
/// .preference` doing the work), one pane at a time, each pane a stack of
/// sections with a heading and rows in a rounded group.
///
/// Panes rather than one long column because the list outgrew a column: a
/// window that scrolls past its own title is a form, and a reader looking for
/// one switch should not have to pass nine others. `Advanced` is where the
/// file paths and the agent command live, so the two panes anyone opens are
/// short and every row in them is a plain choice.
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
        /// screen. Only Advanced reaches it today.
        static let maxPaneHeight: CGFloat = 520
        static var captionWidth: CGFloat { content - rowInset * 2 }
    }

    /// The panes, in toolbar order.
    ///
    /// Two, not three. General holds the questions the welcome screen asks, in
    /// the same groups and the same words, so a row a person met on first run
    /// is where they left it. Advanced holds what the welcome screen does not
    /// ask: which note opens, the agent command, and the reset. Editor is gone
    /// because its only row was Autosave, which belongs with the rest of how
    /// Jot behaves, and a tab that costs a click to discover is empty is worse
    /// than no tab.
    private enum Tab: String, CaseIterable {
        case general, advanced

        var title: String {
            switch self {
            case .general: return "General"
            case .advanced: return "Advanced"
            }
        }

        var symbol: String {
            switch self {
            case .general: return "gearshape"
            case .advanced: return "wrench.and.screwdriver"
            }
        }
    }

    private let scrollView = NSScrollView()
    /// Built on first visit and kept, so switching back does not rebuild the
    /// controls and lose the state they are showing.
    private var panes: [Tab: NSView] = [:]

    private let hotkeyRecorder = HotkeyRecorderView(combo: Prefs.hotkey)
    private let hotkeyCaption = Caption("")
    private let scratchpadPath = PathLabel(Prefs.scratchpadURL)
    private let networkSwitch = NSSwitch()
    private let agentField = NSTextField(string: Prefs.agentCommand)
    private let agentPresetPopup = NSPopUpButton()
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
    /// The card holding the iCloud switch and the Location row under it. Kept
    /// so the second row can be taken away when the first one answers.
    private var filesGroup: NSView?
    private let updateSwitch = NSSwitch()
    private let updateCaption = Caption("")
    private let updateButton = NSButton(title: "Check Now", target: nil, action: nil)
    private let resetButton = NSButton(title: "Reset…", target: nil, action: nil)
    private let welcomeButton = NSButton(title: "Show Welcome…", target: nil, action: nil)
    private let loginSwitch = NSSwitch()
    private let loginCaption = Caption(LoginItemState.off.caption)
    private let loginSettingsButton = NSButton(title: "Open System Settings…", target: nil, action: nil)

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
        show(.general, animated: false)
        window.center()
    }

    /// Put `tab` on screen and size the window to it, the way a settings
    /// window does: the window is as tall as the pane needs, up to a ceiling
    /// past which the pane scrolls instead.
    private func show(_ tab: Tab, animated: Bool) {
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
        fitWindowToPane(animated: animated)
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
    private func fitWindowToPane(animated: Bool) {
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
        // than it by that much. `content` is the height the pane is actually
        // given, capped, and `wanted` is what it asked for uncapped.
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
        window.setFrame(target, display: true, animate: animated)
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

    /// Show a pane by name, for `BIRTA_JOT_OPEN_SETTINGS`. Unknown names are
    /// ignored rather than fatal: the variable is a probe, and a typo in it
    /// should not stop the app.
    func selectTabForTesting(_ name: String) {
        guard let tab = Tab(rawValue: name) else { return }
        window?.toolbar?.selectedItemIdentifier = NSToolbarItem.Identifier(tab.rawValue)
        show(tab, animated: false)
    }

    /// Move the iCloud switch the way a click does, for `BIRTA_JOT_TOGGLE_ICLOUD`.
    ///
    /// The Location row under it comes and goes with this answer, which is the
    /// one thing that changes a pane's height after it is built. Without a way
    /// to drive it, a check on the window following its pane can only ever see
    /// the FIRST sizing, which happens whether or not the following works.
    func toggleICloudForTesting() {
        guard iCloudSwitch.isEnabled else { return }
        iCloudSwitch.state = iCloudSwitch.state == .on ? .off : .on
        NSApp.sendAction(iCloudSwitch.action!, to: iCloudSwitch.target, from: iCloudSwitch)
    }

    @objc private func selectTab(_ sender: NSToolbarItem) {
        guard let tab = Tab(rawValue: sender.itemIdentifier.rawValue) else { return }
        show(tab, animated: true)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: content

    /// Wire every control once, whichever pane ends up holding it.
    private func wireControls() {
        hotkeyRecorder.onCombo = { [weak self] combo in self?.hotkeyChosen(combo) }

        for (popup, titles, action) in [
            (opensPopup, NoteMode.allCases.map(\.title), #selector(chooseNoteMode)),
            (agentPresetPopup, AgentPreset.allCases.map(\.title) + [Self.customPresetTitle],
             #selector(chooseAgentPreset)),
        ] {
            // Titles come from the types, so a case added to `NoteMode` or
            // `AgentPreset` appears here without this file being edited. The
            // menu's own order is the type's declaration order.
            popup.removeAllItems()
            popup.addItems(withTitles: titles)
            popup.controlSize = .small
            popup.target = self
            popup.action = action
        }
        agentPresetPopup.widthAnchor.constraint(equalToConstant: 260).isActive = true

        updateButton.target = self
        updateButton.action = #selector(checkForUpdatesNow)
        updateButton.controlSize = .small
        resetButton.target = self
        resetButton.action = #selector(resetAllSettings)
        resetButton.controlSize = .small
        welcomeButton.target = self
        welcomeButton.action = #selector(showWelcomeAgain)
        welcomeButton.controlSize = .small

        agentField.placeholderString = "claude -p {prompt}"
        agentField.delegate = self
        agentField.font = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        agentField.widthAnchor.constraint(equalToConstant: 260).isActive = true

        loginSettingsButton.target = self
        loginSettingsButton.action = #selector(openLoginItemSettings)
        loginSettingsButton.controlSize = .small

        for (control, on, action) in [
            (networkSwitch, Prefs.networkEnabled, #selector(toggleNetwork)),
            (iCloudSwitch, Prefs.noteHome == .iCloud, #selector(toggleICloud)),
            (updateSwitch, Prefs.autoUpdate, #selector(toggleAutoUpdate)),
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
        networkCaption.say("Off means no outbound request at all.", bad: false)
        showAutoUpdate()
        autosaveSwitch.state = Prefs.autosave ? .on : .off
        dockSwitch.state = Prefs.showInDock ? .on : .off
        hotkeyRecorder.setCombo(Prefs.hotkey)
        agentField.stringValue = Prefs.agentCommand
        showAgentPreset()
        showLoginItem(LoginItem.state)
        showFiles()
    }

    /// Put the file rows where the machine and the settings actually are.
    ///
    /// The caption belongs to the home row and carries the two things the menu
    /// itself cannot say: WHERE that choice put the file, and the one case
    /// where the choice is overruled. Asking for iCloud Drive on a Mac with
    /// iCloud Drive switched off lands in Documents, silently in behaviour and
    /// not in the interface.
    private func showFiles() {
        opensPopup.selectItem(withTitle: Prefs.noteMode.title)
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
                row: SettingsForm.index(of: .location, inGroupOf: SettingsForm.general) ?? 1,
                hidden: Prefs.noteHome == .iCloud)
            // The pane just got shorter or taller, so the window follows it.
            // Not animated: this is the consequence of a switch somebody just
            // moved, and a window sliding after every toggle draws attention
            // to the chrome rather than to the answer.
            fitWindowToPane(animated: false)
        }
        iCloudCaption.say(Prefs.iCloudAvailable
                          ? ""
                          : "iCloud Drive is off in System Settings, so notes stay on this Mac.",
                          bad: false)
    }

    /// Show which preset the stored command came from, or Custom.
    ///
    /// Custom is the ABSENCE of a match rather than a case of its own, so a
    /// command edited by a character stops claiming the preset it started
    /// from. The popup is a shortcut into the field below it, never a second
    /// place the setting lives.
    private func showAgentPreset() {
        let title = AgentPreset.matching(template: Prefs.agentCommand)?.title ?? Self.customPresetTitle
        agentPresetPopup.selectItem(withTitle: title)
    }

    /// Put the update row where this build actually stands.
    ///
    /// A development build cannot update itself, and the row says why rather
    /// than sitting there switched on and doing nothing: replacing it would
    /// delete the change it was installed to show.
    private func showAutoUpdate() {
        let canUpdate = AppFlavor.current.updatesItself
        updateSwitch.isEnabled = canUpdate
        updateButton.isEnabled = canUpdate
        updateSwitch.state = Prefs.autoUpdate && canUpdate ? .on : .off
        updateCaption.say(canUpdate
                          ? "Asks the project's own release page what the newest version is. Installing is always a click."
                          : "A development build does not replace itself.",
                          bad: false)
    }

    @objc private func toggleAutoUpdate() {
        Prefs.autoUpdate = updateSwitch.state == .on
    }

    @objc private func checkForUpdatesNow() {
        onCheckForUpdates()
    }

    /// The row that means "whatever is in the field below".
    private static let customPresetTitle = "Custom"

    /// Draw a screen from its declaration.
    ///
    /// `SettingsForm` says which rows a pane holds and in what order; this says
    /// what each row is wired to. Splitting them is what lets the first-run
    /// screen show a SUBSET under the same words without a second layout to
    /// keep in step: `WelcomeView` renders the same declaration with its own
    /// controls, and `SettingsFormTests` compares the two lists.
    private func render(_ groups: [SettingsGroup]) -> [NSView] {
        var sections: [NSView] = []
        for group in groups {
            if let heading = group.heading { sections.append(Self.heading(heading)) }
            let box = Self.group(group.rows.map { row in
                let (control, caption) = wiring(for: row)
                return Self.row(row, control: control, caption: caption)
            })
            // Remembered, because its Location row is shown and hidden by the
            // answer above it and the card has to be reachable to do that.
            if group.rows.contains(.location) { filesGroup = box }
            sections.append(box)
        }
        return sections
    }

    /// What each row is wired to. A switch over the enum, so a row added to
    /// `SettingsForm` fails to compile until it has a control.
    private func wiring(for row: SettingsRow) -> (NSView, Caption?) {
        switch row {
        case .summon: return (hotkeyRecorder, hotkeyCaption)
        case .storeInICloud: return (iCloudSwitch, iCloudCaption)
        case .location:
            return (Self.pathControl(scratchpadPath, self, #selector(chooseScratchpad)), nil)
        case .autosave: return (autosaveSwitch, nil)
        case .showInDock: return (dockSwitch, nil)
        case .startAtLogin:
            return (Self.pairedControl(loginSettingsButton, loginSwitch), loginCaption)
        case .richLinks: return (networkSwitch, networkCaption)
        case .opens: return (opensPopup, nil)
        case .agentPreset: return (agentPresetPopup, nil)
        case .agentCommand:
            return (agentField, Caption("What /ai runs. {prompt} is replaced by the request."))
        case .checkForUpdates:
            return (Self.pairedControl(updateButton, updateSwitch), updateCaption)
        case .resetSettings:
            return (resetButton, Caption("Back to defaults. Your notes are left where they are."))
        case .welcomeScreen:
            return (welcomeButton, Caption("The questions Jot asks the first time it runs."))
        }
    }

    private func buildPane(_ tab: Tab) -> NSView {
        if panes.isEmpty { wireControls() }
        let sections: [NSView]
        switch tab {
        case .general: sections = render(SettingsForm.general)
        case .advanced: sections = render(SettingsForm.advanced)
        }
        // After the sections exist, not before. `wireControls` runs at the top
        // of this method and `showFiles` hides a row of a card that this
        // method is about to build, so the sync above reaches a `filesGroup`
        // that is still nil and the Location row stays on screen with iCloud
        // Drive switched on.
        showFiles()
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

    static func heading(_ title: String) -> NSTextField {
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: NSFont.systemFontSize, weight: .semibold)
        return label
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

    /// A settings row: the name on the left, the control on the right, and an
    /// optional sentence under both.
    /// A settings row: the name on the left, the control on the right, and an
    /// optional sentence under both.
    ///
    /// The vertical axis is an NSStackView rather than constraints, and that is
    /// the whole reason it is one: NSStackView is the only thing here that
    /// takes a hidden view OUT of the layout. A caption that is empty right now
    /// but may fill later (the login row goes from silent to a warning) has to
    /// collapse to nothing meanwhile, and under plain constraints a hidden
    /// NSTextField keeps its line height and leaves a blank gap.
    /// The same row, labelled from the shared vocabulary. Every row on either
    /// screen goes through here, so a label has one spelling.
    static func row(_ row: SettingsRow, control: NSView, caption: Caption? = nil) -> NSView {
        self.row(row.rawValue, control: control, caption: caption)
    }

    static func row(_ title: String, control: NSView, caption: Caption? = nil) -> NSView {
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

        var arranged: [NSView] = [line]
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

        let stack = NSStackView(views: arranged)
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

    /// A button and its switch as one trailing control. The button is the
    /// occasional half: `isHidden` takes a view out of an NSStackView's layout
    /// entirely, so the switch sits alone at the trailing edge when there is
    /// nothing to say.
    private static func pairedControl(_ button: NSButton, _ toggle: NSSwitch) -> NSView {
        let stack = NSStackView(views: [button, toggle])
        stack.orientation = .horizontal
        stack.spacing = 8
        stack.alignment = .centerY
        return stack
    }

    // MARK: hotkey

    private func hotkeyChosen(_ combo: HotkeyCombo) {
        guard combo != Prefs.hotkey else { return }
        Prefs.hotkey = combo
        let status = onHotkeyChange()
        if status == 0 {
            hotkeyCaption.say("", bad: false)
        } else {
            hotkeyCaption.say("macOS refused \(combo.symbols); another app may own it.", bad: true)
        }
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
        showFiles()
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

    @objc private func chooseAgentPreset() {
        guard let preset = AgentPreset.allCases.first(where: { $0.title == agentPresetPopup.titleOfSelectedItem })
        else {
            // Custom: the field below is the setting, and it already holds
            // whatever it holds. Nothing to write.
            return showAgentPreset()
        }
        Prefs.agentCommand = preset.template
        agentField.stringValue = preset.template
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
        loginSwitch.state = state.isOn ? .on : .off
        loginSwitch.isEnabled = state.isEnabled
        loginSettingsButton.isHidden = state != .blocked
        loginCaption.say(state.caption, bad: state.isWarning)
    }

    @objc private func toggleLoginItem() {
        do {
            showLoginItem(try LoginItem.set(loginSwitch.state == .on))
        } catch {
            // Put the switch back where the system still has it, then say what
            // happened. A switch left where the user pushed it would claim a
            // registration that does not exist.
            showLoginItem(LoginItem.state)
            loginCaption.say("macOS refused: \(error.localizedDescription)", bad: true)
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
        guard (notification.object as? NSTextField) === agentField else { return }
        Prefs.agentCommand = agentField.stringValue
        // The popup follows the field, never the other way round: a command
        // edited by a character stops being the preset it started from, and a
        // menu still naming that preset would describe a field it no longer
        // matches.
        showAgentPreset()
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
