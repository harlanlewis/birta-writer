import AppKit
import BirtaWriterCore

/// Watches the file the panel is bound to, so a Finder rename is followed and
/// a delete is noticed before the next write undoes it.
///
/// A rename made while the panel is idle has to be followed, and a delete has
/// to be noticed before the next write: `AtomicFile.write` creates a missing
/// file and every directory above it, so an unnoticed delete is undone rather
/// than reported. Nothing else re-reads the disk between a launch, an agent
/// run, and a summon onto a note already known unreadable.
///
/// `NSFilePresenter` rather than an FSEvents stream or a `DispatchSource` on a
/// descriptor, for one reason: it is the only one of the three that says WHERE
/// the file went. The others report that the path stopped being what it was,
/// which is enough to warn and not enough to follow.
///
/// The presenter's callbacks arrive on `presentedItemOperationQueue`, which is
/// not the main queue, and everything they lead to (the title, the bar, the
/// bound URL) is main-actor state. Every one of them hops before touching
/// anything.
@MainActor
final class NoteWatcher: NSObject {
    /// The file moved, and it is the same file: rebind and follow it.
    var onMoved: ((URL) -> Void)?
    /// The file is gone. Stop writing and say so.
    var onDeleted: (() -> Void)?

    private final class Presenter: NSObject, NSFilePresenter {
        var presentedItemURL: URL?
        /// Serial. `NSFilePresenter` may deliver on any queue, and an
        /// unbounded one runs its callbacks concurrently, so its own writes to
        /// `presentedItemURL` would race each other. It does not make the
        /// property safe against `NoteWatcher.watch`, which sets it from the
        /// main actor; that write happens only while no presenter of this
        /// object is registered, which is what keeps the pairing apart.
        let presentedItemOperationQueue: OperationQueue = {
            let queue = OperationQueue()
            queue.maxConcurrentOperationCount = 1
            return queue
        }()
        var onMove: ((URL) -> Void)?
        var onDelete: (() -> Void)?

        func presentedItemDidMove(to newURL: URL) {
            // `NSFilePresenter`'s contract: the presented URL follows the item,
            // and the coordination machinery reads it back.
            presentedItemURL = newURL
            switch FileMove.classify(movedTo: newURL) {
            case .followed(let url): onMove?(url)
            case .deleted: onDelete?()
            }
        }

        /// The other way a file goes: deleted outright rather than trashed.
        ///
        /// The completion handler has to be called or the coordinator that is
        /// waiting on it blocks whoever asked for the deletion, which is
        /// usually Finder.
        func accommodatePresentedItemDeletion(completionHandler: @escaping (Error?) -> Void) {
            onDelete?()
            completionHandler(nil)
        }
    }

    private var presenter: Presenter?

    /// Watch `url`, and stop watching whatever came before it.
    ///
    /// Called on every rebinding, New Note and a rename included, so the
    /// presenter is never left pointed at a file the panel has moved off.
    func watch(_ url: URL) {
        stop()
        let presenter = Presenter()
        presenter.presentedItemURL = url
        presenter.onMove = { [weak self] moved in
            Task { @MainActor in self?.onMoved?(moved) }
        }
        presenter.onDelete = { [weak self] in
            Task { @MainActor in self?.onDeleted?() }
        }
        NSFileCoordinator.addFilePresenter(presenter)
        self.presenter = presenter
    }

    func stop() {
        if let presenter { NSFileCoordinator.removeFilePresenter(presenter) }
        presenter = nil
    }

    deinit {
        if let presenter { NSFileCoordinator.removeFilePresenter(presenter) }
    }
}
