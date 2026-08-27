import AppKit
import BirtaWriterCore
import Foundation
import ServiceManagement

/// The app's login-item registration, and the only place `SMAppService` is
/// touched.
///
/// Nothing here is cached. `SMAppService` is the record, System Settings edits
/// the same record, and a copy kept in `UserDefaults` would be a second answer
/// that is wrong whenever the user used the other door.
enum LoginItem {
    static var state: LoginItemState { LoginItemState(SMAppService.mainApp.status) }

    /// Register or unregister, and report the state that resulted rather than
    /// the one that was asked for. `register()` can succeed into `blocked`,
    /// where macOS has taken the request and is waiting on the user, so the
    /// call returning without throwing does not mean the app will launch.
    ///
    /// The registration names the bundle it is called from. That is why this
    /// is only offered from the installed copy: a build directory is
    /// branch-shaped and gets replaced, and a login item pointing into one
    /// launches whatever a later checkout happened to leave there. See the
    /// header of `mac/scripts/install-app.sh`.
    @discardableResult
    static func set(_ on: Bool) throws -> LoginItemState {
        if on {
            // Registering an already-registered service throws, and the switch
            // can be flipped from System Settings while this window is open, so
            // "already on" is a real state to arrive in and not an error.
            if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
        } else {
            try SMAppService.mainApp.unregister()
        }
        return state
    }

    /// System Settings, at the pane that holds the approval `blocked` waits on.
    static func openSystemSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension") else { return }
        NSWorkspace.shared.open(url)
    }
}
