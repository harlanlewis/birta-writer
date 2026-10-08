import AppKit

/// What a window shows between somebody confirming an update and the app
/// quitting to put it in: the document dimmed and out of reach, and a card in
/// the bottom trailing corner saying what is happening.
///
///     ┌──────────────────────────────────────────┐
///     │░░░░░░░░░░░ the note, dimmed ░░░░░░░░░░░░░│
///     │░░░░░░░░░░░░░░░░░░░░░░░░░░░░┌────────────┐│
///     │░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ ◌ Download…││
///     │░░░░░░░░░░░░░░░░░░░░░░░░░░░░│   restarts ││
///     │░░░░░░░░░░░░░░░░░░░░░░░░░░░░└────────────┘│
///     └──────────────────────────────────────────┘
///
/// The confirming sheet closes the moment it is answered, and the download,
/// the check and the unpack all happen after it. Without this the window went
/// back to looking exactly as it did before the question, and stayed that way
/// until the app vanished, which is indistinguishable from a button that was
/// ignored.
///
/// State, not news, which is why it is not `StatusOverlay`: that line goes by
/// itself after a few seconds and must never read as a control, while this
/// stays until the phase ends and has to be found by somebody looking for an
/// answer. So it is a framed card with a spinner, and it is indeterminate
/// because the updater reports phases rather than bytes.
///
/// The cover takes every click and every key aimed at the page, because the
/// page is about to be serialized and quit out from under, and anything typed
/// meanwhile is a keystroke the person may believe was lost. A drag on it
/// still moves the window, through `performDrag` for the reason
/// `TitlebarDrag` gives.
@MainActor
final class UpdateProgressCover: NSView {
    /// The ground laid over the page: its own paper, mostly opaque, so the
    /// note reads as set aside rather than gone and no colour is invented.
    static let dimAlpha: CGFloat = 0.6
    /// The card's distance from the window's trailing and bottom edges, the
    /// same inset the status line keeps from the trailing one.
    static let inset: CGFloat = 14

    /// Opaque, in the page's own paper. Not a vibrancy material: one blended
    /// within the window lets the dimmed paragraphs behind the card show
    /// through its words, which is the one place the page must not be read.
    let card = NSView()
    private let spinner = NSProgressIndicator()
    let titleLabel = NSTextField(labelWithString: "")
    let detailLabel = NSTextField(wrappingLabelWithString: "")

    init() {
        super.init(frame: .zero)
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        wantsLayer = true
        setAccessibilityElement(true)
        setAccessibilityRole(.group)

        card.wantsLayer = true
        card.layer?.cornerRadius = 10
        card.layer?.borderWidth = 1
        card.shadow = {
            let shadow = NSShadow()
            shadow.shadowBlurRadius = 12
            shadow.shadowOffset = NSSize(width: 0, height: -2)
            shadow.shadowColor = NSColor.shadowColor.withAlphaComponent(0.2)
            return shadow
        }()
        card.translatesAutoresizingMaskIntoConstraints = false
        addSubview(card)

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isIndeterminate = true
        spinner.isDisplayedWhenStopped = false
        spinner.translatesAutoresizingMaskIntoConstraints = false

        titleLabel.font = .systemFont(ofSize: NSFont.systemFontSize, weight: .semibold)
        titleLabel.textColor = .labelColor
        titleLabel.lineBreakMode = .byTruncatingMiddle
        detailLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.maximumNumberOfLines = 0
        for label in [titleLabel, detailLabel] {
            label.translatesAutoresizingMaskIntoConstraints = false
            card.addSubview(label)
        }
        card.addSubview(spinner)

        NSLayoutConstraint.activate([
            card.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Self.inset),
            card.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Self.inset),
            // Never wider than the window can spare: a narrow panel truncates
            // the title rather than pushing the card off its leading edge.
            card.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: Self.inset),

            spinner.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 12),
            spinner.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),

            titleLabel.leadingAnchor.constraint(equalTo: spinner.trailingAnchor, constant: 8),
            titleLabel.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
            titleLabel.topAnchor.constraint(equalTo: card.topAnchor, constant: 10),

            detailLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            detailLabel.trailingAnchor.constraint(equalTo: titleLabel.trailingAnchor),
            detailLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 2),
            detailLabel.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -10),
        ])
        // The column is `textWidth` wide wherever the window allows it, and
        // narrower only when the leading bound above is reached. A width left
        // to the labels' own sizes settles on the smallest the constraints
        // allow, which truncates the title and drops the detail's last line.
        let column = titleLabel.widthAnchor.constraint(equalToConstant: Self.textWidth)
        column.priority = .defaultHigh - 1
        column.isActive = true
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        detailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        applyColours()
    }

    /// A wrapping label sizes its height from `preferredMaxLayoutWidth`, so it
    /// is handed the width it was actually given and laid out once more; left
    /// at a fixed figure, a narrow window measures the detail one line short.
    override func layout() {
        super.layout()
        let width = detailLabel.frame.width
        guard width > 0, detailLabel.preferredMaxLayoutWidth != width else { return }
        detailLabel.preferredMaxLayoutWidth = width
        super.layout()
    }

    /// The text column's widest. Wide enough for the detail sentence in two
    /// lines, narrow enough to stay a corner card on a small panel.
    private static let textWidth: CGFloat = 260

    /// The page's paper, as `StatusOverlay.paper` is: what the dim is painted
    /// in, so a theme's own ground is what the note fades toward.
    var paper: NSColor = NSColor.textBackgroundColor {
        didSet { applyColours() }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColours()
    }

    private func applyColours() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            self.layer?.backgroundColor = self.paper.withAlphaComponent(Self.dimAlpha).cgColor
            self.card.layer?.backgroundColor = self.paper.cgColor
            self.card.layer?.borderColor = NSColor.separatorColor.cgColor
        }
    }

    /// Put the card's words up, and start the spinner. Called again for each
    /// phase; only a change of words is announced to VoiceOver.
    func show(_ title: String, detail: String) {
        let changed = title != titleLabel.stringValue
        titleLabel.stringValue = title
        detailLabel.stringValue = detail
        setAccessibilityLabel("\(title) \(detail)")
        spinner.startAnimation(nil)
        if changed {
            NSAccessibility.post(element: self, notification: .announcementRequested,
                                 userInfo: [.announcement: title, .priority: NSAccessibilityPriorityLevel.high.rawValue])
        }
    }

    /// Stop the spinner. The caller takes the cover off the window.
    func stop() {
        spinner.stopAnimation(nil)
    }

    /// What the card says, for a test that has no screen to read it off.
    var shownText: (title: String, detail: String) {
        (titleLabel.stringValue, detailLabel.stringValue)
    }

    // MARK: holding the page

    /// Everything inside the cover is the cover's, the card included: nothing
    /// on it is a control, and a point that fell through would reach the page.
    override func hitTest(_ point: NSPoint) -> NSView? {
        frame.contains(point) ? self : nil
    }

    override var acceptsFirstResponder: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }

    override func rightMouseDown(with event: NSEvent) {}
    override func otherMouseDown(with event: NSEvent) {}
    override func scrollWheel(with event: NSEvent) {}
    /// Keys stop here rather than reaching the page. Key equivalents still go
    /// to the menus first, so Quit and Close keep working.
    override func keyDown(with event: NSEvent) {}

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .arrow)
    }
}
