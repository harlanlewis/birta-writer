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
/// It replaces `sidebar.leading`, which was the right MEANING and the wrong
/// mark to put next to the page's: SF Symbols draws that one as a filled pane
/// beside a framed one, at a weight of its own, so the two ends of one strip
/// were a solid glyph and an outline. Nothing is wrong with either on its own,
/// which is why this went unnoticed until the file explorer's toggle moved
/// into the titlebar and the two ended up in one band.
///
/// ## Why the geometry is restated here
///
/// Swift cannot read `webview/ui/icons.ts`, so these numbers are a port and
/// carry the usual risk of a port: the page's icon changes and this one does
/// not, silently, because each half looks right on its own.
/// `shared/__tests__/paneGlyphParity.test.ts` reads both files and fails when
/// they disagree, which is the only thing that keeps the claim above true.
///
/// The numbers are the page's own, in the page's own 24-unit box, and are
/// scaled here rather than pre-multiplied: a reader comparing this with the
/// SVG should be comparing the same integers.
@MainActor
enum PaneGlyph {
    /// `viewBox="0 0 24 24"`.
    static let viewBox: CGFloat = 24
    /// `<rect x="3" y="3" width="18" height="18" rx="2"/>`.
    static let frameInset: CGFloat = 3
    static let cornerRadius: CGFloat = 2
    /// `<path d="M9 3v18"/>` — the divider, in the leading mark.
    static let dividerX: CGFloat = 9
    /// `stroke-width="2"`.
    static let strokeWidth: CGFloat = 2
    /// `width="16" height="16"`: what the page draws its icons at, and
    /// therefore what this draws at, because the two sit in one strip.
    static let drawnSize: CGFloat = 16

    /// The mark, as a template image, so it inks from `contentTintColor` and
    /// follows the appearance exactly as the SF Symbols beside it do.
    ///
    /// One mark, docked to the leading edge, because that is the only one this
    /// app draws: the outline's toggle at the other end of the band is the
    /// page's own button, and the page mirrors it in CSS for a right-hand
    /// dock. A `trailing` case here would be a second way to draw something
    /// nothing asks for.
    static func image() -> NSImage {
        let size = NSSize(width: drawnSize, height: drawnSize)
        let image = NSImage(size: size, flipped: false) { _ in
            let scale = drawnSize / viewBox
            let stroke = strokeWidth * scale
            // Inset by half the stroke, because a stroked path straddles its
            // own line: without this the outer half of every edge is drawn
            // outside the image and clipped, so three sides of the frame come
            // out thinner than the fourth.
            let box = NSRect(x: frameInset * scale + stroke / 2,
                             y: frameInset * scale + stroke / 2,
                             width: (viewBox - frameInset * 2) * scale - stroke,
                             height: (viewBox - frameInset * 2) * scale - stroke)
            let radius = max(0, cornerRadius * scale - stroke / 2)
            let frame = NSBezierPath(roundedRect: box, xRadius: radius, yRadius: radius)
            frame.lineWidth = stroke
            NSColor.black.setStroke()
            frame.stroke()

            // The divider, at the page's own x.
            let x = dividerX * scale
            let divider = NSBezierPath()
            divider.move(to: NSPoint(x: x, y: box.minY - stroke / 2))
            divider.line(to: NSPoint(x: x, y: box.maxY + stroke / 2))
            divider.lineWidth = stroke
            divider.stroke()
            return true
        }
        image.isTemplate = true
        return image
    }
}
