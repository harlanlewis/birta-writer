import Foundation

/// Picking the file a note lands in when nobody is asked.
///
/// Save writes to the default destination without a panel, so the name comes
/// from the note rather than from the user, and two notes that start with the
/// same heading, or two saved in the same minute, produce the same name. A
/// silent overwrite there destroys the earlier note with no gesture that says
/// so and no undo, which is why this exists at all: the collision is the
/// normal case for a chute, not an edge.
public enum DestinationName {
    /// How many " 2", " 3" suffixes to try before giving up on a readable name.
    /// Reaching it means a directory holding that many same-named notes, so the
    /// fallback trades legibility for a name that cannot collide.
    static let suffixLimit = 200

    /// A URL in `directory` for `name` that no file occupies.
    ///
    /// - Parameters:
    ///   - name: the suggested file name, extension included.
    ///   - directory: where the note is going.
    ///   - exists: whether a file is already there. Injected so the tests can
    ///     enumerate collision runs without a disk.
    public static func unique(_ name: String,
                              in directory: URL,
                              exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }) -> URL {
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        let stem = base.isEmpty ? "Jot" : base

        func url(_ candidate: String) -> URL {
            directory.appendingPathComponent(ext.isEmpty ? candidate : "\(candidate).\(ext)")
        }

        let first = url(stem)
        if !exists(first) { return first }
        for n in 2...suffixLimit {
            let candidate = url("\(stem) \(n)")
            if !exists(candidate) { return candidate }
        }
        return url("\(stem) \(UUID().uuidString)")
    }
}
