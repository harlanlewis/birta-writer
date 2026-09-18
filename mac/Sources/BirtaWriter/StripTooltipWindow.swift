import AppKit
import BirtaWriterCore

/// Draws a tooltip the page handed over, in a window of its own above the
/// window it names a control of.
///
///     ◉ ◉ ◉   Note.md ⌄   ⊞  📁  ⌘
///     ╭───────── ┌──────────┐ ─────────╮
///     │  tab one │ Open… ⌘O │          │      the chip, over the tab bar
///     ╰───────── └──────────┘ ─────────╯
///
/// A WINDOW, because nothing less is above the tab bar. The bar is drawn by
/// the titlebar's own container, which sits over the content view and over
/// every accessory this app can add to it, so a view of ours is under the tabs
/// wherever it is put, which is the page's problem again one layer up. A child
/// window is ordered above its parent as a whole, titlebar included, and
/// travels with it.
///
/// `BirtaWriterCore.StripTooltip` is the half with no window: what the page
/// sent and where the chip goes. This half measures the words and draws them.
///
/// ## What it must not become
///
/// It is not a window to the rest of the app. It never takes the pointer, so a
/// click meant for a tab under it reaches the tab. It never joins a tab group
/// (`tabbingMode`), which a window made while its parent has tabs would
/// otherwise be offered, and it is kept off the Window menu. It is not
/// released when closed, because one instance is shown and put away for the
/// life of its window, and closed with it (`tearDown`).
@MainActor
final class StripTooltipWindow {
    private var window: NSPanel?
    private let chip = ChipView()

    /// The line box the page gives the chip's text, as a multiple of the font
    /// size (`.custom-tooltip`, `line-height`). The one number about the
    /// chip's look that does not travel with the request, because a computed
    /// line height is a length and the text here is measured by AppKit; held
    /// to the stylesheet by `StripTooltipWindowTests`.
    static let lineHeight: CGFloat = 1.4

    /// Show `tooltip` over `parent`, or put the chip away for nil.
    func show(_ tooltip: StripTooltip?, over parent: NSWindow) {
        guard let tooltip else { return hide() }
        chip.tooltip = tooltip
        let size = chip.fittingChipSize
        // The page's coordinates start at the top-left of the web view, which
        // fills the window under a full-height titlebar, so the window's own
        // top-left is their origin and the flip is the whole conversion.
        let origin = tooltip.origin(chip: size, viewportWidth: parent.frame.width)
        let frame = NSRect(x: parent.frame.minX + origin.x,
                           y: parent.frame.maxY - origin.y - size.height,
                           width: size.width, height: size.height)
        let window = self.window ?? makeWindow()
        self.window = window
        window.setFrame(frame, display: false)
        chip.frame = NSRect(origin: .zero, size: size)
        chip.needsDisplay = true
        // The shadow is cut from what the window draws, and a chip whose words
        // changed has changed shape under it.
        window.invalidateShadow()
        if window.parent !== parent {
            window.parent?.removeChildWindow(window)
            parent.addChildWindow(window, ordered: .above)
        }
        window.orderFront(nil)
    }

    func hide() {
        guard let window else { return }
        window.parent?.removeChildWindow(window)
        window.orderOut(nil)
    }

    /// Let the panel go with the window it served. An ordered-out window is
    /// still in `NSApp.windows` for the life of the process, and one per
    /// closed document window is a leak nothing else would ever reclaim.
    func tearDown() {
        hide()
        window?.close()
        window = nil
    }

    /// The chip's frame on screen, or nil while it is put away. For a check
    /// with no pointer.
    var frameForMeasurement: NSRect? {
        guard let window, window.isVisible else { return nil }
        return window.frame
    }

    /// The window itself, for a check of what it may and may not do.
    var windowForMeasurement: NSWindow? { window }

    private func makeWindow() -> NSPanel {
        let window = NSPanel(contentRect: .zero,
                             styleMask: [.borderless, .nonactivatingPanel],
                             backing: .buffered, defer: true)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.ignoresMouseEvents = true
        window.tabbingMode = .disallowed
        window.isExcludedFromWindowsMenu = true
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.animationBehavior = .none
        window.contentView = chip
        return window
    }
}

/// The chip: a rounded ground with one line of text on it, both the page's.
@MainActor
private final class ChipView: NSView {
    var tooltip: StripTooltip?

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }

    private var attributes: [NSAttributedString.Key: Any] {
        guard let style = tooltip?.style else { return [:] }
        return [.font: NSFont.systemFont(ofSize: style.fontSize),
                .foregroundColor: NSColor(style.ink)]
    }

    private var textSize: NSSize {
        guard let tooltip else { return .zero }
        return (tooltip.text as NSString).size(withAttributes: attributes)
    }

    /// The text's width and the page's line box, inside the page's padding.
    /// Whole points, so the chip's edges land on pixels.
    var fittingChipSize: NSSize {
        guard let style = tooltip?.style else { return .zero }
        return NSSize(width: ceil(textSize.width) + style.padX * 2,
                      height: ceil(style.fontSize * StripTooltipWindow.lineHeight) + style.padY * 2)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let tooltip else { return }
        NSColor(tooltip.style.background).setFill()
        NSBezierPath(roundedRect: bounds,
                     xRadius: tooltip.style.radius,
                     yRadius: tooltip.style.radius).fill()
        let size = textSize
        (tooltip.text as NSString).draw(
            at: NSPoint(x: tooltip.style.padX,
                        y: ((bounds.height - size.height) / 2).rounded()),
            withAttributes: attributes)
    }
}

private extension NSColor {
    convenience init(_ colour: CSSColor) {
        self.init(srgbRed: colour.red, green: colour.green, blue: colour.blue, alpha: colour.alpha)
    }
}
