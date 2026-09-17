import AppKit

/// A row of the titlebar band held open for the page's formatting row, so the
/// tab bar sits UNDER that row rather than over it.
///
/// AppKit stacks the band from the top: the title row, then every bottom
/// accessory in the order it was added, and the tab bar is one of those,
/// added by the system when a window joins a group. The page draws its
/// formatting row directly under its first row, which is the title row, so
/// with a tab bar present the two rows of the page's bar and the tab bar all
/// wanted the same second line of the band, and the tab bar, being the
/// window's, won: it painted over the formatting controls and over every
/// popup that opened out of the first row.
///
/// This accessory is added before any tab bar exists, so it precedes the tab
/// bar in the stack; it is as tall as the page says its row is
/// (`formattingRowHeight` on the bridge) and it draws nothing. The page then
/// puts its formatting row exactly where this holds the band open, and the
/// tab bar lands below both. Shown only while a tab bar is present: without
/// one the page's second row already sits below the band on its own, and a
/// band held open for it would leave a blank row between the two.
///
/// Every click on it falls through to the page beneath, which is the whole
/// reason it can exist in front of the web view: an accessory that took the
/// click would make the formatting row unreachable.
@MainActor
final class FormattingRowSpacer: NSTitlebarAccessoryViewController {
    private let spacer = PassThroughView(frame: NSRect(x: 0, y: 0, width: 100, height: 0))

    init() {
        super.init(nibName: nil, bundle: nil)
        layoutAttribute = .bottom
        view = spacer
        isHidden = true
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// The height held open, in points. The frame is the accessory's height
    /// as far as the band is concerned, so this is the only knob.
    var height: CGFloat {
        get { spacer.frame.height }
        set {
            guard abs(spacer.frame.height - newValue) > 0.01 else { return }
            spacer.frame.size.height = newValue
        }
    }
}

/// A view no click lands on, so the page under the band gets it.
private final class PassThroughView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var acceptsFirstResponder: Bool { false }
}
