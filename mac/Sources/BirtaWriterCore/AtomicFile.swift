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
///
/// One of the three is NOT fixed and cannot be: a real edit still publishes a
/// new inode, because replacing by rename is what makes the write atomic. So a
/// hard link to the file still breaks, and so do extended attributes, ACLs and
/// BSD flags. Only the unchanged-content skip leaves an inode alone, and it
/// does that by not writing at all.
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
        try writeReporting(data, to: url).wrote
    }

    /// What a write put on disk: whether it wrote, and WHICH file it left
    /// there.
    ///
    /// The stamp is taken from the descriptor while the bytes are still a temp
    /// file, before the rename publishes them. Taking it afterwards, by
    /// stat'ing the path, describes whatever is at that path at that instant,
    /// which is not the same claim: another program replacing the file in the
    /// moment between the rename and the stat hands back ITS file as ours, and
    /// a caller holding that stamp as its baseline (`DiskDrift`) then finds
    /// the file unchanged and writes over bytes nobody read. Measured with
    /// that window widened by hand: our bytes, their stamp, every time.
    public struct WriteResult: Equatable, Sendable {
        /// Bytes were written, rather than the target already holding them.
        public let wrote: Bool
        /// The file this call is about: the one it published, or the one that
        /// already held these bytes. Nil only when the file system refused to
        /// describe it.
        public let stamp: DiskStamp?
    }

    /// Test seam: run after the bytes are published and before this call
    /// returns, which is the window another program's write can land in.
    ///
    /// Here rather than in the test because the window is inside this
    /// function, and a test that cannot get into it can only assert the
    /// arrangement rather than the behaviour: taking the stamp from the path
    /// afterwards passes every check that stays outside. `AtomicFileTests` is
    /// the only thing that sets it, and it is nil in the app.
    nonisolated(unsafe) static var afterPublishForTests: (() -> Void)?

    public static func writeReporting(_ data: Data, to url: URL) throws -> WriteResult {
        // Resolve BEFORE anything derives a path from the target, so the temp
        // file, the directory creation and the rename all speak about the real
        // file rather than about a link to it.
        let target = url.resolvingSymlinksInPath()
        // Before the comparison below reads the file, so a stamp this returns
        // can only be older than the bytes it was compared against. The other
        // order records a file as unchanged that has already moved on.
        let before = DiskStamp.of(target)
        let existing = existingFile(at: target)

        if let existing, existing.isRegularFile, contentsEqual(target, data, size: existing.size) {
            return WriteResult(wrote: false, stamp: before)
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
            // Best effort, and only when ownership could actually be read: a
            // volume that reports none (exFAT, some network mounts) would
            // otherwise have us ask to give the file to root, since 0 is what
            // "unknown" would collapse to. Giving a file away needs privilege
            // we usually lack anyway, and a preserved mode with the caller's
            // ownership still beats refusing the write.
            if let uid = existing.uid, let gid = existing.gid {
                _ = fchown(fd, uid, gid)
            }
        }
        if ok { ok = fsync(fd) == 0 }
        // While it is still open, and therefore still a claim about THIS file
        // rather than about whatever ends up at the path. The mode and owner
        // above are already on it, and a rename changes none of the three.
        let published = DiskStamp.ofOpenFile(fd)
        close(fd)
        guard ok else {
            unlink(tmp.path)
            throw WriteError.writeFailed(tmp.path)
        }
        guard rename(tmp.path, target.path) == 0 else {
            unlink(tmp.path)
            throw WriteError.renameFailed(target.path)
        }
        afterPublishForTests?()
        return WriteResult(wrote: true, stamp: published)
    }

    @discardableResult
    public static func writeString(_ text: String, to url: URL) throws -> Bool {
        try write(Data(text.utf8), to: url)
    }

    public static func writeStringReporting(_ text: String, to url: URL) throws -> WriteResult {
        try writeReporting(Data(text.utf8), to: url)
    }

    // ── The target's identity, as the file system reports it ──────────────

    private struct Existing {
        let mode: mode_t
        /// Absent when the volume reports no ownership; see the fchown call.
        let uid: uid_t?
        let gid: gid_t?
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
            uid: (a[.ownerAccountID] as? NSNumber).map { uid_t($0.uint32Value) },
            gid: (a[.groupOwnerAccountID] as? NSNumber).map { gid_t($0.uint32Value) },
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
    private let queue = DispatchQueue(label: "com.birtalabs.birta-writer.writer", qos: .utility)
    private let lock = NSLock()
    private var pending: (url: URL, content: String)?
    private var inFlight = false
    private let onError: (Error) -> Void
    /// Number of writes that actually touched the file; tests read it. A submit
    /// whose content already matched the file on disk is not counted, because
    /// nothing was written.
    public private(set) var writeCount = 0
    /// The file as this writer left it, stamped on the writing queue rather
    /// than by whoever submitted: a write lands after `submit` returns, so the
    /// submitter cannot stat the result without racing its own write.
    ///
    /// It is what keeps the app's own writes from reading as somebody else's
    /// change (`DiskDrift`), and it is only ever a shortcut: a caller that
    /// cannot match it reads the bytes instead and reaches the same answer.
    private var landed: (url: URL, content: String, stamp: DiskStamp?)?

    /// The bytes this writer last put at `url` and the stamp they landed
    /// under, or nil when its last write was to another file or did not land.
    ///
    /// A write that THREW leaves this at the previous answer, which is the
    /// whole reason a caller asks the writer rather than assuming its own
    /// submission reached the disk: believing a failed write leaves the app
    /// comparing the buffer against bytes no file holds, and the file's real
    /// contents then read as somebody else's change.
    ///
    /// The stamp is the write's own (`AtomicFile.WriteResult`), taken from the
    /// descriptor before the rename, so it describes the file this writer
    /// published and not whatever is at the path by the time anybody asks.
    public func lastLanded(for url: URL) -> (content: String, stamp: DiskStamp)? {
        lock.lock()
        defer { lock.unlock() }
        guard let landed, landed.url == url, let stamp = landed.stamp else { return nil }
        return (landed.content, stamp)
    }

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
                let result = try AtomicFile.writeStringReporting(job.content, to: job.url)
                lock.lock()
                if result.wrote { writeCount += 1 }
                landed = (job.url, job.content, result.stamp)
                lock.unlock()
            } catch {
                onError(error)
            }
        }
    }

    /// Whether a `drain()` would return without waiting for a write.
    ///
    /// For a caller that must not stand on the main thread but still wants the
    /// baseline when there is nothing to wait for. It is a FACT ABOUT NOW, so
    /// a caller acts on it and does not remember it: a write submitted a
    /// moment later makes it false again, and one in flight makes it true
    /// again the moment it lands, which is what keeps a caller that declines
    /// from declining for ever.
    public var isIdle: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !inFlight && pending == nil
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
