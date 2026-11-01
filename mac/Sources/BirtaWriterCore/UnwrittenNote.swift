import Foundation

/// A note a folder window's new tab is bound to before any file has its name
/// (MAR-488).
///
/// Cmd+T in a rooted window opens the Folder Overview over a new note, and a
/// tab opened that way is as often used to go somewhere else (a dot, a recent
/// file) as to write in. A file made up front would leave an empty Untitled
/// note in the folder for every tab used only to navigate, so the tab is bound
/// to a name the folder does not hold yet, and the file is made by the first
/// write that has something to put in it.
///
/// This is not the missing-file state, and must never be read as one. A note
/// that is missing was on disk and has gone, so the buffer may be the only
/// copy of it and the window offers Restore or Save It Back. A note that is
/// unwritten was never on disk, so there is nothing to restore and nothing to
/// save back; the window is simply a blank note.
///
/// The window holds the two facts every rule here reads: whether the note is
/// still waiting for its first text, and what the buffer holds. "Waiting"
/// ends when a write lands, when somebody asks for a save, and when the tab
/// is rebound to another file.
public enum UnwrittenNote {
    /// Whether a write the app makes on its own (an autosave, hiding the
    /// window, closing the tab, quitting, leaving for another file) may go
    /// ahead. The one it refuses is the write that would create the file to
    /// hold nothing, because that write is exactly the Untitled note this
    /// type exists to stop leaving behind.
    ///
    /// Whitespace counts as nothing: a file holding only a newline is still
    /// an empty note in the reader's folder.
    public static func mayWrite(awaitingText: Bool, buffer: String) -> Bool {
        !awaitingText || !isBlank(buffer)
    }

    /// Whether the window counts as vacant, so the next file opened from
    /// outside into its folder takes the tab over rather than opening beside
    /// it (`OpenRouting`'s `vacantFront`).
    ///
    /// An unwritten note with nothing in it is vacant for the same reason a
    /// missing one is: leaving it costs nothing. One the reader has typed
    /// into is not, even though nothing is on disk yet, because then the
    /// buffer is the only copy of what they wrote.
    public static func isVacant(noteMissing: Bool, awaitingText: Bool, buffer: String) -> Bool {
        noteMissing || (awaitingText && isBlank(buffer))
    }

    /// Whether the buffer holds text that is nowhere on disk because the
    /// note has never been written: unwritten bytes, whatever the edited flag
    /// says. The flag is set by the page's sync, and a flush can bring the
    /// first text across without one, so a rule that asks "is there anything
    /// to lose" asks this too.
    public static func holdsTextOnlyInBuffer(awaitingText: Bool, buffer: String) -> Bool {
        awaitingText && !isBlank(buffer)
    }

    private static func isBlank(_ text: String) -> Bool {
        text.allSatisfy(\.isWhitespace)
    }
}
