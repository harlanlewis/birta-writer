import Foundation

/// Why the buffer is being written.
public enum WriteTrigger: Equatable, Sendable, CaseIterable {
    /// The page reported a document change.
    case edit
    /// The user asked, with Cmd+S or the menu item.
    case explicitSave
    /// The panel is going away, by hotkey, Escape or the close button.
    case panelHidden
    /// The app is quitting, by menu, SIGTERM or an installer swapping it out.
    case terminating
}

/// Whether a write happens now, later, not at all, or only if the user says so.
public enum WriteAction: Equatable, Sendable {
    /// Write immediately, before whatever comes next.
    case now
    /// Write once the edits settle. Only an edit defers.
    case deferred
    /// Do not write.
    case skip
    /// Put the question to the user: save, discard, or do not go.
    ///
    /// Where nobody can be asked, WRITE. A quit nobody initiated (a SIGTERM
    /// from an installer, the swap at the end of a self-update) has no one in
    /// front of it to answer a sheet, and the choice there is between keeping
    /// somebody's typing and throwing it away to honour a preference about
    /// when files are written. The bytes win.
    case ask
}

/// When Jot writes the buffer to disk, as one pure function.
///
/// The setting a user sees is "Automatically save changes", and with it
/// ON nothing here is a question: an edit is deferred a beat and everything
/// else writes at once.
///
/// OFF means what the platform means by it, which is the part worth being
/// careful about, because it is a promise in both directions. Jot does not
/// write while you type, and it does not write behind your back when the panel
/// goes away either: the buffer stays in memory, the title says Edited, and
/// Cmd+S is what puts it on disk. That is how every macOS application with
/// unsaved changes behaves, and it is the whole reason somebody switches this
/// off: a note they are not ready to keep should not already be a file on
/// disk they have to go and undo.
///
/// Hiding and quitting are the two that look alike and are not. Hiding the
/// panel is putting a window away in an application that is still running, so
/// there is nothing to lose and nothing to ask about; a prompt on a gesture
/// somebody makes twenty times a day is a prompt they learn to dismiss without
/// reading. Quitting is the end of the buffer, so it is the moment the
/// question has to be asked, and macOS asks it as a sheet on the window with
/// Save, Discard and Cancel. `.ask` is that sheet.
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
        case .panelHidden:
            return autosaveEnabled ? .now : .skip
        case .terminating:
            return autosaveEnabled ? .now : .ask
        case .explicitSave:
            // The one trigger the setting has nothing to say about: it IS the
            // user saying so.
            return .now
        }
    }

    /// Whether the question `.ask` names can actually be PUT to somebody.
    ///
    /// `.ask` says the setting wants the user asked. This says whether there
    /// is anybody there to answer, and the two are separate facts: a quit is
    /// waiting on the answer (`applicationShouldTerminate` replied
    /// `.terminateLater`), so a question nobody can answer is not a question,
    /// it is an app that cannot be quit. Where it comes back false the caller
    /// keeps the bytes, which is the same direction `WriteAction.ask`'s own
    /// header takes for a quit nobody initiated.
    ///
    /// Three ways to have nowhere to put it, and all three are about the panel
    /// rather than about the person:
    ///
    ///   - the panel is not on screen. A sheet begun on a window that never
    ///     appears never calls back.
    ///   - the panel is showing the FIRST-RUN screen. It is on screen, so the
    ///     sheet would be drawn, and it would still be the wrong question in
    ///     both directions: it names a document behind a screen that is still
    ///     asking where documents go, and the write embargo that screen
    ///     carries means Save could not do what its label says. Nothing there
    ///     can bring the buffer and the file back into step, so this is the
    ///     one state where the question can never stop being asked.
    ///   - the panel is ALREADY asking something else. A window shows one
    ///     sheet at a time and queues the rest, so this question would wait
    ///     behind the other one while the quit waits on it, and a person who
    ///     pressed Quit would watch nothing happen. That became reachable when
    ///     the host-prompt seam gave the page a way to put its own sheet on
    ///     this window (MAR-395), and it is about the seam rather than about
    ///     `/help`: every flow that ever moves onto it inherits the case.
    public static func canAsk(panelIsUp: Bool,
                              firstRunScreenIsUp: Bool,
                              anotherSheetIsUp: Bool) -> Bool {
        panelIsUp && !firstRunScreenIsUp && !anotherSheetIsUp
    }
}
