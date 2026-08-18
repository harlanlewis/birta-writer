import AppKit

/// The chute's action row, along the bottom of the panel: what the note can be
/// turned into, next to where it was typed.
///
///     [ ~/…/Scratchpad.md            ] [ Copy and Delete ] [ Save ] [ … ]
///
/// At rest the row is just the file the bytes are going to, small and quiet.
/// The buttons fade in while the pointer is over the window and back out when
/// it leaves, so an untouched panel is a page and a cursor. A message about
/// what just happened takes the path's place for a few seconds.
///
/// The two terminal actions are siblings because they answer the same
/// question, "this note is finished, get it out of here", and differ only in
/// where the bytes go. Everything rarer is behind the overflow, built fresh on
/// each click by the app delegate, so nothing here has to be kept in step with
/// the buffer's state.
///
/// Native chrome rather than page chrome, on purpose. `webview/` is shared with
/// the extension, where a scratchpad's terminal actions mean nothing; keeping
/// the row in AppKit is what lets Jot have it without the editor growing a
/// host-conditional toolbar, and it costs the launch bundle nothing.
@MainActor
final class ActionBar: NSView {
    static let height: CGFloat = 40

    var onChute: (() -> Void)?
    var onSave: (() -> Void)?
    /// Handed the button to hang the menu off, so the popup lands under it.
    var onOverflow: ((NSView) -> Void)?

    private let status = NSTextField(labelWithString: "")
    private let chuteButton = NSButton(title: "Copy and Delete", target: nil, action: nil)
    private let saveButton = NSButton(title: "Save", target: nil, action: nil)
    private let overflowButton = NSButton(title: "···", target: nil, action: nil)
    private var statusClear: DispatchWorkItem?
    /// What the status line says when nothing has just happened.
    private var restingText = ""

    init() {
        super.init(frame: .zero)
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        wantsLayer = true

        for (button, action) in [(chuteButton, #selector(chute)), (saveButton, #selector(save)), (overflowButton, #selector(overflow))] {
            button.bezelStyle = .rounded
            button.target = self
            button.action = action
            // No key equivalent on any of them. The panel is a text editor with
            // the caret in it, and a default button would fire on Return.
            button.keyEquivalent = ""
        }
        chuteButton.toolTip = "Copy the whole note to the clipboard, then clear it"
        saveButton.toolTip = "Save the note to the default destination"
        overflowButton.toolTip = "More actions"
        overflowButton.setAccessibilityLabel("More actions")

        // No hairline above the row, and nothing behind it: the bar is the
        // bottom of the page, not a panel bolted to it.
        status.textColor = .tertiaryLabelColor
        status.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        status.lineBreakMode = .byTruncatingMiddle
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        status.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let row = NSStackView(views: [status, chuteButton, saveButton, overflowButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false

        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(equalToConstant: ActionBar.height),
        ])
        setChromeVisible(false, animated: false)
    }

    // MARK: state

    /// - Parameters:
    ///   - chuteTitle: "Copy and Delete", or "Copy" when the buffer is a
    ///     document the chute may not empty.
    ///   - hasContent: an empty note has nothing to copy or save.
    func update(chuteTitle: String, hasContent: Bool) {
        chuteButton.title = chuteTitle
        chuteButton.isEnabled = hasContent
        saveButton.isEnabled = hasContent
    }

    /// The file the buffer's bytes are going to, which is what the row says
    /// when it has nothing else to say.
    func setRestingText(_ text: String) {
        restingText = text
        if statusClear == nil { status.stringValue = text }
    }

    /// Say what just happened, briefly, then go back to naming the file. The
    /// message is a confirmation, not a control: an action whose undo matters
    /// puts that undo in the overflow menu, where it stays until it is used.
    func flash(_ message: String) {
        statusClear?.cancel()
        status.stringValue = message
        let clear = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.statusClear = nil
            self.status.stringValue = self.restingText
        }
        statusClear = clear
        DispatchQueue.main.asyncAfter(deadline: .now() + 6, execute: clear)
    }

    /// Fade the buttons in while the pointer is over the window. The status
    /// line is not chrome and stays: it is one quiet line naming the file, and
    /// a panel that forgets which file it is writing to is worse than a bare
    /// one.
    func setChromeVisible(_ visible: Bool, animated: Bool = true) {
        let alpha: CGFloat = visible ? 1 : 0
        let buttons = [chuteButton, saveButton, overflowButton]
        guard animated else {
            for button in buttons { button.alphaValue = alpha }
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            for button in buttons { button.animator().alphaValue = alpha }
        }
    }

    // MARK: actions

    @objc private func chute() { onChute?() }
    @objc private func save() { onSave?() }
    @objc private func overflow() { onOverflow?(overflowButton) }
}
