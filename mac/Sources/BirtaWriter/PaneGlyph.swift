import AppKit

/// The page's sidebar-toggle mark, drawn native so both ends of the titlebar
/// band can carry it.
///
/// The band has a pane toggle at each end, and they toggle the same KIND of
/// thing: the file explorer on the leading side, the outline on the trailing
/// side. The trailing one is the page's (`IconPanelLeft` in
/// `webview/ui/icons.ts`, flipped by CSS for a right-hand dock) and the
/// leading one is this app's, so the pair only reads as a pair if the second
/// is the first mirrored rather than a different picture of the same idea.
///
/// Not `sidebar.leading`, which is the right MEANING and the wrong mark to
/// put next to the page's: SF Symbols draws that one as a filled pane beside
/// a framed one, at a weight of its own, so the two ends of one strip would
/// be a solid glyph and an outline.
///
/// ## The geometry is the SVG's, transcribed
///
/// Swift cannot read `webview/ui/icons.ts`, so these numbers are a port and
/// carry the usual risk of a port. `shared/__tests__/paneGlyphParity.test.ts`
/// reads both files and fails when the NUMBERS disagree, and
/// `TitlebarSymbolsTests` reads the drawn pixels for what numbers cannot say.
///
/// Both checks exist because the first one alone was not enough, and the way
/// it was not enough is worth keeping: every number can match and the mark
/// still be drawn wrong, because what matters is also HOW a stroke sits on
/// the path it follows. An SVG stroke STRADDLES its path, half in and half
/// out. This drew the whole stroke inside the frame instead, which is a mark
/// one stroke width smaller on every side with tighter corners: right by every
/// number and visibly not the same glyph beside the page's.
///
/// So nothing here is inset. The path is the SVG's path, the stroke straddles
/// it as the browser's does, and its outer half has room because the box is
/// 16 and the frame's outer edge lands at `frameInset * scale - stroke / 2`.
@MainActor
enum PaneGlyph {
    /// `viewBox="0 0 24 24"`.
    static let viewBox: CGFloat = 24
    /// `<rect x="3" y="3" width="18" height="18" rx="2"/>`.
    static let frameInset: CGFloat = 3
    static let cornerRadius: CGFloat = 2
    /// `<path d="M9 3v18"/>`, the divider.
    static let dividerX: CGFloat = 9
    /// `stroke-width="2"`.
    static let strokeWidth: CGFloat = 2
    /// `width="16" height="16"`: what the page draws its icons at, and
    /// therefore what this draws at, because the two sit in one strip.
    static let drawnSize: CGFloat = 16

    /// The mark, as a template image, so it inks from `contentTintColor` and
    /// follows the appearance exactly as the SF Symbols beside it do.
    ///
    /// `paneFilled` is the state the page calls `IconPanelLeftFilled`: the
    /// panel this button opens is OUT, said by inking the pane rather than by
    /// washing the button. Same frame and same divider either way, so the two
    /// are one mark in two states.
    ///
    /// One orientation, docked to the leading edge, because that is the only
    /// one this app draws: the outline's toggle at the other end of the band
    /// is the page's own button, and the page mirrors it in CSS for a
    /// right-hand dock.
    static func image(paneFilled: Bool = false) -> NSImage {
        let size = NSSize(width: drawnSize, height: drawnSize)
        let image = NSImage(size: size, flipped: false) { _ in
            let scale = drawnSize / viewBox
            let stroke = strokeWidth * scale
            // The SVG's own rect, in points. No inset: see the header.
            let box = NSRect(x: frameInset * scale,
                             y: frameInset * scale,
                             width: (viewBox - frameInset * 2) * scale,
                             height: (viewBox - frameInset * 2) * scale)
            let frame = NSBezierPath(roundedRect: box,
                                     xRadius: cornerRadius * scale,
                                     yRadius: cornerRadius * scale)
            let dividerAt = dividerX * scale

            if paneFilled {
                // Clipped to the frame rather than given its own corner arcs,
                // which is the same shape by construction and cannot drift
                // from the frame's radius. Drawn under the strokes, as the
                // page's fill is, so the outline stays exactly the unfilled
                // mark's.
                NSGraphicsContext.saveGraphicsState()
                frame.addClip()
                NSColor.black.setFill()
                NSBezierPath(rect: NSRect(x: 0, y: 0, width: dividerAt, height: drawnSize)).fill()
                NSGraphicsContext.restoreGraphicsState()
            }

            NSColor.black.setStroke()
            frame.lineWidth = stroke
            frame.stroke()

            let divider = NSBezierPath()
            divider.move(to: NSPoint(x: dividerAt, y: box.minY))
            divider.line(to: NSPoint(x: dividerAt, y: box.maxY))
            divider.lineWidth = stroke
            divider.stroke()
            return true
        }
        image.isTemplate = true
        return image
    }
}
