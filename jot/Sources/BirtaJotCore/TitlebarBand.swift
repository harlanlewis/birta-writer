import CoreGraphics
import Foundation

/// What the titlebar band is FOR, with no window and no web view involved.
///
/// The panel draws its page under a transparent full-height titlebar, so the
/// band holds three things across its width: the window's own buttons and
/// title at the leading edge, the page's controls at the trailing edge, and
/// nothing at all in between. That middle stretch is the part a person expects
/// to be able to grab, and everything decidable about where it starts and ends
/// is arithmetic rather than AppKit.
public enum TitlebarBand {
    /// The stretch of the band that belongs to neither the window's chrome nor
    /// the page's, in the band's own coordinates.
    ///
    /// `leading` is where the window's own furniture ends: the traffic lights
    /// and, after them, the title accessory. `trailingControlsWidth` is how
    /// much of the far edge the page has taken. Returns nil when the two meet
    /// or cross, which is a window too narrow to have a middle: a strip of
    /// zero or negative width is not a smaller drag target, it is a drag
    /// target that reports success and cannot be hit.
    public static func draggableSpan(
        windowWidth: CGFloat,
        leading: CGFloat,
        trailingControlsWidth: CGFloat,
        minimumWidth: CGFloat = 8,
    ) -> (x: CGFloat, width: CGFloat)? {
        let end = windowWidth - max(0, trailingControlsWidth)
        let start = max(0, leading)
        let width = end - start
        guard width >= minimumWidth else { return nil }
        return (x: start, width: width)
    }
}

/// What a double click on the titlebar does, which is the user's choice and
/// not this app's.
///
/// macOS keeps it in `AppleActionOnDoubleClick` in the global domain, and a
/// window that picks its own answer is a window that ignores a setting the
/// person has already made. Read at click time rather than captured: the
/// setting can change while the app runs, and the next double click has to
/// honour it.
public enum TitlebarDoubleClick: Equatable, Sendable {
    case zoom
    case minimize
    case none

    /// The action `AppleActionOnDoubleClick` names.
    ///
    /// An absent value is `zoom`, which is the system default rather than a
    /// preference of ours: macOS ships with the key unset and behaves as
    /// Maximize, so a window that did nothing when the key was missing would
    /// be inert on a machine nobody has configured. An unrecognised value is
    /// `none`, because inventing a behaviour for a word the system may add
    /// later is worse than doing nothing.
    public static func action(for setting: String?) -> TitlebarDoubleClick {
        switch setting {
        case nil, "Maximize": return .zoom
        case "Minimize": return .minimize
        default: return .none
        }
    }
}
