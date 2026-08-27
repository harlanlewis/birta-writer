import Foundation

/// WHERE the app can be reached from, and the one rule binding the two places.
///
/// Birta Writer for Mac is summoned by a hotkey, so it is designed to run with
/// no window on screen and, if you want, nothing in the Dock. What it must not
/// run without is a way back in for somebody who has forgotten the chord, and
/// there are exactly two: the menu-bar icon and the Dock icon. Either alone is
/// enough. Both is fine. Neither leaves a running app with no visible surface
/// at all, which is not a configuration so much as a copy of the app somebody
/// has to open Activity Monitor to be rid of.
///
/// ## Why this is a type and not a condition on the switch that needed it
///
/// The rule is symmetric, and that is the whole argument. Turning the menu bar
/// off while the Dock is off, and turning the Dock off while the menu bar is
/// off, are ONE forbidden state reached from two directions. A guard written
/// into whichever row was built first leaves the other row free to walk into
/// it, and the resulting app is unreachable by the exact route the guard was
/// added to protect. One declaration, two readers.
///
/// Decidable from values, so it is checkable with no AppKit and no defaults
/// domain. `AppPresenceTests` holds the rule; `RowAvailability.appPresence` is
/// the adapter that puts its answer in the vocabulary the settings rows use.
public enum AppPresence {
    /// The two places the app can be reached from.
    ///
    /// `CaseIterable` so the rule below and its checks are derived from the
    /// type rather than from a pair written out by hand: a third surface joins
    /// both without either being edited, and a sweep that reached nothing
    /// cannot pass for one that reached everything.
    public enum Surface: String, CaseIterable, Sendable {
        case menuBar
        case dock

        /// What this surface is called in a sentence about it.
        public var name: String {
            switch self {
            case .menuBar: return "the menu-bar icon"
            case .dock: return "the Dock icon"
            }
        }

        /// What the row says when this is the only surface left.
        ///
        /// It names the OTHER surface, because "you cannot turn this off" is
        /// half an answer: the thing the reader wants is the one move that
        /// makes it possible, and there is exactly one.
        public var lastWayInReason: String {
            let others = Surface.allCases.filter { $0 != self }.map(\.name)
            return "The last way to open the app without its hotkey. "
                + "Show \(others.joined(separator: " or ")) first."
        }
    }

    /// Whether `surface` is shown, out of the pair.
    public static func isShown(_ surface: Surface, menuBar: Bool, dock: Bool) -> Bool {
        switch surface {
        case .menuBar: return menuBar
        case .dock: return dock
        }
    }

    /// Whether the app can be reached at all without its hotkey.
    ///
    /// The invariant itself, stated once so a check can assert it directly
    /// rather than inferring it from the two rows' behaviour.
    public static func isReachable(menuBar: Bool, dock: Bool) -> Bool {
        Surface.allCases.contains { isShown($0, menuBar: menuBar, dock: dock) }
    }

    /// Whether `surface` is the ONLY way left in, and so must stay on.
    ///
    /// The one question both rows ask, from opposite sides. A surface that is
    /// already off is never the last way in, which is what keeps its switch
    /// live so it can be turned back on: the row's operability is exactly the
    /// negation of this, in both directions, with no second rule.
    public static func isOnlyWayIn(_ surface: Surface, menuBar: Bool, dock: Bool) -> Bool {
        guard isShown(surface, menuBar: menuBar, dock: dock) else { return false }
        return !Surface.allCases.contains {
            $0 != surface && isShown($0, menuBar: menuBar, dock: dock)
        }
    }
}
