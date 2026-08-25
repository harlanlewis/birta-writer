import AppKit
import BirtaJotCore

/// The two gestures that change where notes live, in one place because two
/// screens make them.
///
/// Settings and the first-run screen ask the same question with the same
/// switch and the same Location row, so what moving one means is written once.
/// A gesture written twice is two gestures that can come to disagree about
/// what off is, and the failure that leaves is silent: whichever screen
/// somebody used decides where their notes are.
///
/// What a gesture IS here: write the one setting, redraw the rows it decides,
/// and offer to carry the notes across. The offer is `NotesMoveOffer`'s and
/// the ordering constraint behind `BeforeReload` is its header's; this only
/// guarantees that neither surface can change the location without asking.
///
/// Reading the old folder BEFORE the write is the one line order matters on:
/// it is the folder being left, and once the preference has moved there is
/// nothing left to compute it from.
@MainActor
enum NoteLocationChange {

    /// The iCloud switch moved.
    ///
    /// On is the folder the app derives inside iCloud Drive, off is the folder
    /// named in the Location row. Nothing is cleared either way: the stored
    /// path is the off branch's own value (`NoteHome`), so it waits rather
    /// than overruling the switch, and somebody who tries iCloud and comes
    /// back finds the folder they named still there. Clearing it here would
    /// make trying iCloud a way to lose that folder.
    static func storeInICloud(_ on: Bool,
                              in window: NSWindow?,
                              redraw: () -> Void,
                              apply: @escaping (BeforeReload?) -> Void) {
        let previous = Prefs.notesDirectory
        Prefs.storeInICloud = on
        redraw()
        NotesMoveOffer.offer(movingFrom: previous, to: Prefs.notesDirectory,
                             in: window, apply: apply)
    }

    /// The Location row was clicked: name the folder the off branch uses.
    ///
    /// A save panel rather than an open panel, because what is chosen is the
    /// note itself and its folder is where the rest go
    /// (`Prefs.notesDirectory`). `DocumentTypes.writtenContentTypes` is what
    /// this app writes rather than the wider set it opens.
    static func chooseLocation(in window: NSWindow,
                               redraw: @escaping () -> Void,
                               apply: @escaping (BeforeReload?) -> Void) {
        let panel = NSSavePanel()
        panel.title = "Where your notes live"
        panel.nameFieldStringValue = Prefs.scratchpadURL.lastPathComponent
        panel.directoryURL = Prefs.scratchpadURL.deletingLastPathComponent()
        panel.allowedContentTypes = DocumentTypes.writtenContentTypes
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else { return }
            use(url, in: window, redraw: redraw, apply: apply)
        }
    }

    /// A folder was named. The panel is the only part of the gesture above
    /// that a check cannot drive, so everything the choice MEANS is here.
    ///
    /// Setting the switch is the half that is easy to leave out and expensive
    /// to leave out. Naming a folder IS choosing the off branch, and the row
    /// is already drawn that way, because the branch in force is what it
    /// reads. The preference underneath can still say iCloud, on the one Mac
    /// where this row is reachable with the switch on: iCloud Drive off in
    /// System Settings. Left saying it, the choice holds until somebody
    /// switches iCloud Drive on there, and then the notes go back to the
    /// derived folder with nothing asked and nothing said.
    static func use(_ url: URL,
                    in window: NSWindow?,
                    redraw: () -> Void,
                    apply: @escaping (BeforeReload?) -> Void) {
        let previous = Prefs.notesDirectory
        Prefs.scratchpadURL = url
        Prefs.storeInICloud = false
        redraw()
        NotesMoveOffer.offer(movingFrom: previous, to: Prefs.notesDirectory,
                             in: window, apply: apply)
    }
}
