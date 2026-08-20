import Foundation
import CoreGraphics

/// Where a caret reported by the PAGE sits in the VIEW that draws it.
///
/// The page speaks in viewport CSS pixels, whose origin is the top left. A
/// macOS view's own origin depends on the view: `isFlipped` is what says which
/// way its y runs, and `WKWebView` answers true, so the page's coordinates are
/// already the web view's and the conversion is the identity. A view that is
/// not flipped needs the y mirrored about its height.
///
/// Here rather than at the call site because a coordinate conversion is exactly
/// the kind of thing that looks right in both directions: a popover anchored
/// with the y flipped the wrong way still appears, at the other end of the
/// window, which reads as a placement that has not been tuned rather than as
/// one that is inverted. `Coordinator` passes `view.isFlipped` rather than
/// assuming it, so the branch is decided by the view under the popover.
public enum CaretAnchor {
    /// The caret's rectangle in `view`'s coordinates.
    ///
    /// A minimum height, because a caret on an empty line can report a box of
    /// no height and a popover hung off nothing lands at the view's edge. The
    /// width is one point: the anchor is a caret, and giving it the caret's
    /// own width would only move the popover half a character.
    public static func rect(left: Double, top: Double, bottom: Double,
                            viewHeight: Double, isFlipped: Bool) -> CGRect {
        let height = max(bottom - top, 1)
        let y = isFlipped ? top : viewHeight - bottom
        return CGRect(x: left, y: y, width: 1, height: height)
    }
}
