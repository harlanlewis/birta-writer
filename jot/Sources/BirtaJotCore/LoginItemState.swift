import Foundation
import ServiceManagement

/// What Settings shows for "Open at login", derived from the system's answer.
///
/// The system owns this setting, not Jot: it is changed from System Settings
/// just as legitimately as from here, and macOS can overrule a registration
/// without telling the app. So there is no stored preference to drift out of
/// date. Settings asks `SMAppService` every time it shows the row, and this
/// type is the whole of what that answer means.
///
/// Pure so it can be tested: the state that matters most is the one hardest to
/// reach by hand, since `blocked` needs a user who has turned Jot off in
/// System Settings' Login Items after turning it on here.
public enum LoginItemState: Equatable, Sendable {
    /// Registered, and macOS will launch it.
    case on
    /// Not registered.
    case off
    /// Registered, and macOS is holding it until the user approves it in
    /// System Settings. The switch reads on, because the request stands and
    /// undoing it here is what turning the switch off would mean, but the app
    /// will not actually launch until that approval happens.
    case blocked
    /// The system will not register this copy at all, which in practice means
    /// it is running from somewhere it was not installed to.
    case unavailable

    public init(_ status: SMAppService.Status) {
        switch status {
        case .enabled: self = .on
        case .notRegistered: self = .off
        case .requiresApproval: self = .blocked
        case .notFound: self = .unavailable
        @unknown default: self = .off
        }
    }

    /// Where the switch sits. `blocked` is on: the registration exists, and a
    /// switch that snapped back to off would say the request was refused when
    /// it was only held.
    public var isOn: Bool { self == .on || self == .blocked }

    /// Whether the row can be operated at all.
    public var isEnabled: Bool { self != .unavailable }

    /// The sentence under the row. Only two states have anything to add: the
    /// ordinary ones are what the switch already says.
    public var caption: String {
        switch self {
        case .on, .off:
            return "Start Birta Jot when you log in, so the hotkey works without opening it first."
        case .blocked:
            return "macOS is holding this until you allow Birta Jot in System Settings, under General and then Login Items."
        case .unavailable:
            return "Only the installed copy can open at login. Run jot/scripts/install-app.sh, then open Birta Jot from Applications."
        }
    }

    /// Whether the caption is reporting a problem rather than describing the
    /// setting.
    public var isWarning: Bool { self == .blocked || self == .unavailable }
}
