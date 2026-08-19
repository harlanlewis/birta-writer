import Foundation

/// Why the buffer is being written.
public enum WriteTrigger: Equatable, Sendable {
    /// The page reported a document change.
    case edit
    /// The user asked, with Cmd+S or the menu item.
    case explicitSave
    /// The panel is going away, by hotkey, Escape or the close button.
    case panelHidden
    /// The app is quitting, by menu, SIGTERM or an installer swapping it out.
    case terminating
}

/// Whether a write happens now, later, or not at all.
public enum WriteAction: Equatable, Sendable {
    /// Write immediately, before whatever comes next.
    case now
    /// Write once the edits settle. Only an edit defers.
    case deferred
    /// Do not write. Only reachable for an edit with autosave off.
    case skip
}

/// When Jot writes the buffer to disk, as one pure function.
///
/// The setting a user sees is "autosave", and its whole scope is the EDIT
/// trigger. Everything else writes whatever the setting says, because the
/// alternative is a preference that quietly means "lose my work": a person who
/// turns autosave off is asking Jot to stop writing while they type, never to
/// drop the buffer on the floor when the panel hides or the app quits. That
/// distinction is the reason this is a tested function rather than an `if` in
/// a completion handler, and `AutosavePolicyTests` pins it.
///
/// Deferral is separate from permission. An edit that is allowed to be written
/// is still not written on the keystroke: `Debounce` in the coordinator holds
/// it for a beat so a burst of typing is one write rather than hundreds. The
/// bound on how far disk trails the editor is that beat, and nothing else.
public enum AutosavePolicy {
    public static func action(for trigger: WriteTrigger, autosaveEnabled: Bool) -> WriteAction {
        switch trigger {
        case .edit:
            return autosaveEnabled ? .deferred : .skip
        case .explicitSave, .panelHidden, .terminating:
            return .now
        }
    }
}
