import AppKit

/// The panel, given over to saying the file is gone and offering the ways out.
///
///     Jot 2026-08-26.md doesn't exist
///     It may have been deleted or moved. What you were writing is
///     still on screen and is not saved anywhere else.
///
///     [Save It Back]  [Discard and Start New]  [Open Recent…]
///
/// A SCREEN rather than a strip along the bottom edge, and the change is the
/// whole point of this file. The strip said the same words in the smallest
/// type on the window, at the edge furthest from where anybody was looking,
/// beside two buttons that read as two ways of making a file. It is the state
/// where somebody's only copy of a note is in memory, and it looked like a
/// status line.
///
/// The strip's own argument for staying out of the way was that the text
/// underneath is what is at risk, so covering it would be perverse. That was
/// right about what matters and wrong about what follows: what protects the
/// text is SAYING it is at risk and offering to write it, which needs the
/// room this takes. Covering it costs nothing while the offer is on screen.
///
/// Not `StatusOverlay`, which sits a few points away and looks like the
/// obvious home. Its own header states its rule: "News, never state. Nothing
/// here is a control and nothing here persists." This is the opposite of
/// both. It is a STATE, held until it is answered, and it exists to carry
/// controls.
@MainActor
final class MissingFileScreen: NSView {
    /// Write the buffer back to the path it came from, recreating the file.
    var onSaveItBack: (() -> Void)?
    /// Throw the buffer away and start a fresh note.
    var onDiscardAndStartNew: (() -> Void)?
    /// Offer the list of files this app has had open.
    var onOpenRecent: ((NSView) -> Void)?

    private let heading = NSTextField(labelWithString: "")
    private let body = NSTextField(labelWithString: "")
    private let saveButton = NSButton(title: "Save It Back", target: nil, action: nil)
    private let newButton = NSButton(title: "", target: nil, action: nil)
    private let recentButton = NSButton(title: "Open Recent…", target: nil, action: nil)
    private var column: NSStackView?

    init() {
        super.init(frame: .zero)
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// The system's own ground, so the screen follows the theme without this
    /// file choosing a colour.
    ///
    /// Drawn rather than set on the layer. `NSColor.controlBackgroundColor` is
    /// dynamic and `.cgColor` resolves it once, so a layer fill is frozen at
    /// whichever appearance was current when this was built and keeps the old
    /// ground across a light/dark switch. Drawing also puts it into
    /// `Coordinator.writeSnapshot`, whose PDF path runs `draw(_:)` and copies
    /// no layer.
    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlBackgroundColor.setFill()
        dirtyRect.fill()
    }

    private func build() {
        heading.font = .systemFont(ofSize: NSFont.systemFontSize + 6, weight: .semibold)
        heading.alignment = .center
        heading.lineBreakMode = .byTruncatingMiddle
        body.font = .systemFont(ofSize: NSFont.systemFontSize)
        body.textColor = .secondaryLabelColor
        body.alignment = .center
        body.usesSingleLineMode = false
        body.lineBreakMode = .byWordWrapping
        body.preferredMaxLayoutWidth = 380

        for button in [saveButton, newButton, recentButton] {
            button.bezelStyle = .rounded
            button.target = self
        }
        saveButton.action = #selector(saveItBack)
        newButton.action = #selector(newNote)
        recentButton.action = #selector(openRecent)
        // NO key equivalent on any of them, and Return is the one that matters.
        // `performKeyEquivalent` walks the key window's whole content view
        // before a key reaches the first responder, and this screen lives in
        // that hierarchy above a live editor. A default button here would
        // swallow every Return typed into the note behind it. It is up exactly
        // when the buffer is the only copy of the text, which makes it the
        // worst place in the app to take a key away.

        let buttons = NSStackView(views: [saveButton, newButton, recentButton])
        buttons.orientation = .horizontal
        buttons.spacing = 12

        let stack = NSStackView(views: [heading, body, buttons])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.setCustomSpacing(20, after: body)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        column = stack
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -48),
        ])
        isHidden = true
    }

    /// What the screen says, and which ways out it offers.
    ///
    /// `hasUnsavedText` is the whole of the difference, and it is a fact about
    /// the BUFFER rather than about the file: the file is gone either way, so
    /// what decides the offer is whether anything on screen exists nowhere
    /// else. With text to lose, saving it is the first thing offered and the
    /// button that throws it away is named for what it costs. With nothing to
    /// lose, neither belongs: an offer to save an empty buffer writes an empty
    /// file, and a warning about discarding nothing is a warning people learn
    /// to click through.
    func show(_ shown: Bool, name: String = "", hasUnsavedText: Bool = false) {
        isHidden = !shown
        guard shown else { return }
        heading.stringValue = "\(name) doesn't exist"
        body.stringValue = hasUnsavedText
            ? "It may have been deleted or moved. What you were writing is still on screen, and is not saved anywhere else."
            : "It may have been deleted or moved."
        saveButton.isHidden = !hasUnsavedText
        // Named for what it COSTS when there is a cost, and for what it makes
        // when there is not. A button called New Note beside unsaved text is a
        // label that tells the half of the sentence that sounds good.
        newButton.title = hasUnsavedText ? "Discard and Start New" : "New Note"
        column?.needsLayout = true
    }

    /// Nothing outside the screen takes a click, so a hidden one is never a
    /// dead sheet over the panel.
    override func hitTest(_ point: NSPoint) -> NSView? {
        isHidden ? nil : super.hitTest(point)
    }

    /// What a check reads instead of a screenshot: what is said, and what is
    /// offered. The TITLES rather than a count, because three buttons and the
    /// wrong three is the failure a count cannot see.
    var stateForMeasurement: (heading: String, body: String, buttons: [String]) {
        (heading.stringValue,
         body.stringValue,
         [saveButton, newButton, recentButton].filter { !$0.isHidden }.map(\.title))
    }

    /// One of the buttons by the title it is showing, so a check can press
    /// what a reader would press rather than reach for a stored property and
    /// press something that is not on screen.
    func buttonForMeasurement(titled title: String) -> NSButton? {
        [saveButton, newButton, recentButton].first { !$0.isHidden && $0.title == title }
    }

    @objc private func saveItBack() { onSaveItBack?() }
    @objc private func newNote() { onDiscardAndStartNew?() }
    @objc private func openRecent() { onOpenRecent?(recentButton) }
}
