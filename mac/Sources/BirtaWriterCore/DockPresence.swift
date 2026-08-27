import Foundation

/// What moving the Show in Dock switch has to DO, decided without AppKit.
///
/// The switch writes a preference and the app sets an activation policy, which
/// looks like one line and carries a trap that only shows up in one direction.
/// Leaving `.regular` tells macOS this is no longer a foreground app, and it
/// deactivates the app: every window goes behind whatever else is open. The
/// reader is looking at the Settings pane the switch is on when they move it,
/// so what that reads as is the app quitting on the toggle they just touched,
/// with the menu bar or the summon hotkey as the only way back.
///
/// The remedy is to put the frontmost window back afterwards, and the reason
/// this is a type rather than a branch at the call site is that WHEN to do that
/// is a real decision with three answers, not two:
///
///   nothing     the policy already matches, so setting it again is a
///               deactivation bought for no change at all.
///   change      launch and the first-run screen: take the policy, take no
///               activation. An accessory app that grabbed focus at login
///               would be the worse bug.
///   change and
///   restore     a live toggle, where somebody is looking at the window that
///               is about to go behind.
///
/// What is deliberately NOT here is the AppKit choreography: the policy call,
/// and the fact that re-activating has to happen a runloop turn later because
/// the deactivation is not synchronous with the policy change. That half lives
/// in `AppDelegate.applyActivationPolicy` and is checked by using the app,
/// which is the only instrument that can see a window go behind another app.
public enum DockPresence {
    public enum Action: Equatable {
        /// Already right; touching the policy would deactivate for nothing.
        case nothing
        /// Take the policy. `restoreFrontmost` says whether the window that was
        /// in front has to be put back once macOS has finished the transition.
        case change(regular: Bool, restoreFrontmost: Bool)
    }

    /// - Parameters:
    ///   - showInDock: what the setting now says.
    ///   - isRegular: the policy the app is running under.
    ///   - keepingFrontmost: whether somebody is looking at a window right now.
    ///     False at launch and on the first-run screen, true for a toggle.
    public static func action(showInDock: Bool,
                              isRegular: Bool,
                              keepingFrontmost: Bool) -> Action {
        guard showInDock != isRegular else { return .nothing }
        // Restoring is asked for only in the direction that loses the window.
        // Going TO `.regular` never deactivates, so putting the window back
        // there would be an activation nobody asked for, and at launch that is
        // an accessory app stealing focus.
        return .change(regular: showInDock, restoreFrontmost: keepingFrontmost && !showInDock)
    }
}
