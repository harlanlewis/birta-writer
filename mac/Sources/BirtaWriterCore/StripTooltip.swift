import Foundation
import CoreGraphics

/// A tooltip the page has handed over, because the page cannot draw it.
///
/// The tab bar is a row of the titlebar that macOS paints OVER the web view,
/// so a chip the page places against a control in its first row is drawn under
/// the tabs. The page therefore sends the chip here instead (`stripTooltip` in
/// shared/messages.ts, posted only to a host declaring the `stripTooltip`
/// capability), and the app draws it in a window of its own, above the tabs
/// and against the control, which is where the same chip sits in a window with
/// no tab bar.
///
/// This half has no window: what arrived, what colour a CSS string is, and
/// where the chip goes. `StripTooltipWindow` is the half that draws.
public struct StripTooltip: Equatable, Sendable {
    /// How the page's own chip looks, resolved by the page off the live
    /// element. Carried per request rather than stored, so the chip follows
    /// the theme and the zoom with nothing here to keep in step.
    public struct Style: Equatable, Sendable {
        public var background: CSSColor
        public var ink: CSSColor
        public var fontSize: CGFloat
        public var radius: CGFloat
        public var padX: CGFloat
        public var padY: CGFloat

        public init(background: CSSColor, ink: CSSColor, fontSize: CGFloat,
                    radius: CGFloat, padX: CGFloat, padY: CGFloat) {
            self.background = background
            self.ink = ink
            self.fontSize = fontSize
            self.radius = radius
            self.padX = padX
            self.padY = padY
        }
    }

    public var text: String
    /// The control's box, in the page's viewport coordinates: origin at the
    /// top-left of the web view, y growing downward.
    public var anchor: CGRect
    /// From the anchor's bottom edge to the chip's top, as the page chose it.
    public var gap: CGFloat
    public var style: Style

    public init(text: String, anchor: CGRect, gap: CGFloat, style: Style) {
        self.text = text
        self.anchor = anchor
        self.gap = gap
        self.style = style
    }

    /// The message's body, or nil for one that asks for the chip to go away or
    /// cannot be drawn. The two are one answer on purpose: a request missing
    /// its box or its look has nothing to be drawn from, and a chip left up
    /// from the last request would be naming the wrong control.
    public static func parse(_ dict: [String: Any]) -> StripTooltip? {
        guard let text = dict["text"] as? String, !text.isEmpty,
              let box = dict["anchor"] as? [String: Any],
              let look = dict["style"] as? [String: Any] else { return nil }
        func number(_ source: [String: Any], _ key: String) -> CGFloat? {
            (source[key] as? NSNumber).map { CGFloat($0.doubleValue) }
        }
        guard let x = number(box, "x"), let y = number(box, "y"),
              let width = number(box, "width"), let height = number(box, "height"),
              let background = (look["background"] as? String).flatMap(CSSColor.init(css:)),
              let ink = (look["color"] as? String).flatMap(CSSColor.init(css:)),
              let fontSize = number(look, "fontSize"), fontSize > 0 else { return nil }
        return StripTooltip(
            text: text,
            anchor: CGRect(x: x, y: y, width: width, height: height),
            gap: number(dict, "gap") ?? 6,
            style: Style(background: background, ink: ink, fontSize: fontSize,
                         radius: number(look, "radius") ?? 0,
                         padX: number(look, "padX") ?? 0,
                         padY: number(look, "padY") ?? 0))
    }

    /// The least air between the chip and either side of the window, which is
    /// the page's own number for the same thing (`position` in
    /// webview/ui/tooltip.ts).
    public static let edgeInset: CGFloat = 4

    /// Where the chip goes, in the page's coordinates: centred under the
    /// anchor at the page's gap, and held inside the viewport's width.
    ///
    /// The SIZE is the caller's, because it is measured from text this module
    /// cannot measure. Vertically nothing is clamped: the page has already
    /// decided the chip belongs at this height, and that decision is the whole
    /// reason the request exists.
    public func origin(chip: CGSize, viewportWidth: CGFloat) -> CGPoint {
        let centred = anchor.midX - chip.width / 2
        let furthest = viewportWidth - chip.width - Self.edgeInset
        return CGPoint(x: max(Self.edgeInset, min(centred, furthest)).rounded(),
                       y: (anchor.maxY + gap).rounded())
    }
}

/// A colour as a computed style spells one.
///
/// Three spellings reach here. `rgb(r, g, b)` and `rgba(r, g, b, a)` are what
/// a plain colour computes to, with channels out of 255. `color(srgb r g b /
/// a)` is what WebKit computes a `color-mix()` to, with channels out of 1, and
/// the palette is built from those. Anything else is refused rather than
/// guessed at: black is a colour, and a chip drawn in it because a string did
/// not parse looks exactly like a chip that was meant to be.
public struct CSSColor: Equatable, Sendable {
    public var red: CGFloat
    public var green: CGFloat
    public var blue: CGFloat
    public var alpha: CGFloat

    public init(red: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }

    public init?(css: String) {
        let value = css.trimmingCharacters(in: .whitespaces).lowercased()
        let scale: CGFloat
        let body: Substring
        if value.hasPrefix("rgba("), value.hasSuffix(")") {
            scale = 255
            body = value.dropFirst(5).dropLast()
        } else if value.hasPrefix("rgb("), value.hasSuffix(")") {
            scale = 255
            body = value.dropFirst(4).dropLast()
        } else if value.hasPrefix("color(srgb "), value.hasSuffix(")") {
            scale = 1
            body = value.dropFirst(11).dropLast()
        } else {
            return nil
        }
        let parts = body.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "/" })
        guard parts.count == 3 || parts.count == 4 else { return nil }
        var numbers: [CGFloat] = []
        for (index, part) in parts.enumerated() {
            // A percentage is a fraction of the channel's own range, and the
            // alpha's range is 1 whichever spelling the channels came in.
            let isPercent = part.hasSuffix("%")
            guard let number = Double(isPercent ? part.dropLast() : part) else { return nil }
            let range: CGFloat = index == 3 ? 1 : scale
            numbers.append(isPercent ? CGFloat(number) / 100 : CGFloat(number) / range)
        }
        self.init(red: numbers[0], green: numbers[1], blue: numbers[2],
                  alpha: numbers.count == 4 ? numbers[3] : 1)
    }
}
