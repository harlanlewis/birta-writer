import Foundation

/// Atomic file replacement: write to a sibling temp file, fsync it, then
/// rename over the target. A reader (the user opening the scratchpad in
/// another editor, or this app after a crash) sees either the previous bytes
/// or the new bytes, never a prefix. Same-volume rename is atomic on APFS.
public enum AtomicFile {
    public enum WriteError: Error, Equatable {
        case cannotCreateDirectory(String)
        case cannotOpenTemp(String)
        case writeFailed(String)
        case renameFailed(String)
    }

    /// Write `data` to `url` atomically, creating the parent directory. The
    /// file is created 0600: a scratchpad is private by default.
    public static func write(_ data: Data, to url: URL) throws {
        let dir = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            throw WriteError.cannotCreateDirectory(dir.path)
        }
        let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
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
        if ok { ok = fsync(fd) == 0 }
        close(fd)
        guard ok else {
            unlink(tmp.path)
            throw WriteError.writeFailed(tmp.path)
        }
        guard rename(tmp.path, url.path) == 0 else {
            unlink(tmp.path)
            throw WriteError.renameFailed(url.path)
        }
    }

    public static func writeString(_ text: String, to url: URL) throws {
        try write(Data(text.utf8), to: url)
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
    /// Number of writes actually performed; tests read it.
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
                try AtomicFile.writeString(job.content, to: job.url)
                lock.lock(); writeCount += 1; lock.unlock()
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
