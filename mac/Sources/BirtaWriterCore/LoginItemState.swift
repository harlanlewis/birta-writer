import Foundation
import ServiceManagement

/// What Settings shows for "Open at login", derived from the system's answer.
///
/// The system owns this setting, not the app: it is changed from System Settings
/// just as legitimately as from here, and macOS can overrule a registration
/// without telling the app. So there is no stored preference to drift out of
/// date. Settings asks `SMAppService` every time it shows the row, and this
/// type is the whole of what that answer means.
///
/// Pure so it can be tested: the state that matters most is the one hardest to
/// reach by hand, since `blocked` needs a user who has turned the app off in
/// System Settings' Login Items after turning it on here.
public enum LoginItemState: Equatable, Sendable {
    /// Registered, and macOS will launch it.
    case on
    /// Not registered.
    case off
    /// Registered, and macOS is holding it until the user approves it in
    /// System Settings. The switch reads on, because `SMAppService` documents
    /// this state as a service that registered successfully and is waiting on
    /// the user, so the request does stand; the app just will not launch until
    /// that approval happens.
    case blocked
    /// `SMAppService` reported an error rather than a registration state.
    /// The framework documents this only as "an error occurred and no such
    /// service could be found" and names no cause, so the row says what
    /// happened and offers the usual remedy rather than diagnosing it.
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

    /// The sentence under the row, or empty where the switch says it already.
    /// Only the two states that report a PROBLEM have anything to add, which
    /// is why the ordinary ones are silent rather than restating the label.
    public var caption: String {
        switch self {
        case .on, .off:
            return ""
        case .blocked:
            return "Waiting for your approval in System Settings, under Login Items."
        case .unavailable:
            return "macOS will not register this copy. Open the one in Applications."
        }
    }

    /// Whether the caption is reporting a problem rather than describing the
    /// setting.
    public var isWarning: Bool { self == .blocked || self == .unavailable }
}
