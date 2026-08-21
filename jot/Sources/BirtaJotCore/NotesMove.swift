import Foundation

/// What "bring my notes along" actually means when the notes location changes.
///
/// Split from the doing so the decisions can be tested without a filesystem:
/// what moves, where each thing lands once collisions are resolved, and what is
/// deliberately left where it is. `NotesMove.plan` takes the directory listing
/// and an occupancy predicate rather than reading the disk itself.
///
/// Three constraints shape this, and each is a reason the obvious version is
/// wrong.
///
/// SCOPE. `Prefs.notesDirectory` is the scratchpad's PARENT folder, which Jot
/// does not exclusively own. So this never moves a directory wholesale. It
/// takes the notes and the attachments folder and leaves everything else
/// exactly where it is, and what it left is reported rather than silently
/// dropped.
///
/// ATTACHMENTS ARE NEVER RENAMED. A note references `Attachments/<name>.png`
/// relatively, which is what keeps it portable (`AttachmentStore`). Numbering
/// a colliding attachment the way a colliding note is numbered would break
/// every reference to it, in files that still open perfectly, which is the
/// failure most likely to ship unnoticed. So the attachments folder MERGES: a
/// file already at the destination under the same name is skipped when its
/// contents match, and the source is left behind and reported when they do
/// not. `AttachmentStore` names by content hash, so matching names normally
/// mean identical bytes and the skip is the common case.
///
/// A NOTE may be renamed, because nothing references a note by name.
public enum NotesMove {

    /// One thing to carry across, already resolved to where it lands.
    public struct Item: Equatable {
        public let source: URL
        public let destination: URL
        /// An attachment must arrive under its own name or not at all.
        public let renameable: Bool

        public init(source: URL, destination: URL, renameable: Bool) {
            self.source = source
            self.destination = destination
            self.renameable = renameable
        }
    }

    /// Why something is staying where it is, so the report can say.
    public enum Kept: Equatable {
        /// Not a note and not an attachment: someone else's file in a folder
        /// Jot only borrows.
        case notOurs(URL)
        /// An attachment whose name is taken at the destination by different
        /// bytes. Renaming it would break the notes that point at it.
        case attachmentNameTaken(URL)
    }

    public struct Plan: Equatable {
        public let items: [Item]
        public let kept: [Kept]

        /// Notes only, which is the number the button says. Attachments are
        /// carried because the notes need them, not because anyone counts them.
        public var noteCount: Int {
            items.filter { $0.source.deletingLastPathComponent().lastPathComponent
                != AttachmentStore.directoryName }.count
        }

        public var isEmpty: Bool { items.isEmpty }
    }

    /// Extensions Jot treats as a note worth carrying.
    public static let noteExtensions: Set<String> = ["md", "markdown", "txt"]

    /// Build the plan.
    ///
    /// - Parameters:
    ///   - source: the directory the notes are in now.
    ///   - destination: the directory they would move to.
    ///   - entries: everything directly inside `source`.
    ///   - attachments: the files inside `source/Attachments`, if any.
    ///   - occupied: whether a URL is already taken at the destination. Called
    ///     for candidate names, so numbering can step past what is there.
    ///   - identical: whether the destination file at that URL has the same
    ///     contents as the source. Only asked about attachments, and only when
    ///     the name is taken.
    public static func plan(
        from source: URL,
        to destination: URL,
        entries: [URL],
        attachments: [URL] = [],
        occupied: (URL) -> Bool,
        identical: (URL, URL) -> Bool = { _, _ in false }
    ) -> Plan {
        // A rename in place is not a move, and asking about one would be a
        // sheet in front of a gesture that changed no location. The title
        // popover already renames without asking.
        guard source.standardizedFileURL != destination.standardizedFileURL else {
            return Plan(items: [], kept: [])
        }

        var items: [Item] = []
        var kept: [Kept] = []
        // Names this plan has already spoken for, so two sources cannot be
        // numbered onto one destination.
        var claimed: Set<String> = []
        func taken(_ url: URL) -> Bool {
            claimed.contains(url.standardizedFileURL.path) || occupied(url)
        }

        for entry in entries.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let name = entry.lastPathComponent
            if name == AttachmentStore.directoryName { continue }
            guard noteExtensions.contains(entry.pathExtension.lowercased()) else {
                kept.append(.notOurs(entry))
                continue
            }
            let target = unused(in: destination, name: name, taken: taken)
            claimed.insert(target.standardizedFileURL.path)
            items.append(Item(source: entry, destination: target, renameable: true))
        }

