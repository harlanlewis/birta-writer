import AppKit

/// The panel, given over to saying the file is gone and offering the ways out.
///
///     This file can't be found
///     It may have been deleted or moved. What you were writing is
///     still on screen and is not saved anywhere else.
///
///     [Save It Back]  [Discard and Start New]  [Open Recent…]
///
/// A CARD in the middle of the window, rather than a strip along the bottom
/// edge, and rather than the opaque full-bleed screen it was between them.
///
/// The strip said the same words in the smallest type on the window, at the
/// edge furthest from where anybody was looking, beside two buttons that read
/// as two ways of making a file. It is the state where somebody's only copy of
/// a note is in memory, and it looked like a status line. What replaced it is
/// unchanged and is the whole point: the words belong in the middle, at a size
/// somebody reads, beside buttons named for what they cost.
///
/// What DID change is the covering. Filling everything below the band was
/// chosen on the grounds that it cost nothing while the offer was on screen,
/// and it turned out to cost two things. The page draws the titlebar's own
/// tooltip chip just under the band, so an opaque view starting there hid the
/// label of every button in the strip above it, including the Settings gear
/// that is the one way to preferences on a panel with no Dock icon. And the
/// text a reader is being told is at risk could not be selected or copied out,
/// which is the first thing somebody does when told their only copy is in
/// memory.
///
/// So the card covers itself and nothing else, and two lanes are kept clear of
/// it whatever the window's height: the tooltip lane under the band, and the
/// status line's corner at the bottom (`topLane`, `bottomLane`). Losing the
/// mouse block costs nothing that was being relied on, because the keyboard
/// was never blocked and `writeLatest` is what actually makes the state safe:
/// it refuses every write while the note is missing.
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

    /// Air between the card's edge and the words inside it.
    private static let padding: CGFloat = 28
    /// Air between the card's edge and the window's, so a narrow window still
    /// reads as a card ON something rather than as a band across it.
    private static let margin: CGFloat = 48
    /// The widest the body text is allowed to wrap at, whatever room there is.
    /// A comfortable line rather than a fit: the sentence is two clauses, and
    /// setting it across a wide window would make one long line of it.
    private static let bodyMeasure: CGFloat = 380
    /// How round the card is. `--ui-radius-l` on the page's scale, which is
    /// what its own cards and popups use, so this reads as one of them rather
    /// than as a system alert that wandered in.
    private static let cornerRadius: CGFloat = 10

    /// Kept clear at the top, under the titlebar band.
    ///
    /// The page draws the band's tooltip chip in this lane, a single line of
    /// chip text a couple of points under the band, and the card must never
    /// reach it: hiding those labels is what the full-bleed screen did and what
    /// this shape exists to stop. A FLOOR rather than a fit, because the chip's
    /// height is the page's to decide and nothing here can ask before laying
    /// out. `mac/scripts/measure.sh` is where the pair is actually compared,
    /// against the live chip in the running window.
    static let topLane: CGFloat = 40
    /// Kept clear at the bottom, for the status line that floats over the
    /// trailing corner (`StatusOverlay`, placed by `Coordinator`). Its own two
    /// constants plus air, so a message and the card are never one crowded
    /// block in a short window.
    static let bottomLane: CGFloat = StatusOverlay.height + 24

    init() {
        super.init(frame: .zero)
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// The card, and nothing around it.
    ///
    /// Drawn rather than set on a layer, and rather than an `NSVisualEffectView`
    /// behind the stack. `NSColor.controlBackgroundColor` is dynamic and
    /// `.cgColor` resolves it once, so a layer fill is frozen at whichever
    /// appearance was current when this was built and keeps the old ground
    /// across a light/dark switch. Drawing also puts the card into
    /// `Coordinator.writeSnapshot`, whose PDF path runs `draw(_:)` and copies
    /// neither a layer nor a vibrancy view: a snapshot of this state would
    /// otherwise show the words with nothing behind them.
    ///
    /// The border and the shadow are what make it a card, and they are not
    /// decoration here. Its ground and the page's paper are the same colour to
    /// within nothing in both themes, by design on both sides, so the fill
    /// alone would leave the words floating on the document.
    override func draw(_ dirtyRect: NSRect) {
        let box = cardRect
        guard !box.isEmpty else { return }
        let path = NSBezierPath(roundedRect: box,
                                xRadius: Self.cornerRadius, yRadius: Self.cornerRadius)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.shadowColor.withAlphaComponent(0.22)
        shadow.shadowBlurRadius = 18
        shadow.shadowOffset = NSSize(width: 0, height: -3)
        shadow.set()
        NSColor.controlBackgroundColor.setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()
        NSColor.separatorColor.setStroke()
        path.lineWidth = 1
        path.stroke()
    }

    /// The card's box, which is the stack plus its air.
    ///
    /// Derived from the laid-out stack rather than from a size written down, so
    /// the card is exactly as tall as what it is saying: the body text wraps to
    /// two lines with unsaved text and one without, and a card sized to a
    /// constant would be wrong in one of those.
    var cardRect: NSRect {
        guard let column, !column.frame.isEmpty else { return .zero }
        return column.frame.insetBy(dx: -Self.padding, dy: -Self.padding)
    }

    private func build() {
        heading.font = .systemFont(ofSize: NSFont.systemFontSize + 6, weight: .semibold)
        heading.alignment = .center
        body.font = .systemFont(ofSize: NSFont.systemFontSize)
        body.textColor = .secondaryLabelColor
        body.alignment = .center
        body.usesSingleLineMode = false
        body.lineBreakMode = .byWordWrapping

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
        // The words are what the card is for, so they are the last thing to
        // give. A label's own vertical resistance is below the lane
        // constraints below it, so without this a window short enough to make
        // the lanes disagree squeezes the message and clips it, and the card
        // stays neatly inside both lanes saying nothing legible. Raised so the
        // card runs past the status corner instead, which is the outcome the
        // priorities on those constraints are ranked to produce.
        for view in [heading, body, buttons] {
            view.setContentCompressionResistancePriority(.required, for: .vertical)
        }
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.setCustomSpacing(20, after: body)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        column = stack
        // Centred, clear of both reserved lanes, and never clipped. Those
        // three cannot all hold in a short window, so they are RANKED and the
        // order is the whole of this:
        //
        //   inside   required. Every button on the card is a way out of this
        //            state, and one drawn past the window's edge is one nobody
        //            can press or resize their way back to without knowing it
        //            is there. Nothing else here is worth that.
        //   top      999. The tooltip lane under the band, which is what this
        //            shape exists to keep clear: a card in it takes the labels
        //            off the whole titlebar strip, the Settings gear included.
        //   bottom   998. A status message and the card overlapping is a
        //            crowded corner and nothing worse.
        //   centre   low, so it is the first to give.
        //
        // At the panel's own minimum size the card is taller than the area
        // minus both lanes, so both lanes give and it sits centred and whole.
        // The insets carry the card's padding as well as the lane, because the
        // constraints are on the stack and what has to clear is the CARD.
        let pad = Self.padding
        let centre = stack.centerYAnchor.constraint(equalTo: centerYAnchor)
        centre.priority = .defaultLow
        let lanes = [
            (stack.topAnchor.constraint(greaterThanOrEqualTo: topAnchor,
                                        constant: Self.topLane + pad), NSLayoutConstraint.Priority(999)),
            (stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor,
                                           constant: -(Self.bottomLane + pad)), NSLayoutConstraint.Priority(998)),
        ]
        for (constraint, priority) in lanes { constraint.priority = priority }
        NSLayoutConstraint.activate(lanes.map(\.0) + [
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            centre,
            stack.topAnchor.constraint(greaterThanOrEqualTo: topAnchor, constant: pad),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -pad),
            stack.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor,
                                         constant: -(Self.margin + pad * 2)),
        ])
        isHidden = true
    }

    /// Two things a pass has to do before the card is drawn.
    ///
    /// The body wraps at whichever is smaller, a comfortable line or the room
    /// the card actually has. A fixed measure is what an `NSTextField` reports
    /// its HEIGHT for, so one wider than the box it is drawn in reports the
    /// line count of a wider line and the last line is drawn outside the field:
    /// the sentence loses its tail, and the card is the right size for a
    /// sentence that is not the one on screen. Set from `bounds` rather than
    /// from the field's own frame, which is what makes this one pass instead of
    /// a measure, a resize and a re-measure.
    ///
    /// And the card is drawn from the stack's frame, so a pass that moved the
    /// stack has moved the card and left the old one on screen.
    override func layout() {
        body.preferredMaxLayoutWidth =
            min(Self.bodyMeasure, max(0, bounds.width - Self.margin - Self.padding * 2))
        super.layout()
        needsDisplay = true
    }

    /// What the screen says, and which ways out it offers.
    ///
    /// The heading does NOT name the file, and that is the one thing about it
    /// worth stating. A file name is arbitrary length: it went in the heading,
    /// at the largest type on the window, where a long one set the width of the
    /// whole card and a very long one truncated in the middle of the only
    /// sentence saying what had happened. The window's own title bar is a few
    /// inches above and names the file already, with a ceiling that was built
    /// for exactly this (`TitlebarBand`), so the card says what is wrong and
    /// lets the title say which file it is wrong about.
    ///
    /// `hasUnsavedText` is the whole of the rest, and it is a fact about the
    /// BUFFER rather than about the file: the file is gone either way, so what
    /// decides the offer is whether anything on screen exists nowhere else.
    /// With text to lose, saving it is the first thing offered and the button
    /// that throws it away is named for what it costs. With nothing to lose,
    /// neither belongs: an offer to save an empty buffer writes an empty file,
    /// and a warning about discarding nothing is a warning people learn to
    /// click through.
    func show(_ shown: Bool, hasUnsavedText: Bool = false) {
        isHidden = !shown
        guard shown else { return }
        heading.stringValue = "This file can't be found"
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

    /// Only the card takes a click.
    ///
    /// Everything around it falls through to the page, which is the difference
    /// the card makes and not a side effect of it: the reader can select and
    /// copy the text they have just been told is their only copy, and the
    /// page's own controls in the band above go on answering. Nothing is given
    /// up by letting the document take a click, because `writeLatest` refuses
    /// every write while the note is missing, which is what made the keyboard
    /// safe to leave open here in the first place.
    ///
    /// `point` arrives in the SUPERVIEW's coordinates, as `hitTest` always
    /// does, and `cardRect` is in this view's. Comparing them without the
    /// conversion puts the live box wherever this view happens to sit.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, cardRect.contains(convert(point, from: superview)) else { return nil }
        return super.hitTest(point)
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

    /// Whether each line of the card has room for what it says, for a check
    /// that cannot look at the window.
    ///
    /// The box a label is DRAWN in against what it NEEDS at that width, which
    /// is the pair a clipped label breaks: the field goes on reporting the size
    /// it was measured for, so nothing about its own frame says a line is
    /// missing. BOTH labels, because they are clipped in different directions
    /// and only one of them wraps: the body runs out of height when its wrap
    /// measure is wider than its box, and the heading is a single line that
    /// runs out of width.
    var labelFitsForMeasurement: [(name: String, box: NSRect, needs: NSSize)] {
        [heading, body].enumerated().map { index, field in
            let box = field.convert(field.bounds, to: self)
            let wraps = field.lineBreakMode == .byWordWrapping
            // Two different questions, and asking one of them twice is how this
            // becomes decoration: `cellSize(forBounds:)` CLAMPS its answer to
            // the width it is given, so measuring a single-line label at its
            // own box width reports that it needs exactly the room it has,
            // whatever it is actually drawing. A wrapping label is measured at
            // its box width, where the height is the real answer; a single-line
            // one is measured unbounded, where the width is.
            let infinite = CGFloat.greatestFiniteMagnitude
            let measured = field.cell?.cellSize(
                forBounds: NSRect(x: 0, y: 0, width: wraps ? box.width : infinite, height: infinite)
            ) ?? .zero
            // Zero, not the measurement, for the dimension the field is allowed
            // to be smaller than: a wrapping label is narrower than its text by
            // construction, and saying it needs that width would fail every
            // time. A requirement of zero reads as "no requirement".
            let needs = wraps ? NSSize(width: 0, height: measured.height) : measured
            return (index == 0 ? "heading" : "body", box, needs)
        }
    }

    @objc private func saveItBack() { onSaveItBack?() }
    @objc private func newNote() { onDiscardAndStartNew?() }
    @objc private func openRecent() { onOpenRecent?(recentButton) }
}
