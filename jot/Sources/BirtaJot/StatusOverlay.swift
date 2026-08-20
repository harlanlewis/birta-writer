import AppKit

/// A transient line in the panel's bottom trailing corner, for the things Jot
/// has just done: "Saved.", "New note.", "Copied the whole note."
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
///
/// ## Legible without a frame
///
/// The message has no card, no border and no pill, and it must stay that way:
/// a framed chip in the corner reads as a control, and this is news. That
/// leaves two jobs a frame would otherwise have done, and they are separate.
///
/// The ink is `labelColor`, the full-strength text role, because the message
/// is the only text in its own layer and is subordinate to nothing beside it.
/// The dimmer roles do not clear the contrast floor for text this small:
/// `StatusOverlayInkTests` measures all three against the page's paper and
/// fails if the chosen one drops below AA.
///
/// The scrim is what makes the line survive landing on top of a full-width
/// paragraph, which is the case a corner overlay meets constantly in a short
/// window. It is painted in `textBackgroundColor`, the SAME colour
/// `Coordinator.applyTheme` gives the panel and the web view's page, so over
/// empty paper it is invisible and no frame appears; over content it takes the
/// document out from under the glyphs and hands the ink its measured contrast
/// back. It fades to nothing on every side rather than ending at an edge,
/// because an edge is the thing a frame is made of.
@MainActor
final class StatusOverlay: NSView {
    /// Tall enough for one line of the small system font. The caller places it
    /// against the formatting bar, so the two numbers travel together.
    static let height: CGFloat = 20

    /// How far the scrim stays fully opaque past the text, and how far it then
    /// takes to reach nothing. The fade is the larger of the two on purpose:
    /// a short fade is an edge with extra steps.
    /// Wider than it is tall, and deliberately so: sideways there is a whole
    /// window to fade across, while upward there is only the gap to the line of
    /// the document above, and a scrim that reaches into it dissolves a word
    /// the message was never covering.
    private static let bleed = CGSize(width: 12, height: 3)
    private static let fade = CGSize(width: 30, height: 9)

    private let status = NSTextField(labelWithString: "")
    /// Vertical fade. Its mask carries the horizontal one, which is what gets
    /// the scrim feathered on both axes without a Core Image filter.
    private let scrim = CAGradientLayer()
    private let scrimMask = CAGradientLayer()
    private var clear: DispatchWorkItem?

    init() {
        super.init(frame: .zero)
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        wantsLayer = true
        // The scrim reaches past the label's tight box by design; clipping it
        // to those bounds would restore the four edges it exists to avoid.
        layer?.masksToBounds = false
        alphaValue = 0

        scrim.startPoint = CGPoint(x: 0.5, y: 0)
        scrim.endPoint = CGPoint(x: 0.5, y: 1)
        scrimMask.startPoint = CGPoint(x: 0, y: 0.5)
        scrimMask.endPoint = CGPoint(x: 1, y: 0.5)
        // A mask reads alpha only, so these two need no appearance.
        scrimMask.colors = [
            CGColor(gray: 0, alpha: 0), CGColor(gray: 0, alpha: 1),
            CGColor(gray: 0, alpha: 1), CGColor(gray: 0, alpha: 0),
        ]
        scrim.mask = scrimMask
        // Below the label, which is a subview and therefore a sibling layer.
        layer?.insertSublayer(scrim, at: 0)
        applyScrimColour()

        status.textColor = .labelColor
        status.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        // Middle, not tail: these messages end in the thing worth reading
        // ("Copy saved to Notes.md."), so a tail truncation cuts the answer off.
        status.lineBreakMode = .byTruncatingMiddle
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

    /// The gradient stops are fixed distances, not fractions of the message, so
    /// they have to be recomputed from real bounds: expressed as fractions once
    /// and left alone, a long message would get a wide fade and a short one a
    /// narrow one, and only one of the two could be right.
    override func layout() {
        super.layout()
        let inset = CGSize(width: Self.bleed.width + Self.fade.width,
                           height: Self.bleed.height + Self.fade.height)
        let box = bounds.insetBy(dx: -inset.width, dy: -inset.height)
        guard box.width > 0, box.height > 0 else { return }
        // Layer geometry is not an animation; without this the scrim lags the
        // text by CoreAnimation's default quarter second on every message.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        scrim.frame = box
        scrimMask.frame = CGRect(origin: .zero, size: box.size)
        let stopX = Self.fade.width / box.width
        let stopY = Self.fade.height / box.height
        scrim.locations = [0, stopY as NSNumber, (1 - stopY) as NSNumber, 1]
        scrimMask.locations = [0, stopX as NSNumber, (1 - stopX) as NSNumber, 1]
        CATransaction.commit()
    }

    /// A CGColor is resolved once, so the scrim has to be repainted when the
    /// appearance changes; NSColor-backed text follows it by itself.
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyScrimColour()
    }

    private func applyScrimColour() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let paper = NSColor.textBackgroundColor
            let solid = paper.cgColor
            let none = paper.withAlphaComponent(0).cgColor
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            scrim.colors = [none, solid, solid, none]
            CATransaction.commit()
        }
    }

    /// Nothing here takes a click, so the pointer goes to the document under
    /// it. Without this the corner would be a dead patch of window for six
    /// seconds after every save.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// Say what just happened, briefly, then go quiet.
    func flash(_ message: String) {
        self.clear?.cancel()
        status.stringValue = message
        // The message changed the label's width, so the scrim's stops are stale
        // until the next layout pass. Fading in over a stale scrim shows the
        // previous message's fade for a frame.
        needsLayout = true
        layoutSubtreeIfNeeded()
        setAlpha(1)
        let clear = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.clear = nil
            self.setAlpha(0)
        }
        self.clear = clear
        DispatchQueue.main.asyncAfter(deadline: .now() + 6, execute: clear)
    }

    /// The whole overlay fades, ink and scrim together. Fading only the label
    /// would leave the scrim behind as a bare patch of paper over the document.
    private func setAlpha(_ alpha: CGFloat) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            animator().alphaValue = alpha
        }
    }
}
