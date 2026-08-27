import AppKit

/// A transient line in the panel's bottom trailing corner, for the things the
/// app has just done: "Saved.", "New note.", "Copied the whole note."
///
///                                            [ Saved.  ◜ ]
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
///
/// ## How long you have
///
/// A ring beside the message empties over the seconds it has left. Nothing
/// here takes a click, so there is no way to hold a message that is going, and
/// the reader cannot otherwise tell whether they have five seconds to finish
/// reading or half of one. It is quiet about it: quieter ink than the words,
/// no larger than one line of them, and gone with them.
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

    /// How long a message stays before it fades.
    ///
    /// One number, because the countdown ring beside the text is a drawing of
    /// exactly this: two constants would be a ring that empties early or sits
    /// full while the message goes. `StatusOverlayCountdownTests` holds the
    /// ring's animation to it.
    static let dwell: TimeInterval = 6

    private let status = NSTextField(labelWithString: "")
    /// The countdown, as wide and tall as one line of the text beside it.
    private let countdown = CountdownRing()
    /// Between the message and the ring. Narrow: they are one thing, and a
    /// gap wide enough to read as two puts the ring closer to the window's
    /// edge than to what it is counting down.
    private static let ringGap: CGFloat = 6
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
        countdown.translatesAutoresizingMaskIntoConstraints = false
        addSubview(countdown)
        NSLayoutConstraint.activate([
            status.leadingAnchor.constraint(equalTo: leadingAnchor),
            status.centerYAnchor.constraint(equalTo: centerYAnchor),
            countdown.leadingAnchor.constraint(equalTo: status.trailingAnchor,
                                               constant: Self.ringGap),
            countdown.trailingAnchor.constraint(equalTo: trailingAnchor),
            countdown.centerYAnchor.constraint(equalTo: centerYAnchor),
            // The height of ONE LINE of the message, read off the label
            // rather than restated as a number, so the ring cannot drift out
            // of step with the text if the font changes. Square, because a
            // circle is.
            countdown.heightAnchor.constraint(equalTo: status.heightAnchor),
            countdown.widthAnchor.constraint(equalTo: countdown.heightAnchor),
        ])
        applyColours()
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
        applyColours()
    }

    private func applyColours() {
        applyScrimColour()
        countdown.applyColours()
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
        countdown.start(over: Self.dwell)
        let clear = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.clear = nil
            self.setAlpha(0)
        }
        self.clear = clear
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.dwell, execute: clear)
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


/// The ring beside a message, emptying over the time the message has left.
///
/// News with no dismiss control has one thing a reader cannot otherwise know,
/// which is how long they have to read it. A ring answers that at a glance and
/// costs the corner nothing: it is the height of the line it sits beside and no
/// wider, it takes no clicks, and it is gone with the message.
///
/// Two layers, and both are needed. The track is what makes the arc read as
/// DEPLETING rather than as an arc that happens to be short; without it the
/// last second looks like a stray tick beside the text.
@MainActor
final class CountdownRing: NSView {
    /// The full circle, drawn faintly, that the arc empties out of.
    private let track = CAShapeLayer()
    /// What is left. Animated from a whole circle to nothing.
    private let arc = CAShapeLayer()
    /// The stroke, in points. Thin enough to read as a hairline ring at this
    /// size, thick enough to survive a non-Retina display.
    private static let lineWidth: CGFloat = 1.5
    /// The key the depletion animation is added under, so a message replacing
    /// another replaces its countdown rather than layering a second one.
    static let animationKey = "countdown"

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        for shape in [track, arc] {
            shape.fillColor = nil
            shape.lineWidth = Self.lineWidth
            shape.lineCap = .round
            layer?.addSublayer(shape)
        }
        // From twelve o'clock, clockwise, which is the direction every other
        // determinate progress ring on the system runs.
        arc.transform = CATransform3DMakeRotation(-.pi / 2, 0, 0, 1)
        applyColours()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Nothing here takes a click; the whole overlay is news.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        let inset = Self.lineWidth / 2
        let box = bounds.insetBy(dx: inset, dy: inset)
        guard box.width > 0, box.height > 0 else { return }
        let path = CGPath(ellipseIn: box, transform: nil)
        // Geometry is not an animation: without this the ring slides into
        // place over CoreAnimation's default quarter second on every message.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for shape in [track, arc] {
            shape.frame = bounds
            shape.path = path
        }
        // A layer rotates about its anchor point, which is its own centre, so
        // the arc's start is at the top wherever the view is.
        CATransaction.commit()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColours()
    }

    /// A CGColor is resolved once, so both strokes are repainted when the
    /// appearance changes.
    func applyColours() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            // Quieter than the message. The ring is how long you have, not
            // what happened, and ink as strong as the words would make the
            // corner read as two messages.
            track.strokeColor = NSColor.quaternaryLabelColor.cgColor
            arc.strokeColor = NSColor.secondaryLabelColor.cgColor
            CATransaction.commit()
        }
    }

    /// Empty the ring over `duration`, starting now.
    func start(over duration: TimeInterval) {
        arc.removeAnimation(forKey: Self.animationKey)
        let deplete = CABasicAnimation(keyPath: "strokeEnd")
        deplete.fromValue = 1
        deplete.toValue = 0
        deplete.duration = duration
        // Linear, because the thing being drawn is time passing and any other
        // curve would be the ring lying about how much is left.
        deplete.timingFunction = CAMediaTimingFunction(name: .linear)
        // The model value is the END state, and the animation is what shows
        // the way there; leaving the model at 1 would snap the ring back to
        // full for the frame after it emptied. Written with actions off, the
        // same way every other layer write in this file is: a sublayer of a
        // view's layer keeps implicit animation switched on, and one added
        // here would run beside the one below it on the same property.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        arc.strokeEnd = 0
        CATransaction.commit()
        arc.add(deplete, forKey: Self.animationKey)
    }
}
