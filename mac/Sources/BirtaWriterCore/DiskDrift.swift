import Foundation

/// The C `stat`, through a typed reference because the bare spelling resolves
/// to the STRUCT of that name rather than to the function that fills it.
/// `AtomicFile.existingFile` names the same trap and takes the other way out.
private let statPath: (UnsafePointer<CChar>, UnsafeMutablePointer<stat>) -> Int32 = stat

/// What the file system says about a file, cheaply: which file it is, when it
/// last changed and how long it is.
///
/// A stat rather than the bytes, because it is asked at every summon and
/// before every write, and a stat costs the same for a large note as for an
/// empty one. It is a FILTER, never the verdict: a stamp that matches means
/// nothing has touched the file, and a stamp that does not match means only
/// that something might have, which `DiskDrift.judge` settles by reading.
///
/// The identity half is what makes it reliable. Anything that replaces a file
/// rather than rewriting it, which is what an atomic save is and what this app
/// does too, publishes a new inode, and no clock is involved in noticing that.
/// A rewrite IN PLACE is caught by the modification time instead, and that
/// half is only as good as the volume's clock: `DiskDriftTests` holds that two
/// same-length rewrites back to back stamp differently, which is a statement
/// about the volume the tests run on rather than about every file system. On
/// one whose times are coarse (a FAT volume, some network mounts), a same-size
/// in-place rewrite inside one tick reads as no change at all. Nothing here
/// can fix that; a host that had to would compare the bytes every time.
public struct DiskStamp: Equatable, Sendable {
    public let device: Int
    public let inode: Int
    public let modified: Date
    public let size: Int

    public init(device: Int, inode: Int, modified: Date, size: Int) {
        self.device = device
        self.inode = inode
        self.modified = modified
        self.size = size
    }

    /// From the file system's own answer, and the ONLY way a stamp is made, so
    /// that a stamp taken from a path and one taken from an open file are
    /// comparable.
    ///
    /// `FileManager` must not become a second source. Its modification date
    /// and a `Date` built from the same `timespec` agree to every digit either
    /// will print and still compare unequal, so a stamp made through it would
    /// match nothing made here, and a baseline that never matches turns every
    /// look into a whole-file read. `AtomicFileTests` holds a write's stamp
    /// equal to the stamp of the path it wrote.
    init(_ st: stat) {
        device = Int(st.st_dev)
        inode = Int(st.st_ino)
        modified = Date(timeIntervalSince1970: TimeInterval(st.st_mtimespec.tv_sec)
                        + TimeInterval(st.st_mtimespec.tv_nsec) / 1_000_000_000)
        size = Int(st.st_size)
    }

    /// The stamp of the file at `url`, following a symlink the way
    /// `AtomicFile.write` does, or nil when there is no regular file there.
    public static func of(_ url: URL) -> DiskStamp? {
        var st = stat()
        guard statPath(url.resolvingSymlinksInPath().path, &st) == 0,
              st.st_mode & S_IFMT == S_IFREG
        else { return nil }
        return DiskStamp(st)
    }

    /// The stamp of a file that is OPEN, which is the only way to describe the
    /// file a write published rather than whatever is at its path afterwards.
    ///
    /// A descriptor names an inode, so this answers about the bytes just
    /// written even if something replaces the path a moment later, which is
    /// exactly the case a stat after the rename cannot tell apart.
    public static func ofOpenFile(_ descriptor: Int32) -> DiskStamp? {
        var st = stat()
        guard fstat(descriptor, &st) == 0, st.st_mode & S_IFMT == S_IFREG else { return nil }
        return DiskStamp(st)
    }
}

/// The file as the app last knew it: the bytes it last read from the path or
/// wrote to it, and the stamp the file had then.
///
/// The stamp is optional because a write is handed to a background writer and
/// lands later; until the writer reports the stamp it produced, the bytes are
/// the only record, and they are enough.
public struct DiskBaseline: Equatable, Sendable {
    public var stamp: DiskStamp?
    public var content: String

