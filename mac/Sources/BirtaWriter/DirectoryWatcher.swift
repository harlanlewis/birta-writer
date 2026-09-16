import Foundation
import CoreServices

/// Watches the folder a directory window is rooted at, so the explorer's
/// listing follows what happens on disk (MAR-457).
///
/// FSEvents rather than a `DispatchSource` on a descriptor, and the reason is
/// the shape of the tree: a vnode source is one open descriptor per directory
/// watched, and the folder under a directory window is as deep as the person
/// made it. One FSEvents stream covers the whole subtree and reports the
/// DIRECTORIES that changed, which is exactly the grain the page re-lists at.
/// `NoteWatcher` keeps its `NSFilePresenter` for the bound file, because that
/// one has to say where a file went and this one only has to say that a
/// folder changed.
///
/// `NoDefer` so the first event of a burst arrives at once and the rest are
/// coalesced behind the latency; `WatchRoot` so a root that is itself renamed
/// or moved is reported rather than watched at a path nothing is at any more.
/// Callbacks arrive on the main queue.
@MainActor
final class DirectoryWatcher {
    let root: URL
    /// The folders whose contents changed, as absolute URLs. The caller turns
    /// them into paths the page understands.
    var onChange: (([URL]) -> Void)?

    private var stream: FSEventStreamRef?

    init(root: URL) {
        self.root = root
    }

    func start() {
        guard stream == nil else { return }
        var context = FSEventStreamContext()
        context.info = Unmanaged.passUnretained(self).toOpaque()
        let flags = UInt32(kFSEventStreamCreateFlagWatchRoot)
            | UInt32(kFSEventStreamCreateFlagNoDefer)
            | UInt32(kFSEventStreamCreateFlagUseCFTypes)
        guard let made = FSEventStreamCreate(
            kCFAllocatorDefault,
            { _, info, count, eventPaths, _, _ in
                guard let info else { return }
                let watcher = Unmanaged<DirectoryWatcher>.fromOpaque(info).takeUnretainedValue()
                let paths = (unsafeBitCast(eventPaths, to: NSArray.self) as? [String]) ?? []
                // Already on the main queue (`FSEventStreamSetDispatchQueue`
                // below), so this is the isolation the compiler cannot see.
                MainActor.assumeIsolated {
                    Measure.trace("fsevents count=\(count) paths=\(paths.prefix(Int(count)).joined(separator: ";"))")
                    watcher.onChange?(Array(paths.prefix(Int(count))).map { URL(fileURLWithPath: $0, isDirectory: true) })
                }
            },
            &context,
            [root.path] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.25,
            flags) else {
            Measure.trace("fsevents create failed root=\(root.path)")
            return
        }
        FSEventStreamSetDispatchQueue(made, .main)
        let started = FSEventStreamStart(made)
        Measure.trace("fsevents watching root=\(root.path) started=\(started)")
        stream = made
    }

    func stop() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }

    deinit {
        // A stream that outlives its watcher calls into freed memory; the
        // context above holds `self` unretained on purpose, so this is the
        // pairing that keeps it safe.
        if let stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
    }
}
