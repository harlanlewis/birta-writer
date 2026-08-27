import Foundation

/// What a typed filename MEANS, with no filesystem and no window involved.
///
/// The rename field in the title popover is a text field a person types
/// anything into, and every hard case is decidable before a byte moves:
/// whether they meant to change the name at all, whether what they typed can
/// be a name, and whether dropping the extension was intentional. The move
/// itself belongs to the coordinator, which is where the file is; this is the
/// half that can be checked without one.
///
/// The rules are macOS's rather than ours. Finder refuses `/` and `:` in a
/// name, keeps the extension when you edit only the stem, and does nothing at
/// all when you commit the name it already had.
public enum DocumentName {
    /// What a typed name resolves to.
    public enum Resolution: Equatable, Sendable {
        /// Rename to this file name. Never equal to the current one.
        case rename(to: String)
        /// The typed name is the name it already has, or is only whitespace
        /// around it. Nothing to do, and NOT an error: committing an unchanged
        /// field is the most common thing that happens to it.
        case unchanged
        /// The typed name cannot be a file name, with the reason to show.
        case rejected(reason: String)
    }

    /// Characters a macOS file name cannot contain. `:` is the HFS path
    /// separator and Finder still refuses it; `/` is the POSIX one. A NUL
    /// cannot reach here from a text field and is listed because the rule is
    /// about what a name may hold, not about what this field can produce.
    private static let forbidden: Set<Character> = ["/", ":", "\0"]

    /// Resolve `typed` against the name the file has now.
    ///
    /// `current` is a full file name including its extension, which is what
    /// the field is seeded with, so a person who edits only the stem gets the
    /// extension back and one who types a new extension keeps theirs.
    public static func resolve(typed: String, current: String) -> Resolution {
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return .rejected(reason: "A file needs a name.")
        }
        if trimmed.contains(where: forbidden.contains) {
            return .rejected(reason: "A file name cannot contain / or :.")
        }
        // A name that is only dots is `.`/`..`, which name directories rather
        // than files and would move the note somewhere nobody asked for.
        if trimmed.allSatisfy({ $0 == "." }) {
            return .rejected(reason: "A file needs a name.")
        }
        let resolved = withExtension(of: current, applyingTo: trimmed)
        return resolved == current ? .unchanged : .rename(to: resolved)
    }

    /// `typed` carrying `current`'s extension when it has none of its own.
    ///
    /// The test is a dot with something before AND after it, so `Notes.md`
    /// keeps `.md`, `Notes.txt` keeps the `.txt` the person chose, and
    /// `.hidden` is a stem rather than a bare extension. A `current` with no
    /// extension has nothing to lend, so `typed` stands.
    private static func withExtension(of current: String, applyingTo typed: String) -> String {
        if hasExtension(typed) { return typed }
        let ext = (current as NSString).pathExtension
        return ext.isEmpty ? typed : "\(typed).\(ext)"
    }

    private static func hasExtension(_ name: String) -> Bool {
        guard let dot = name.lastIndex(of: ".") else { return false }
        return dot != name.startIndex && name.index(after: dot) != name.endIndex
    }
}