    public init(stamp: DiskStamp?, content: String) {
        self.stamp = stamp
        self.content = content
    }
}

/// Whether the bound file changed underneath the app, and what to do about it.
///
/// The Mac half of what `src/externalChanges.ts` (a clean document) and
/// `src/diskDrift.ts` (a dirty one) are for the extension, and the same two
/// answers: a buffer with nothing the file lacks takes the file, and a buffer
/// that has diverged from a file that has ALSO moved is never written over it
/// until somebody says which one wins (`docs/PERSISTENCE.md`, promise 2).
///
/// "Clean" is asked of the bytes, not of the Edited flag. With autosave on the
/// flag clears every time the debounce fires, and a buffer in step with what
/// was last written holds nothing to lose; a buffer that differs from it holds
/// exactly what the person typed since, whatever the flag says.
public enum DiskDrift: Equatable, Sendable {
    /// Nothing outside the app changed the file. Write as the policy says, and
    /// keep this as the baseline.
    case inStep(DiskBaseline)
    /// The file changed and the buffer did not: take the file's bytes into the
    /// buffer, and write nothing.
    case reread(DiskBaseline)
    /// Both changed. Write nothing, and ask. `disk` is what the file holds and
    /// `stamp` when it held it, so an answer can be checked against the
    /// version that was actually shown.
    case conflict(disk: String, stamp: DiskStamp?)
    /// There is no readable file at the path. Not this rule's question:
    /// a missing file is `NoteWatcher` and `noteMissing`, an unreadable one is
    /// `NoteRead`, and a note never yet written is legitimately absent.
    case unavailable

    /// Decide, reading the file only when the stamp cannot settle it.
    ///
    /// - Parameters:
    ///   - baseline: the file as the app last knew it.
    ///   - current: the file's stamp now. Taken BEFORE `read`, so a change
    ///     landing between the two leaves a stamp older than the bytes, and
    ///     the next look reads again rather than trusting a stamp that
    ///     describes something newer than what was compared.
    ///   - read: the file's bytes now.
    ///   - buffer: what the app would write.
    public static func judge(baseline: DiskBaseline, current: DiskStamp?,
                             read: () -> NoteRead, buffer: String) -> DiskDrift {
        if let known = baseline.stamp, known == current {
            return .inStep(baseline)
        }
        guard current != nil, case .contents(let disk) = read() else { return .unavailable }
        // The stamp moved and the bytes did not: our own write landing, a
        // `touch`, a tool that rewrote the same text. Nothing to reconcile.
        if disk == baseline.content {
            return .inStep(DiskBaseline(stamp: current, content: disk))
        }
        // Both moved, to the same place: nothing is lost whichever wins.
        if buffer == disk {
            return .inStep(DiskBaseline(stamp: current, content: disk))
        }
        if buffer == baseline.content {
            return .reread(DiskBaseline(stamp: current, content: disk))
        }
        return .conflict(disk: disk, stamp: current)
    }

    // ── The question, with no window ──────────────────────────────────────

    /// The question, naming the file the way its window title does.
    public static func title(document: String) -> String {
        "“\(document)” was changed by another app."
    }

    /// What each answer does, because both lose something and neither is the
    /// obvious default.
    public static let detail =
        "It changed on disk while this window had edits of its own. Reload from Disk shows the other version and drops the edits here; Keep My Changes saves this version over it."

    public static let reloadTitle = "Reload from Disk"
    public static let keepTitle = "Keep My Changes"

    /// What the person said.
    public enum Answer: Equatable, Sendable {
        /// Take the file's bytes into the buffer.
        case reload
        /// Write the buffer over the file.
        case keep
    }

    /// The name the buffer is kept under beside the file, when the app has to
    /// go before anybody has answered: a quit or a closed window with a
    /// conflict outstanding. Beside the file rather than over it, which is the
    /// same answer the app gives for a note deleted underneath it.
    public static func unsavedStem(for stem: String) -> String {
        "\(stem) (unsaved)"
    }
}
