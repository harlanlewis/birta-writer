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

    /// The widest the title's TEXT may be drawn, in points.
    ///
    /// The same question as `draggableSpan`, asked from the other end. The
    /// title grows rightwards and the drag strip starts where the title stops,
    /// so a ceiling on one is a floor on the other, and this returns the
    /// largest text width for which `draggableSpan` still returns a strip:
    /// take exactly this much and the strip that follows is `minimumWidth`
    /// wide, take a point more and there is no strip at all. That tie is what
    /// makes this the ceiling rather than a number chosen to look right, and
    /// `TitlebarBandTests` asserts it against `draggableSpan` itself rather
    /// than against a table of expected widths.
    ///
    /// `titleOriginX` is where AppKit placed the leading accessory, which is
    /// after the traffic lights, so nothing here repeats an inset the system
    /// owns. `titleChromeWidth` is everything inside the accessory that is not
    /// the text: the gap before the name and the room the chevron holds
    /// whether or not it is drawn.
    ///
    /// `trailingControlsWidth` is how much of the far edge is spoken for, and
    /// this is indifferent to what is standing there: it is a width the far
    /// end reports, not an inventory of what the band currently holds. A
    /// claimant that arrives later changes that number and nothing here.
    ///
    /// A window too narrow to hold any of it yields 0, never a negative: the
    /// caller's job then is to draw no title rather than to draw one
    /// backwards.
    public static func titleTextCeiling(
        windowWidth: CGFloat,
        titleOriginX: CGFloat,
        titleChromeWidth: CGFloat,
        trailingControlsWidth: CGFloat,
        minimumWidth: CGFloat = 8,
    ) -> CGFloat {
        let end = windowWidth - max(0, trailingControlsWidth) - minimumWidth
        let start = max(0, titleOriginX) + max(0, titleChromeWidth)
        return max(0, end - start)
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
