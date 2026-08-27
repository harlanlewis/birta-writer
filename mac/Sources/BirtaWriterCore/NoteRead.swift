import Foundation

/// What is at the note's path, as three answers rather than two.
///
/// The distinction this type exists for is between a file that is NOT THERE
/// and a file that is there and could not be read. Both come back from
/// `try? String(contentsOf:)` as nil, and collapsing them to the empty string
/// is a data-loss bug rather than a tidiness one: the app mounts the empty buffer,
/// the autosave ceiling comes round, and the buffer is written over the note.
///
/// That collapse was harmless while the note lived in Application Support,
/// where nothing but the app ever touched it, so nil really did mean "no note
/// yet". It stopped being harmless the moment the note could live in iCloud
/// Drive, because there the file is routinely present-but-unreadable:
///
///   - On a second Mac it may not have downloaded yet, which is not an edge
///     case but the headline use of syncing at all.
///   - With Optimize Mac Storage on, macOS evicts a file it has not seen used
///     and leaves a `.<name>.icloud` placeholder in its place, so the path
///     stops existing while the note very much still does.
///
/// `Coordinator` turns `.unreadable` into "do not set `hasLoaded`", which is
/// the guard already standing there for exactly this reason, and asks iCloud
/// to fetch the file. Nothing is written until a read succeeds.
public enum NoteRead: Equatable, Sendable {
    /// The file was read. Its contents, which may legitimately be empty.
    case contents(String)
    /// Nothing is at that path and nothing is coming: a new note.
    case absent
    /// Something IS there and could not be read. Never write over this.
    case unreadable(UnreadableReason)

    public enum UnreadableReason: Equatable, Sendable {
        /// iCloud has evicted the file and left a placeholder beside it.
        case notDownloaded
        /// The path exists and the read failed for some other reason.
        case unreadableFile
    }

    /// The name macOS gives the placeholder it leaves behind when it evicts
    /// `Note.md`: `.Note.md.icloud`, in the same directory.
    ///
    /// Spelled here rather than at the call site, and derived from the file's
    /// own name, so a note whose name changes keeps being detectable.
    public static func placeholderName(for fileName: String) -> String {
        ".\(fileName).icloud"
    }

    /// Read `url`, distinguishing all three cases.
    ///
    /// The placeholder is checked BEFORE the plain absence, because when a
    /// file is evicted both are true of the path at once: the note's own path
    /// does not exist, and the placeholder beside it does. Asking in the other
    /// order answers `.absent` for every evicted note, which is the bug.
    public static func read(at url: URL, fileManager: FileManager = .default) -> NoteRead {
        if let text = try? String(contentsOf: url, encoding: .utf8) {
            return .contents(text)
        }
        let placeholder = url
            .deletingLastPathComponent()
            .appendingPathComponent(placeholderName(for: url.lastPathComponent))
        if fileManager.fileExists(atPath: placeholder.path) {
            return .unreadable(.notDownloaded)
        }
        // The path itself existing while the read failed is the other way a
        // note can be there and unavailable: a permission problem, or a sync
        // daemon swapping the file underneath the read.
        if fileManager.fileExists(atPath: url.path) {
            return .unreadable(.unreadableFile)
        }
        return .absent
    }

    /// What to tell the user, or nil when there is nothing to say.
    ///
    /// Both halves matter and the second is the one easily left out. The note
    /// being safe is what the guard achieves, and saying only that leaves
    /// someone looking at an apparently empty panel with no reason not to type
    /// into it — and the app is refusing to write, so that typing would go
    /// nowhere. "Nothing saves" carries both at once.
    ///
    /// SHORT, and that is a constraint rather than a preference: these are
    /// drawn in `StatusOverlay`, which is one line of a fixed height, no wider
    /// than half the window, and truncated in the MIDDLE. A two-sentence
    /// warning there loses its own middle and reads as damage. `messageLimit`
    /// is asserted in the tests so a later edit cannot quietly outgrow the
    /// surface, since nothing about writing the string says how it is drawn.
    public var message: String? {
        switch self {
        case .contents, .absent:
            return nil
        case .unreadable(.notDownloaded):
            return "Waiting for iCloud. Nothing saves until this note arrives."
        case .unreadable(.unreadableFile):
            return "Cannot read this note. Nothing saves until it can be read."
        }
    }

    /// The longest a `message` may be, set by the surface that draws it rather
    /// than by taste. The existing overlay strings sit just under this.
    public static let messageLimit = 64
}
