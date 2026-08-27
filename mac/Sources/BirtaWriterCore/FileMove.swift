import Foundation

/// What it means when the file the app is editing moves.
///
/// macOS reports a Finder rename, a drag to another folder, and a delete as
/// the SAME event: `presentedItemDidMove(to:)` with a new URL. A delete is a
/// move into a trash folder. So "was that a delete" is a rule about the
/// destination rather than a different notification, and getting it wrong is
/// silent in the worst direction: treated as a move, a deleted note leaves the
/// app bound to a file in the Trash and the next autosave writes the buffer
/// back into it, so emptying the Trash loses the note twice over.
///
/// Here, and not at the call site, because it is decidable from the
/// destination and nothing else. A file presenter cannot be driven from a unit
/// test; this can.
public enum FileMove: Equatable, Sendable {
    /// A rename or a move. Follow it: the note is the same note.
    case followed(URL)
    /// A delete. Stop writing and say so.
    case deleted

    /// The names macOS gives a trash folder. `.Trash` is the one in a home
    /// directory; `.Trashes` is the per-volume one, which holds a directory
    /// per user id, so a file deleted from an external disk lands several
    /// levels inside it.
    private static let trashDirectoryNames: Set<String> = [".Trash", ".Trashes"]

    /// Classify a move by where it landed.
    ///
    /// Any trash component anywhere in the destination counts, at any depth,
    /// because the per-volume form nests and because a folder dragged to the
    /// Trash takes its contents with it: the note's own path then names the
    /// folder rather than the trash directory, and only an ancestor says what
    /// happened.
    public static func classify(movedTo destination: URL) -> FileMove {
        let components = destination.standardizedFileURL.pathComponents
        if components.contains(where: trashDirectoryNames.contains) { return .deleted }
        return .followed(destination)
    }
}
