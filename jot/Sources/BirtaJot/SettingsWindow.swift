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
    private enum Tab: String, CaseIterable {
        case general, editor, advanced

        var title: String {
            switch self {
            case .general: return "General"
            case .editor: return "Editor"
            case .advanced: return "Advanced"
            }
        }

        var symbol: String {
            switch self {
            case .general: return "gearshape"
            case .editor: return "textformat"
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
    private let documentPath = PathLabel(Prefs.documentURL)
    private let documentSwitch = NSSwitch()
    private let documentChoose = NSButton(title: "Choose…", target: nil, action: nil)
    private let networkSwitch = NSSwitch()
    private let agentField = NSTextField(string: Prefs.agentCommand)
    private let pathSwitch = NSSwitch()
    private let formatToolbarSwitch = NSSwitch()
    private let blankSwitch = NSSwitch()
    private let autosaveSwitch = NSSwitch()
    private let floatSwitch = NSSwitch()
    private let loginSwitch = NSSwitch()
    private let loginCaption = Caption(LoginItemState.off.caption)
    private let loginSettingsButton = NSButton(title: "Open System Settings…", target: nil, action: nil)

    private let onHotkeyChange: () -> OSStatus
    private let onChange: () -> Void

    init(onHotkeyChange: @escaping () -> OSStatus, onChange: @escaping () -> Void) {
        self.onHotkeyChange = onHotkeyChange
        self.onChange = onChange
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: Metrics.content + Metrics.windowPadding * 2, height: 300),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        // The app's name, not the pane's. A multi-pane settings window titles
        // itself after the selected pane, and that rule assumes the app is
        // named somewhere else on screen; Jot is an accessory app with no Dock
        // icon, so "General" alone belongs to nothing the user can see. The
        // toolbar below the title already names and highlights the pane.
        window.title = "Birta Jot Settings"
        // The panel floats, so a settings window at the ordinary level opens
        // BEHIND the window it was opened from. Match the panel's level, which
        // is the setting's level, so turning floating off lowers both together
        // rather than leaving Settings stranded above everything.
        window.level = Prefs.floatAboveOtherWindows ? .floating : .normal
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
        guard let window else { return }
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
        pane.layoutSubtreeIfNeeded()
        let wanted = min(pane.fittingSize.height, Metrics.maxPaneHeight)
        let frame = window.frameRect(forContentRect: NSRect(
            x: 0, y: 0, width: Metrics.content + Metrics.windowPadding * 2, height: wanted))
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

    @objc private func selectTab(_ sender: NSToolbarItem) {
        guard let tab = Tab(rawValue: sender.itemIdentifier.rawValue) else { return }
        show(tab, animated: true)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: content

    /// Wire every control once, whichever pane ends up holding it.
    private func wireControls() {
        hotkeyRecorder.onCombo = { [weak self] combo in self?.hotkeyChosen(combo) }

        documentSwitch.state = Prefs.documentURL == nil ? .off : .on
        documentChoose.target = self
        documentChoose.action = #selector(chooseDocument)
        documentChoose.isEnabled = Prefs.documentURL != nil
        documentPath.isDimmed = Prefs.documentURL == nil

        agentField.placeholderString = "claude -p {prompt}"
        agentField.delegate = self
        agentField.font = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        agentField.widthAnchor.constraint(equalToConstant: 260).isActive = true

        loginSettingsButton.target = self
        loginSettingsButton.action = #selector(openLoginItemSettings)
        loginSettingsButton.controlSize = .small

        for (control, on, action) in [
            (documentSwitch, Prefs.documentURL != nil, #selector(toggleDocument)),
            (networkSwitch, Prefs.networkEnabled, #selector(toggleNetwork)),
            (autosaveSwitch, Prefs.autosave, #selector(toggleAutosave)),
            (floatSwitch, Prefs.floatAboveOtherWindows, #selector(toggleFloat)),
            (pathSwitch, Prefs.showFilePath, #selector(togglePath)),
            (formatToolbarSwitch, Prefs.showFormattingToolbar, #selector(toggleFormatToolbar)),
            (blankSwitch, Prefs.openToBlankNote, #selector(toggleOpenToBlank)),
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
        showLoginItem(LoginItem.state)
    }

    private func buildPane(_ tab: Tab) -> NSView {
        if panes.isEmpty { wireControls() }
        let sections: [NSView]
        switch tab {
        case .general:
            sections = [
                Self.heading("Startup"),
                Self.group([
                    Self.row("Open at login", control: Self.pairedControl(loginSettingsButton, loginSwitch),
                             caption: loginCaption),
                    Self.row("Start with a blank note", control: blankSwitch),
                ]),
                Self.heading("Panel"),
                Self.group([
                    Self.row("Float above other windows", control: floatSwitch),
                    Self.row("Summon Jot", control: hotkeyRecorder, caption: hotkeyCaption),
                ]),
                Self.heading("Network"),
                Self.group([
                    Self.row("Fetch from the web", control: networkSwitch,
                             caption: Caption("Off means no outbound request. On enables embeds, link cards and pasted-link titles.")),
                ]),
            ]
        case .editor:
            sections = [
                Self.heading("Editing"),
                Self.group([
                    Self.row("Autosave", control: autosaveSwitch,
                             caption: Caption("Cmd+S, hiding and quitting write either way.")),
                ]),
                Self.heading("Chrome"),
                Self.group([
                    Self.row("Show formatting toolbar", control: formatToolbarSwitch),
                    Self.row("Show file path", control: pathSwitch),
                ]),
            ]
        case .advanced:
            sections = [
                Self.heading("Files"),
                Self.group([
                    Self.row("Scratchpad", control: Self.pathControl(scratchpadPath, self, #selector(chooseScratchpad))),
                    Self.row("Edit a document instead", control: documentSwitch,
                             caption: Caption("Jot edits that file rather than the scratchpad.")),
                    Self.row("Document", control: Self.pathControl(documentPath, documentChoose)),
                ]),
                Self.heading("Agent"),
                Self.group([
                    Self.row("Command", control: agentField,
                             caption: Caption("What /ai runs. {prompt} is replaced by the request.")),
                ]),
            ]
        }
        return Self.pane(sections)
    }

    /// One pane: sections down the page, padded, sized to its content.
    private static func pane(_ sections: [NSView]) -> NSView {
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

    private static func heading(_ title: String) -> NSTextField {
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: NSFont.systemFontSize, weight: .semibold)
        return label
    }

    /// One rounded section. Rows are separated by a hairline, inset from the
    /// leading edge the way a grouped list insets its separators.
    private static func group(_ rows: [NSView]) -> NSView {
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
    private static func row(_ title: String, control: NSView, caption: Caption? = nil) -> NSView {
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
    private static func pathControl(_ path: PathLabel, _ button: NSButton) -> NSView {
        let stack = NSStackView(views: [path, button])
        stack.orientation = .horizontal
        stack.spacing = 8
        stack.alignment = .centerY
        return stack
    }

    private static func pathControl(_ path: PathLabel, _ target: AnyObject, _ action: Selector) -> NSView {
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

    @objc private func chooseScratchpad() {
        let panel = NSSavePanel()
        panel.title = "Scratchpad location"
        panel.nameFieldStringValue = Prefs.scratchpadURL.lastPathComponent
        panel.directoryURL = Prefs.scratchpadURL.deletingLastPathComponent()
        panel.allowedContentTypes = [.init(filenameExtension: "md") ?? .plainText]
        panel.beginSheetModal(for: window!) { [weak self] resp in
            guard resp == .OK, let url = panel.url, let self else { return }
            Prefs.scratchpadURL = url
            self.scratchpadPath.setURL(url)
            self.onChange()
        }
    }


    @objc private func chooseDocument() {
        let panel = NSOpenPanel()
        panel.title = "Document to open"
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.init(filenameExtension: "md") ?? .plainText, .plainText]
        panel.beginSheetModal(for: window!) { [weak self] resp in
            guard resp == .OK, let url = panel.url, let self else { return }
            Prefs.documentURL = url
            self.documentSwitch.state = .on
            self.documentPath.setURL(url)
            self.setDocumentRowEnabled(true)
            self.onChange()
        }
    }

    @objc private func toggleDocument() {
        if documentSwitch.state == .off {
            Prefs.documentURL = nil
            documentPath.setURL(nil)
            setDocumentRowEnabled(false)
            onChange()
        } else if Prefs.documentURL == nil {
            chooseDocument()
        } else {
            setDocumentRowEnabled(true)
        }
    }

    private func setDocumentRowEnabled(_ enabled: Bool) {
        documentChoose.isEnabled = enabled
        documentPath.isDimmed = !enabled
    }

    // MARK: login item

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
    }

    /// Committed on every edit rather than only on Return: the window has no
    /// OK button, and a command typed and then dismissed by closing the window
    /// would otherwise be lost without a word.
    func controlTextDidChange(_ notification: Notification) {
        guard (notification.object as? NSTextField) === agentField else { return }
        Prefs.agentCommand = agentField.stringValue
    }

    @objc private func togglePath() {
        Prefs.showFilePath = pathSwitch.state == .on
        onChange()
    }

    @objc private func toggleFormatToolbar() {
        Prefs.showFormattingToolbar = formatToolbarSwitch.state == .on
        onChange()
    }

    @objc private func toggleOpenToBlank() {
        Prefs.openToBlankNote = blankSwitch.state == .on
    }

    @objc private func toggleAutosave() {
        Prefs.autosave = autosaveSwitch.state == .on
    }

    /// The panel's level, and the Settings window's with it: this window opens
    /// from the panel, so leaving it above while the panel drops would strand
    /// it over every other app.
    @objc private func toggleFloat() {
        Prefs.floatAboveOtherWindows = floatSwitch.state == .on
        window?.level = Prefs.floatAboveOtherWindows ? .floating : .normal
        onChange()
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
