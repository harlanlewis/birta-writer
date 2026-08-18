import AppKit
import BirtaJotCore

/// Jot's Settings window.
///
/// Built to the shape System Settings uses: sections with a heading, rows in a
/// rounded group, the label leading and its control trailing, and a caption
/// under a row when the setting needs a sentence rather than a name. The
/// previous window put every label in a right-aligned column against controls
/// of four different widths, which is the older Preferences grid and reads as
/// one long form rather than as settings.
///
/// Everything is built in code. A window this size does not earn a nib, and a
/// nib is the one part of the app a script cannot diff.
@MainActor
final class SettingsWindowController: NSWindowController, NSWindowDelegate, NSTextFieldDelegate {
    /// The window's one width, and the insets every row shares. A caption has
    /// to be told the width it wraps at before the first layout pass, or the
    /// window sizes itself around a one-line caption and clips the rest.
    enum Metrics {
        static let content: CGFloat = 520
        static let rowInset: CGFloat = 14
        static let windowPadding: CGFloat = 20
        static var captionWidth: CGFloat { content - rowInset * 2 }
    }

    private let hotkeyRecorder = HotkeyRecorderView(combo: Prefs.hotkey)
    private let hotkeyCaption = Caption("Press the combination that summons the panel from any app.")
    private let scratchpadPath = PathLabel(Prefs.scratchpadURL)
    private let documentPath = PathLabel(Prefs.documentURL)
    private let documentSwitch = NSSwitch()
    private let documentChoose = NSButton(title: "Choose…", target: nil, action: nil)
    private let networkSwitch = NSSwitch()
    private let agentField = NSTextField(string: Prefs.agentCommand)
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
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 420),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Birta Jot Settings"
        window.isReleasedWhenClosed = false
        // The panel floats, so a settings window at the ordinary level opens
        // BEHIND the window it was opened from. Match the panel's level, which
        // is the setting's level, so turning floating off lowers both together
        // rather than leaving Settings stranded above everything.
        window.level = Prefs.floatAboveOtherWindows ? .floating : .normal
        super.init(window: window)
        window.delegate = self
        let content = buildContent()
        window.contentView = content
        window.setContentSize(content.fittingSize)
        window.center()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: content

    private func buildContent() -> NSView {
        hotkeyRecorder.onCombo = { [weak self] combo in self?.hotkeyChosen(combo) }

        documentSwitch.state = Prefs.documentURL == nil ? .off : .on
        documentSwitch.target = self
        documentSwitch.action = #selector(toggleDocument)
        documentChoose.target = self
        documentChoose.action = #selector(chooseDocument)
        documentChoose.isEnabled = Prefs.documentURL != nil
        documentPath.isDimmed = Prefs.documentURL == nil
        networkSwitch.state = Prefs.networkEnabled ? .on : .off
        networkSwitch.target = self
        networkSwitch.action = #selector(toggleNetwork)
        autosaveSwitch.state = Prefs.autosave ? .on : .off
        autosaveSwitch.target = self
        autosaveSwitch.action = #selector(toggleAutosave)
        agentField.placeholderString = "claude -p {prompt} --permission-mode acceptEdits"
        agentField.delegate = self
        agentField.font = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        agentField.widthAnchor.constraint(equalToConstant: 300).isActive = true
        floatSwitch.state = Prefs.floatAboveOtherWindows ? .on : .off
        floatSwitch.target = self
        floatSwitch.action = #selector(toggleFloat)

        loginSwitch.target = self
        loginSwitch.action = #selector(toggleLoginItem)
        loginSettingsButton.target = self
        loginSettingsButton.action = #selector(openLoginItemSettings)
        loginSettingsButton.controlSize = .small
        showLoginItem(LoginItem.state)

        let sections = NSStackView(views: [
            Self.heading("General"),
            Self.group([
                Self.row("Open at login", control: Self.pairedControl(loginSettingsButton, loginSwitch),
                         caption: loginCaption),
                Self.row("Float above other windows", control: floatSwitch,
                         caption: Caption("Keep the panel over other apps' windows, so a note summoned over what you are reading stays in front of it.")),
                Self.row("Autosave", control: autosaveSwitch,
                         caption: Caption("Write to the file as you type. Turning it off does not risk the note: hiding the panel and quitting still write, and Cmd+S writes whenever you ask.")),
            ]),
            Self.heading("Hotkey"),
            Self.group([
                Self.row("Summon Jot", control: hotkeyRecorder, caption: hotkeyCaption),
            ]),
            Self.heading("Files"),
            Self.group([
                Self.row("Scratchpad", control: Self.pathControl(scratchpadPath, self, #selector(chooseScratchpad))),
                Self.row("Edit a document instead", control: documentSwitch,
                         caption: Caption("Jot edits that file rather than the scratchpad. Everything else is the same: it is autosaved, Cmd+S writes it, and saving a copy leaves it alone.")),
                Self.row("Document", control: Self.pathControl(documentPath, documentChoose)),
            ]),
            Self.heading("Agent"),
            Self.group([
                Self.row("Command", control: agentField,
                         caption: Caption("What `/ai` runs, with {prompt} where the quoted request goes. The same shape as the extension's birta.agent.command, so a command tuned there works here unchanged. Jot writes the note to disk first and reloads it when the run finishes.")),
            ]),
            Self.heading("Network"),
            Self.group([
                Self.row("Fetch from the web", control: networkSwitch,
                         caption: Caption("Off by default, and off means no outbound request at all. When on, an embed loads from its provider, a link on its own line can show the page's own title and description, and pasting a URL offers you the page's title as the link text.")),
            ]),
        ])
        sections.orientation = .vertical
        sections.alignment = .leading
        sections.spacing = 10
        // After each group, so the next heading starts a section rather than
        // reading as a caption on the group above it.
        for (index, view) in sections.arrangedSubviews.enumerated() where view is NSBox {
            if index + 1 < sections.arrangedSubviews.count { sections.setCustomSpacing(20, after: view) }
        }
        sections.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView()
        container.addSubview(sections)
        NSLayoutConstraint.activate([
            sections.topAnchor.constraint(equalTo: container.topAnchor, constant: Metrics.windowPadding),
            sections.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: Metrics.windowPadding),
            sections.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -Metrics.windowPadding),
            sections.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -Metrics.windowPadding),
            sections.widthAnchor.constraint(equalToConstant: Metrics.content),
        ])
        // A leading-aligned vertical stack sizes each arranged view to its own
        // content; the groups are the full width and only the headings sit at
        // their own.
        for view in sections.arrangedSubviews where view is NSBox {
            view.widthAnchor.constraint(equalTo: sections.widthAnchor).isActive = true
        }
        return container
    }

    // MARK: pieces

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
        box.borderWidth = 0
        box.cornerRadius = 10
        box.fillColor = .controlBackgroundColor
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
    private static func row(_ title: String, control: NSView, caption: NSTextField? = nil) -> NSView {
        let label = NSTextField(labelWithString: title)
        let row = NSView()
        for view in [label, control] {
            view.translatesAutoresizingMaskIntoConstraints = false
            row.addSubview(view)
        }
        label.setContentCompressionResistancePriority(.required, for: .horizontal)
        label.setContentHuggingPriority(.required, for: .horizontal)

        var constraints: [NSLayoutConstraint] = [
            label.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: Metrics.rowInset),
            label.topAnchor.constraint(equalTo: row.topAnchor, constant: 10),
            control.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -Metrics.rowInset),
            control.centerYAnchor.constraint(equalTo: label.centerYAnchor),
            control.leadingAnchor.constraint(greaterThanOrEqualTo: label.trailingAnchor, constant: 12),
            control.topAnchor.constraint(greaterThanOrEqualTo: row.topAnchor, constant: 8),
        ]
        if let caption {
            caption.translatesAutoresizingMaskIntoConstraints = false
            row.addSubview(caption)
            constraints += [
                caption.leadingAnchor.constraint(equalTo: label.leadingAnchor),
                caption.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -Metrics.rowInset),
                caption.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 4),
                row.bottomAnchor.constraint(equalTo: caption.bottomAnchor, constant: 10),
                row.bottomAnchor.constraint(greaterThanOrEqualTo: control.bottomAnchor, constant: 8),
            ]
        } else {
            constraints += [
                row.bottomAnchor.constraint(equalTo: label.bottomAnchor, constant: 10),
                row.bottomAnchor.constraint(greaterThanOrEqualTo: control.bottomAnchor, constant: 8),
            ]
        }
        NSLayoutConstraint.activate(constraints)
        return row
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
            hotkeyCaption.say("Press the combination that summons the panel from any app.", bad: false)
        } else {
            hotkeyCaption.say("macOS refused \(combo.symbols) (status \(status)); another app may own it. Jot has no hotkey until this is fixed.", bad: true)
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

    func say(_ text: String, bad: Bool) {
        stringValue = text
        textColor = bad ? .systemRed : .secondaryLabelColor
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
