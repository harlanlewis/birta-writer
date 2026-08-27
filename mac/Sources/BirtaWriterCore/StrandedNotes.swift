import Foundation

/// WHETHER a launch has opened a notes folder that is not the one the last
/// launch wrote to, and which folder the writing was left in.
///
/// The notes folder is DERIVED rather than stored: `ScratchpadLocation` spells
/// it from the product name, so a rename moves it with the user changing
/// nothing. The app then opens a fresh, empty home and looks as if it were
/// working correctly, while the notes sit in a folder under the old spelling
/// with no error, no bar and no message anywhere to say so.
///
/// `NotesMove` is the machinery for carrying notes across, and it is sound.
/// What it lacked was a caller on this path: its offer is reached only from
/// the two settings that change the location by hand, and a rename touches no
/// setting.
///
/// A RECORDED directory is what the comparison stands on, rather than a list
/// of former spellings. The list is the version that rots: it grows with every
/// rename and is silently wrong the first time somebody forgets to add to it.
/// The record is written by the same launch that resolves the folder, so it
/// costs nothing to keep in step.
///
/// The price of not keeping the list is stated rather than hidden: a rename
/// that happened before anything was recorded leaves nothing to compare
/// against, so the first launch that records one can only record.
///
/// Pure, and takes existence as a predicate, so a test names temporary
/// directories and gets a real answer.
public enum StrandedNotes {

    /// The directory a launch should offer to carry notes out of, or nil when
    /// there is nothing to ask about.
    ///
    /// - Parameters:
    ///   - recorded: the derived directory the last launch used, if one was
    ///     ever written down.
    ///   - derived: the derived directory in force now.
    ///   - usesChosenPath: whether the folder in force is one the user named
    ///     rather than one the app derives.
    ///   - exists: whether a directory is on disk.
    public static func directory(recorded: URL?,
                                 derived: URL,
                                 usesChosenPath: Bool,
                                 exists: (URL) -> Bool) -> URL? {
        // A folder somebody named by hand is derived from nothing, so no
        // rename can move it, and the derived folders are not where their
        // notes are. The settings that change that choice do their own asking.
        //
        // Whether such a folder is IN FORCE, rather than merely stored: the
        // iCloud branch derives its folder while a path the user chose sits
        // remembered beside it (`NoteHome`), and asking the stored value there
        // would switch this check off for exactly the people a rename can
        // still move.
        guard !usesChosenPath else { return nil }
        // Nothing was ever recorded, so nothing is known to have moved. The
        // caller records and asks nothing, which is also what a genuine first
        // launch looks like.
        guard let recorded else { return nil }
        guard recorded.standardizedFileURL != derived.standardizedFileURL else { return nil }
        // The folder the last launch used is gone. Its owner moved or deleted
        // it, which is an answer of its own and not ours to reopen.
        guard exists(recorded) else { return nil }
        return recorded
    }
}