        let attachmentDirectory = destination.appendingPathComponent(
            AttachmentStore.directoryName, isDirectory: true)
        for attachment in attachments.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let target = attachmentDirectory.appendingPathComponent(attachment.lastPathComponent)
            if taken(target) && !identical(attachment, target) {
                kept.append(.attachmentNameTaken(attachment))
                continue
            }
            // An identical file already there needs no copy, and is not an
            // item: there is nothing to do and nothing to report.
            if taken(target) { continue }
            claimed.insert(target.standardizedFileURL.path)
            items.append(Item(source: attachment, destination: target, renameable: false))
        }

        return Plan(items: items, kept: kept)
    }

    /// What actually happened, for the sentence afterwards.
    public struct Report: Equatable {
        public let moved: Int
        /// Sources still where they were, because their copy did not survive
        /// verification. Never silently dropped.
        public let failed: [URL]
        public let kept: [Kept]
    }

    /// Carry the plan out: COPY, VERIFY, then remove. Never a bare move.
    ///
    /// A move into iCloud Drive crosses a volume boundary and is an upload
    /// with a delay behind it, so it can fail partway. A `moveItem` that fails
    /// after unlinking the source is a note that existed a moment ago and now
    /// does not. Copying first means the worst case is a duplicate, which the
    /// user can see and delete, rather than a loss they cannot.
    ///
    /// Verification is a SIZE comparison against the source, not a byte
    /// compare: what is being checked is that the local file arrived whole.
    /// Whether iCloud has finished uploading it afterwards is between the user
    /// and iCloud, and is not something Jot can wait for.
    ///
    /// A failure leaves the original exactly where it was and reports it.
    public static func perform(_ plan: Plan, fileManager: FileManager = .default) -> Report {
        var moved = 0
        var failed: [URL] = []

        for item in plan.items {
            do {
                let directory = item.destination.deletingLastPathComponent()
                try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
                try fileManager.copyItem(at: item.source, to: item.destination)

                guard sizesMatch(item.source, item.destination, fileManager) else {
                    // The copy is the suspect one, so it goes and the original
                    // stays. Removing a half-written file is the only way the
                    // retry that follows is not fighting its own leftovers.
                    try? fileManager.removeItem(at: item.destination)
                    failed.append(item.source)
                    continue
                }
                try fileManager.removeItem(at: item.source)
                moved += 1
            } catch {
                failed.append(item.source)
            }
        }
        return Report(moved: moved, failed: failed, kept: plan.kept)
    }

    static func sizesMatch(_ a: URL, _ b: URL, _ fileManager: FileManager) -> Bool {
        let size: (URL) -> Int? = { url in
            (try? fileManager.attributesOfItem(atPath: url.path)[.size] as? Int) ?? nil
        }
        guard let left = size(a), let right = size(b) else { return false }
        return left == right
    }

    /// `name`, then `stem 2.ext`, and so on. Bounded, because the predicate is
    /// supplied: one that always answers yes would otherwise never return.
    static func unused(in directory: URL, name: String, taken: (URL) -> Bool) -> URL {
        let first = directory.appendingPathComponent(name)
        if !taken(first) { return first }
        let ext = (name as NSString).pathExtension
        let stem = (name as NSString).deletingPathExtension
        for n in 2...999 {
            let candidate = directory.appendingPathComponent(
                ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)")
            if !taken(candidate) { return candidate }
        }
        return directory.appendingPathComponent(
            ext.isEmpty ? "\(stem) \(UUID().uuidString)" : "\(stem) \(UUID().uuidString).\(ext)")
    }
}
