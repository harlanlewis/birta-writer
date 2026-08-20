import AppKit
import BirtaJotCore

/// Watches the file the panel is bound to, so a Finder rename is followed and
/// a delete is noticed before the next write undoes it.
///
/// Jot had no file watcher at all. Disk was re-read at three moments (launch,
/// after an agent run, and on summon when the note was known unreadable), so a
/// rename made while the panel sat idle was invisible, and `AtomicFile.write`
/// creates a missing file AND its whole directory, which means a note deleted
/// in Finder came straight back at the next autosave tick.
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
        let presentedItemOperationQueue = OperationQueue()
        var onMove: ((URL) -> Void)?
        var onDelete: (() -> Void)?

        func presentedItemDidMove(to newURL: URL) {
            let old = presentedItemURL
            // Kept in step here as well as on the main actor, because the next
            // callback compares against it and may arrive first.
            presentedItemURL = newURL
            switch FileMove.classify(from: old ?? newURL, to: newURL) {
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
