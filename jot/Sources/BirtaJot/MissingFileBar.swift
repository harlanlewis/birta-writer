import AppKit

/// A bar along the bottom of the panel saying the note is gone, with the two
/// things a person can do about it.
///
///     The note was deleted. Nothing has been written.   [Save It Back] [Discard and Start New]
///
/// Not `StatusOverlay`, which sits a few points away and looks like the
/// obvious home for this. Its own header states its rule: "News, never state.
/// Nothing here is a control and nothing here persists." This is the opposite
/// of both. It is a STATE, held until it is answered, and it exists to carry
/// two controls. A message that faded would take the only route back with it,
/// and a person who stepped away would return to a panel that had silently
/// stopped saving.
///
/// It takes the room rather than floating over the text, because the text
/// under it is exactly what is at risk and covering that would be perverse.
@MainActor
final class MissingFileBar: NSView {
    static let height: CGFloat = 34

    var onSaveItBack: (() -> Void)?
    var onDiscardAndStartNew: (() -> Void)?

    private let label = NSTextField(labelWithString: "")
    private let saveButton = NSButton(title: "Save It Back", target: nil, action: nil)
    /// Named for what it costs, not for what it makes. The buffer is the only
    /// copy of the deleted note's text, and this is the one button on the
    /// panel that throws it away; a button called New Note would be a button
    /// whose label is the half of the sentence that sounds good.
    private let newButton = NSButton(title: "Discard and Start New", target: nil, action: nil)

    init() {
        super.init(frame: .zero)
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        wantsLayer = true
        // The system's own warning ground, so it follows the theme and reads
        // as a warning without this file choosing a colour.
        layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor

        label.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        for button in [saveButton, newButton] {
            button.controlSize = .small
            button.bezelStyle = .rounded
            button.target = self
        }
        saveButton.action = #selector(saveItBack)
        newButton.action = #selector(newNote)
        // NO key equivalent on either button, and Return is the one that
        // matters. `performKeyEquivalent` walks the key window's whole content
        // view before a key reaches the first responder, and this bar is in
        // that hierarchy above a live editor, so a default button here would
        // swallow every Return the user typed into their note and run Save It
        // Back instead. The bar is up exactly when the buffer is the only copy
        // of the text, which makes it the worst place to take a key away.

        let row = NSStackView(views: [label, saveButton, newButton])
        row.orientation = .horizontal
        row.spacing = 8
        row.alignment = .centerY
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        isHidden = true
    }

    /// Show the bar for `name`, or hide it.
    ///
    /// The name is in the sentence because a person with several notes needs
    /// to know which one this is about, and the titlebar still shows a file
    /// that is no longer there.
    func show(_ shown: Bool, name: String = "") {
        label.stringValue = shown
            ? "\(name) was deleted. Nothing has been written since."
            : ""
        isHidden = !shown
    }

    /// Nothing outside the bar takes a click, so a hidden bar is never a dead
    /// strip across the panel.
    override func hitTest(_ point: NSPoint) -> NSView? {
        isHidden ? nil : super.hitTest(point)
    }

    @objc private func saveItBack() { onSaveItBack?() }
    @objc private func newNote() { onDiscardAndStartNew?() }
}
