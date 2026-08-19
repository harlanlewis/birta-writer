import Foundation

/// Atomic file replacement: write to a sibling temp file, fsync it, then
/// rename over the target. A reader (the user opening the scratchpad in
/// another editor, or this app after a crash) sees either the previous bytes
/// or the new bytes, never a prefix. Same-volume rename is atomic on APFS.
///
/// Rename-over-target is the right shape for a scratchpad the app owns and the
/// wrong shape for a file the user already had, because it replaces rather than
/// updates: a fresh inode, the creating process's mode, and a symlink turned
/// into a regular file. Every rule below exists to make the second case behave
/// like an edit instead of a replacement, and each is at this choke point
/// rather than at a call site so that a new caller cannot forget it.
public enum AtomicFile {
    public enum WriteError: Error, Equatable {
        case cannotCreateDirectory(String)
        case cannotOpenTemp(String)
        case writeFailed(String)
        case renameFailed(String)
    }

    /// Write `data` to `url` atomically, creating the parent directory.
    ///
    /// Returns true when bytes were written, false when the target already held
    /// exactly these bytes and was left alone. A caller that counts writes, or
    /// that reports a save to the user, wants to know the difference.
    ///
    /// Three rules, all of which only bite when the target already exists:
    ///
    /// - **Symlinks are followed, not replaced.** The rename lands on the file
    ///   the link points at, so a link stays a link. This also keeps the temp
    ///   file a sibling of the REAL file, which is what makes the rename a
    ///   same-volume one, and therefore atomic, when the link crosses volumes.
    /// - **An existing file keeps its mode.** 0600 is the right default for a
    ///   scratchpad in Application Support and the wrong thing to impose on a
    ///   file the user made; it is applied only when creating. Ownership is
    ///   restored on a best-effort basis, since only a privileged process can
    ///   give a file away, and failing to is not a reason to lose the write.
    /// - **Identical content is not written.** Dismissing a document you did
    ///   not change must leave its bytes, its mtime and its inode alone. Costs
    ///   a read of the target per write, which is the cheaper side of the trade
    ///   for documents this app holds.
    @discardableResult
    public static func write(_ data: Data, to url: URL) throws -> Bool {
        // Resolve BEFORE anything derives a path from the target, so the temp
        // file, the directory creation and the rename all speak about the real
        // file rather than about a link to it.
        let target = url.resolvingSymlinksInPath()
        let existing = existingFile(at: target)

        if let existing, existing.isRegularFile, contentsEqual(target, data, size: existing.size) {
            return false
        }

        let dir = target.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            throw WriteError.cannotCreateDirectory(dir.path)
        }
        let tmp = dir.appendingPathComponent(".\(target.lastPathComponent).\(UUID().uuidString).tmp")
        let fd = open(tmp.path, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
        guard fd >= 0 else { throw WriteError.cannotOpenTemp(tmp.path) }
        var ok = true
        data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            var offset = 0
            while offset < buf.count {
                let n = Foundation.write(fd, buf.baseAddress!.advanced(by: offset), buf.count - offset)
                if n <= 0 { ok = false; return }
                offset += n
            }
        }
        if ok, let existing {
            // Carry the target's identity onto the replacement while it is
            // still a temp file, so the rename publishes a file that already
            // looks like the one it replaces rather than briefly not.
            _ = fchmod(fd, existing.mode)
            // Best effort: giving a file away needs privilege we usually lack,
            // and a preserved mode with the caller's ownership still beats
            // refusing the write.
            _ = fchown(fd, existing.uid, existing.gid)
        }
        if ok { ok = fsync(fd) == 0 }
        close(fd)
        guard ok else {
            unlink(tmp.path)
            throw WriteError.writeFailed(tmp.path)
        }
        guard rename(tmp.path, target.path) == 0 else {
            unlink(tmp.path)
            throw WriteError.renameFailed(target.path)
        }
        return true
    }

    @discardableResult
    public static func writeString(_ text: String, to url: URL) throws -> Bool {
        try write(Data(text.utf8), to: url)
    }

    // ── The target's identity, as the file system reports it ──────────────

    private struct Existing {
        let mode: mode_t
        let uid: uid_t
        let gid: gid_t
        let size: Int
        let isRegularFile: Bool
    }

    /// The target's existing attributes, or nil when there is nothing there.
    ///
    /// Through FileManager rather than the C `stat`, which cannot be named here:
    /// the function and the struct it fills share the identifier `stat`, and at
    /// a call site inside this type Swift resolves it to the struct's
    /// initializer. FileManager follows symlinks, which is what this wants -
    /// the caller has already resolved the link, and the question is about the
    /// file the write will land on.
    private static func existingFile(at url: URL) -> Existing? {
        guard let a = try? FileManager.default.attributesOfItem(atPath: url.path) else { return nil }
        guard let mode = (a[.posixPermissions] as? NSNumber)?.uint16Value else { return nil }
        return Existing(
            mode: mode_t(mode),
            uid: uid_t((a[.ownerAccountID] as? NSNumber)?.uint32Value ?? 0),
            gid: gid_t((a[.groupOwnerAccountID] as? NSNumber)?.uint32Value ?? 0),
            size: (a[.size] as? NSNumber)?.intValue ?? -1,
            isRegularFile: (a[.type] as? FileAttributeType) == .typeRegular,
        )
    }

    /// Whether the file already holds exactly `data`.
    ///
    /// The size check first is not an optimization for its own sake: it is what
    /// keeps the common case of a real edit from reading the whole file back,
    /// since an edit almost always changes the length.
    private static func contentsEqual(_ url: URL, _ data: Data, size: Int) -> Bool {
        guard size == data.count else { return false }
        guard let onDisk = try? Data(contentsOf: url, options: .mappedIfSafe) else { return false }
        return onDisk == data
    }
}

