import AppKit
import BirtaJotCore

/// The middle of the titlebar band, made to behave like the titlebar it is.
///
///     ◉ ◉ ◉  Birta Jot.md ───────────────────── T  ⌕  ⚙
///                         └── this view ──────┘
///
/// The panel gives its page a full-height transparent titlebar, so the
/// WKWebView is pinned to all four edges of the content view and covers the
/// band. That is what puts the page's own controls up there beside the window
/// buttons, and it is also why the band could not be dragged: every mouse event
/// in it reached the web view, and a window whose titlebar cannot be grabbed is
/// one macOS users will call broken before they call it anything else.
///
/// The CSS answer does not exist here. `-webkit-app-region: drag` is Chromium's;
/// WebKit does not implement it, and does not merely ignore the value but drops
/// the property, so nothing on the page can declare itself draggable. This view
/// is the alternative rather than a preference between two.
///
/// It spans only what neither side is using (`TitlebarBand.draggableSpan`),
/// because a strip across the whole band would swallow the page's controls, and
/// a control that does nothing when clicked is worse than a band that cannot
/// be dragged.
///
/// The gestures are the platform's, and both are delegated rather than
/// imitated:
///
///   drag          `NSWindow.performDrag`, which is the system's own window
///                 move, so snapping, Spaces and the menu-bar edge behave as
///                 they do for every other window. Reimplementing it from
///                 mouseDragged deltas is how an app ends up with a window
///                 that moves but does not snap.
///   double click  whatever `AppleActionOnDoubleClick` says
///                 (`TitlebarDoubleClick`), which is the user's setting and
///                 not this app's choice.
///
/// `mouseDownCanMoveWindow` is deliberately NOT the mechanism. It hands the
/// drag to AppKit at the cost of never delivering `mouseDown` here at all,
/// which takes the double click with it. Taking the event and calling
/// `performDrag` keeps both, and keeps them native.
@MainActor
final class TitlebarDragView: NSView {
    /// Overridden to false so `mouseDown` is delivered to us. See the note
    /// above: the two mechanisms are exclusive and this one keeps both
    /// gestures.
    override var mouseDownCanMoveWindow: Bool { false }

    /// A click that also brings the window forward should still drag it, which
    /// is how every native titlebar behaves.
    override func acceptsFirstMouse(for _: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        if event.clickCount == 2 {
            switch TitlebarDoubleClick.action(
                for: UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick")) {
            case .zoom: window.zoom(nil)
            case .minimize: window.miniaturize(nil)
            case .none: break
            }
            return
        }
        window.performDrag(with: event)
    }

    /// The band is chrome, not content: a text cursor over it would promise an
    /// insertion point that is not there.
    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .arrow)
    }
}
