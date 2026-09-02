import CoreGraphics

/// How big the panel is the first time somebody sees it, with nothing
/// remembered.
///
/// The size a window opens at is the only one most people ever judge it by,
/// and it was a constant: 640 by 480, written where the window is constructed,
/// before any screen is known. That is a size from a different era of
/// displays, and on a laptop it opens a writing app as a widget on a mostly
/// empty screen. Confirmed by reading it off the running app rather than off
/// the source: the first-run note is several screens of document
/// (`scrollHeight` an order of magnitude past the viewport) in a window 480
/// points tall.
///
/// The rule is a WANT, shrunk to fit:
///
///   * `preferred` is the size this app would like to be given the room. It is
///     a decision rather than a measurement: wide enough that a paragraph sets
///     at a comfortable measure, because the content column runs the full
///     width of the window by default (`contentWidth` ships `full`), and tall
///     enough to read a document in rather than peer at one.
///   * It never grows past `preferred` on a large display. A writing window
///     that opens as a wall of text across a 27 inch screen is a window the
///     first thing anybody does is resize, and the measure is the reason: past
///     a certain width a line of prose stops being readable, so the extra
///     pixels are not a gift.
///   * It shrinks to whatever the screen actually has, with air left around
///     it, and never below the panel's own floor. A window larger than the
///     screen puts its own edges where nothing can reach them.
///
/// Only the FIRST placement asks. A remembered frame wins outright, and so
/// does a window cascading off the one that spawned it, which takes its size
/// from its parent: both are sizes somebody arrived at, and this is only ever
/// the answer when nobody has.
public enum PanelSize {
    /// The size this app wants when the screen is not the constraint.
    public static let preferred = CGSize(width: 900, height: 760)

    /// The smallest the panel may be at all, which is also the floor this rule
    /// will not shrink below. Held here beside `preferred` rather than only on
    /// the window, so the two cannot drift into a "fit" that is under the
    /// minimum and is silently ignored by AppKit.
    public static let minimum = CGSize(width: 360, height: 240)

    /// Air between the window and the edges of the space it opens in, so a
    /// window on a small screen reads as placed rather than as jammed in.
    /// Applied on BOTH axes and counted twice per axis, because the window is
    /// centred: a margin taken once would leave the whole of it on one side.
    private static let margin: CGFloat = 24

    /// The content size to open at on a screen whose usable area is `visible`.
    ///
    /// `visible` is `NSScreen.visibleFrame`'s size: the menu bar and the Dock
    /// are already out of it, which is why nothing here subtracts them.
    ///
    /// A screen smaller than the floor gives the floor. That is a window
    /// larger than its screen, and it is the right answer: the alternative is a
    /// window below its own `minSize`, which AppKit will not honour anyway, so
    /// the choice is between a size that is refused and one that is at least
    /// what every other undersized window in the app gets.
    public static func forScreen(visible: CGSize) -> CGSize {
        CGSize(width: fit(preferred.width, within: visible.width, floor: minimum.width),
               height: fit(preferred.height, within: visible.height, floor: minimum.height))
    }

    private static func fit(_ wanted: CGFloat, within room: CGFloat, floor: CGFloat) -> CGFloat {
        max(floor, min(wanted, room - margin * 2))
    }

    /// How far above the screen's centre the window sits, as a fraction of the
    /// screen. A shade high is where a window reads as placed rather than as
    /// measured.
    private static let lift: CGFloat = 0.1

    /// Where a window of `size` goes on a screen whose usable area is `visible`.
    ///
    /// Centred horizontally and a shade above centre vertically, then CLAMPED
    /// so the whole window is inside `visible`.
    ///
    /// The clamp is the part that has to be here rather than at the call site,
    /// and it is here because it could not be checked there. The lift is a
    /// fraction of the SCREEN while the window is now nearly as tall as one, so
    /// on a laptop the unclamped point carries the title bar off the top edge
    /// and takes every titlebar control with it, the close button included.
    /// Written into `placeIfUnplaced`, the only way to ask whether it holds is
    /// to build a window and measure it against whatever display the machine
    /// running the suite happens to have: on a tall one the unclamped
    /// arithmetic fits anyway, so the check passes with the clamp deleted. A
    /// rule taking the screen as an argument can be asked about the screens it
    /// has to be right on.
    ///
    /// A window LARGER than the screen clamps to the screen's own origin, which
    /// leaves it overhanging the far edge. That is the honest answer for a size
    /// `forScreen` only returns when the display is smaller than the panel's
    /// floor: something has to overhang, and the near corner is where the
    /// window buttons are.
    public static func origin(for size: CGSize, visible: CGRect) -> CGPoint {
        let lifted = CGPoint(x: visible.midX - size.width / 2,
                             y: visible.midY - size.height / 2 + visible.height * lift)
        return CGPoint(x: clamp(lifted.x, from: visible.minX, to: visible.maxX - size.width),
                       y: clamp(lifted.y, from: visible.minY, to: visible.maxY - size.height))
    }

    /// `value` inside the range, with `from` winning when the range is empty
    /// (the window is bigger than the screen on that axis).
    private static func clamp(_ value: CGFloat, from low: CGFloat, to high: CGFloat) -> CGFloat {
        min(max(value, low), max(low, high))
    }
}