/// Coalescing writer: many `submit(content)` calls become at most one write in
/// flight plus the newest pending content. Writes run on a private serial
/// queue; `drain()` blocks until the queue is quiet, for quit and tests.
///
/// The webview already debounces `update` (webview/syncScheduler.ts), so this
/// is not a second debounce upstream of that scheduler and must not become
/// one: it never delays a write it has nothing else to do, it only refuses to
/// queue two behind each other.
public final class CoalescingWriter {
    private let queue = DispatchQueue(label: "com.birtalabs.jot.writer", qos: .utility)
    private let lock = NSLock()
    private var pending: (url: URL, content: String)?
    private var inFlight = false
    private let onError: (Error) -> Void
    /// Number of writes that actually touched the file; tests read it. A submit
    /// whose content already matched the file on disk is not counted, because
    /// nothing was written.
    public private(set) var writeCount = 0

    public init(onError: @escaping (Error) -> Void) {
        self.onError = onError
    }

    public func submit(_ content: String, to url: URL) {
        lock.lock()
        pending = (url, content)
        let start = !inFlight
        if start { inFlight = true }
        lock.unlock()
        if start { queue.async { self.pump() } }
    }

    private func pump() {
        while true {
            lock.lock()
            guard let job = pending else {
                inFlight = false
                lock.unlock()
                return
            }
            pending = nil
            lock.unlock()
            do {
                if try AtomicFile.writeString(job.content, to: job.url) {
                    lock.lock(); writeCount += 1; lock.unlock()
                }
            } catch {
                onError(error)
            }
        }
    }

    /// Wait until every submitted write has landed.
    public func drain() {
        queue.sync {}
        // A submit that raced the final `pending = nil` check started a new
        // pump on the queue; the sync above ran after it was enqueued, so a
        // second sync is only needed if something is still in flight.
        lock.lock(); let busy = inFlight; lock.unlock()
        if busy { queue.sync {} }
    }
}
