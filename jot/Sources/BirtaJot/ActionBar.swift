import AppKit

/// The row along the bottom of the panel: which file the bytes are going to,
/// and the overflow menu for everything that is not typing.
///
///     [ ~/…/Scratchpad.md                                          ] [ … ]
///
/// One buffer, one file, always being written. There are no terminal actions
/// here because the note has nowhere to terminate to: Jot edits a file the way
/// any editor edits a file, and Save As in the overflow writes a copy without
/// touching what is on screen.
///
/// The path follows the WINDOW'S FOCUS rather than the pointer. It answers
/// "where am I typing", which is a question only the person typing has, so it
/// belongs on screen exactly while this window is the one taking keys. The
/// overflow button follows the pointer with the rest of the chrome, because it
/// is something you reach for rather than read.
///
/// Native chrome rather than page chrome, on purpose. `webview/` is shared with
/// the extension, where the file being edited is VS Code's business and not the
/// editor's; keeping the row in AppKit is what lets Jot have it without the
/// editor growing a host-conditional footer, and it costs the bundle nothing.
@MainActor
final class ActionBar: NSView {
    static let height: CGFloat = 40

    /// Handed the button to hang the menu off, so the popup lands under it.
    var onOverflow: ((NSView) -> Void)?

    private let status = NSTextField(labelWithString: "")
    private let overflowButton = NSButton(title: "···", target: nil, action: nil)
    private var statusClear: DispatchWorkItem?
    /// What the status line says when nothing has just happened.
    private var restingText = ""
    private var windowIsFocused = false

    init() {
        super.init(frame: .zero)
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        wantsLayer = true

        overflowButton.bezelStyle = .rounded
        overflowButton.target = self
        overflowButton.action = #selector(overflow)
        // No key equivalent: the panel is a text editor with the caret in it,
        // and a default button would fire on Return.
        overflowButton.keyEquivalent = ""
        overflowButton.toolTip = "More actions"
        overflowButton.setAccessibilityLabel("More actions")

        // No hairline above the row, and nothing behind it: the bar is the
        // bottom of the page, not a panel bolted to it.
        status.textColor = .tertiaryLabelColor
        status.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        status.lineBreakMode = .byTruncatingMiddle
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        status.setContentHuggingPriority(.defaultLow, for: .horizontal)
        status.alphaValue = 0

        let row = NSStackView(views: [status, overflowButton])
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

    /// The file the buffer's bytes are going to, which is what the row says
    /// when it has nothing else to say.
    func setRestingText(_ text: String) {
        restingText = text
        if statusClear == nil { status.stringValue = text }
    }

    /// Say what just happened, briefly, then go back to naming the file.
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

    /// Fade the overflow button in while the pointer is over the window.
    func setChromeVisible(_ visible: Bool, animated: Bool = true) {
        setAlpha(visible ? 1 : 0, on: overflowButton, animated: animated)
    }

    /// Show the path exactly while this window is the one taking keys. A panel
    /// sitting over another app's window is a piece of that app's screen until
    /// you click it, and naming a file on it then is noise about somewhere you
    /// are not typing.
    func setWindowFocused(_ focused: Bool, animated: Bool = true) {
        guard focused != windowIsFocused else { return }
        windowIsFocused = focused
        setAlpha(focused ? 1 : 0, on: status, animated: animated)
    }

    private func setAlpha(_ alpha: CGFloat, on view: NSView, animated: Bool) {
        guard animated else {
            view.alphaValue = alpha
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            view.animator().alphaValue = alpha
        }
    }

    // MARK: actions

    @objc private func overflow() { onOverflow?(overflowButton) }
}
