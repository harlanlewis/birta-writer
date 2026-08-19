import AppKit

/// A transient line in the panel's bottom trailing corner, for the things Jot
/// has just done: "Saved.", "New note.", "Copy saved to Notes.md."
///
///                                              [ Saved. ]
///
/// It floats OVER the web view rather than taking a row of its own. A strip
/// with a permanent claim on the window's bottom edge would be paying full
/// height for a line that is empty almost always, and the two corners down
/// there are spoken for: the page's formatting dock has the leading one, and
/// the file's name has moved up to the titlebar where macOS keeps it.
///
/// Trailing rather than leading, so a message and the dock never sit on top of
/// each other however wide the dock's row has been scrolled.
///
/// News, never state. Nothing here is a control and nothing here persists: a
/// message says what just happened, waits, and goes. Anything the user might
/// want to ACT on belongs in the menu bar, where a person looks for it.
@MainActor
final class StatusOverlay: NSView {
    private let status = NSTextField(labelWithString: "")
    private var clear: DispatchWorkItem?

    init() {
        super.init(frame: .zero)
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        status.textColor = .tertiaryLabelColor
        status.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        status.lineBreakMode = .byTruncatingTail
        status.alphaValue = 0
        status.translatesAutoresizingMaskIntoConstraints = false
        addSubview(status)
        // The label sizes the overlay, which grows leftward from the window's
        // trailing edge. A long message is truncated at the head rather than
        // allowed to reach the dock in the opposite corner; the caller bounds
        // it (Coordinator pins the leading edge).
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        NSLayoutConstraint.activate([
            status.leadingAnchor.constraint(equalTo: leadingAnchor),
            status.trailingAnchor.constraint(equalTo: trailingAnchor),
            status.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    /// Nothing here takes a click, so the pointer goes to the document under
    /// it. Without this the corner would be a dead patch of window for six
    /// seconds after every save.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// Say what just happened, briefly, then go quiet.
    func flash(_ message: String) {
        self.clear?.cancel()
        status.stringValue = message
        setAlpha(1)
        let clear = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.clear = nil
            self.setAlpha(0)
        }
        self.clear = clear
        DispatchQueue.main.asyncAfter(deadline: .now() + 6, execute: clear)
    }

    private func setAlpha(_ alpha: CGFloat) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            status.animator().alphaValue = alpha
        }
    }
}
