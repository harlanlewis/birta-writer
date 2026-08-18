import AppKit

/// The chute's action row, along the bottom of the panel: what the note can be
/// turned into, next to where it was typed.
///
///     [ status                       ] [ Copy and Delete ] [ Save ] [ … ]
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

        status.textColor = .secondaryLabelColor
        status.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        status.lineBreakMode = .byTruncatingMiddle
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        status.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let separator = NSBox()
        separator.boxType = .separator
        separator.translatesAutoresizingMaskIntoConstraints = false

        let row = NSStackView(views: [status, chuteButton, saveButton, overflowButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false

        addSubview(separator)
        addSubview(row)
        NSLayoutConstraint.activate([
            separator.leadingAnchor.constraint(equalTo: leadingAnchor),
            separator.trailingAnchor.constraint(equalTo: trailingAnchor),
            separator.topAnchor.constraint(equalTo: topAnchor),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(equalToConstant: ActionBar.height),
        ])
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

    /// Say what just happened, briefly. The message is a confirmation, not a
    /// control: an action whose undo matters puts that undo in the overflow
    /// menu, where it stays until it is used.
    func flash(_ message: String) {
        statusClear?.cancel()
        status.stringValue = message
        let clear = DispatchWorkItem { [weak self] in self?.status.stringValue = "" }
        statusClear = clear
        DispatchQueue.main.asyncAfter(deadline: .now() + 6, execute: clear)
    }

    // MARK: actions

    @objc private func chute() { onChute?() }
    @objc private func save() { onSave?() }
    @objc private func overflow() { onOverflow?(overflowButton) }
}
