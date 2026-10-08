import Foundation

/// What a directory window tells the page about a folder, one level at a time,
/// and the two questions the routing asks of a root (MAR-457).
///
/// The page draws a tree it cannot walk itself: it asks for one folder, gets
/// that folder's entries, and asks again when a folder is opened. So a
/// listing is one `contentsOfDirectory`, never a recursive walk, and the cost
/// of a directory window is proportional to the folders somebody has opened
/// rather than to the tree. Paths cross the wire relative to the root, with
/// POSIX separators, and `""` names the root itself; the host is the side that
/// turns them back into files and refuses one that would leave the root.
public enum DirectoryListing {
    public enum Kind: String, Equatable, Sendable {
        case dir
        case file
    }

    /// One row of a folder as the page draws it.
    public struct Entry: Equatable, Sendable {
        public let name: String
        public let kind: Kind
        /// Whether the editor opens it. A file it does not (an image, a PDF)
        /// is still listed and still activatable; the host hands it to its
        /// default application.
        public let openable: Bool
        /// A dotfile or a file the Finder hides. Sent rather than filtered, so
        /// the page can show and hide them on a setting without a re-list.
        public let hidden: Bool

        public init(name: String, kind: Kind, openable: Bool, hidden: Bool) {
            self.name = name
            self.kind = kind
            self.openable = openable
            self.hidden = hidden
        }

        public var jsonObject: [String: Any] {
            ["name": name, "kind": kind.rawValue, "openable": openable, "hidden": hidden]
        }
    }

    /// The entries of one folder, folders first, each group in the Finder's
    /// order (`localizedStandardCompare`, so `note 2` sorts before `note 10`).
    ///
    /// - Parameter accepts: whether a file is one the editor opens; the app
    ///   passes `DocumentTypes.accepts`.
    public static func entries(of directory: URL,
                               accepts: (URL) -> Bool,
                               fileManager: FileManager = .default) throws -> [Entry] {
        let keys: [URLResourceKey] = [.isDirectoryKey, .isHiddenKey, .isSymbolicLinkKey]
        let urls = try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys,
                                                       options: [])
        let entries = urls.map { url -> Entry in
            let values = try? url.resourceValues(forKeys: Set(keys))
            // A symlink to a folder is listed as a folder, which is what the
            // Finder does and what lets a linked notes folder be walked.
            var isDirectory = values?.isDirectory ?? false
            if values?.isSymbolicLink == true {
                var resolvedIsDirectory: ObjCBool = false
                if fileManager.fileExists(atPath: url.resolvingSymlinksInPath().path,
                                          isDirectory: &resolvedIsDirectory) {
                    isDirectory = resolvedIsDirectory.boolValue
                }
            }
            let name = url.lastPathComponent
            return Entry(name: name,
                         kind: isDirectory ? .dir : .file,
                         openable: !isDirectory && accepts(url),
                         hidden: (values?.isHidden ?? false) || name.hasPrefix("."))
        }
        return sorted(entries)
    }

    /// Folders first, then files, each in the Finder's order.
    public static func sorted(_ entries: [Entry]) -> [Entry] {
        entries.sorted { a, b in
            if a.kind != b.kind { return a.kind == .dir }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }

    // MARK: paths against a root

    /// The root's path as a prefix every file inside it starts with: resolved
    /// through symlinks and standardized, with the trailing slash that stops
    /// `/notes-archive` reading as inside `/notes`.
    private static func prefix(of root: URL) -> String {
        let path = root.resolvingSymlinksInPath().standardizedFileURL.path
        return path.hasSuffix("/") ? path : path + "/"
    }

    /// Whether `file` is inside `root`, on the resolved paths, so a link out
    /// of the root does not count and a link into it does.
    public static func isInside(_ file: URL, root: URL) -> Bool {
        file.resolvingSymlinksInPath().standardizedFileURL.path.hasPrefix(prefix(of: root))
    }

    /// `file` as the page names it: relative to `root`, POSIX separators, or
    /// nil for a file outside the root.
    public static func relativePath(of file: URL, in root: URL) -> String? {
        let resolved = file.resolvingSymlinksInPath().standardizedFileURL.path
        let base = prefix(of: root)
        // The root itself is `""`, which is how the page names it; a watcher
        // reports a change IN the root as the root's own path.
        if resolved == String(base.dropLast()) { return "" }
        guard resolved.hasPrefix(base) else { return nil }
        return String(resolved.dropFirst(base.count))
    }

    /// The file a page-relative path names, or nil when it would leave the
    /// root: a `..` segment, an absolute path, or a link that resolves
    /// outside. `""` is the root itself.
    public static func resolve(_ relative: String, in root: URL) -> URL? {
        guard !relative.hasPrefix("/") else { return nil }
        guard !relative.split(separator: "/").contains("..") else { return nil }
        let candidate = relative.isEmpty ? root : root.appendingPathComponent(relative)
        let resolved = candidate.resolvingSymlinksInPath().standardizedFileURL
        let base = prefix(of: root)
        guard resolved.path == String(base.dropLast()) || resolved.path.hasPrefix(base) else { return nil }
        return candidate
    }

    // MARK: the first file

    /// Which file a directory window opens on.
    ///
    /// The most recently used file inside the root, because that is where the
    /// person was; else the most recently modified file directly in the root
    /// that the editor opens, which is the folder's own answer to "what were
    /// you working on"; else nil, and the caller makes a note in the root. A
    /// window is always one buffer, so "none" is not on offer.
    public static func firstToOpen(in root: URL,
                                   recents: [URL],
                                   accepts: (URL) -> Bool,
                                   fileManager: FileManager = .default) -> URL? {
        if let recent = recents.first(where: {
            isInside($0, root: root) && accepts($0) && fileManager.fileExists(atPath: $0.path)
        }) {
            return recent
        }
        let keys: [URLResourceKey] = [.contentModificationDateKey, .isDirectoryKey]
        guard let urls = try? fileManager.contentsOfDirectory(at: root, includingPropertiesForKeys: keys,
                                                              options: [.skipsHiddenFiles]) else { return nil }
        // Newest first, and `accepts` asked only until one passes. The caller's
        // `accepts` is not cheap (`WindowSet.openDirectory` compares each
        // candidate with every open window's file, a stat apiece), so asking it
        // of every file in a large flat folder put that walk on the main thread
        // before the window could start loading. Ties keep the directory's
        // order, as the `max` this replaced did.
        let dated: [(url: URL, date: Date, order: Int)] = urls.enumerated().compactMap { order, url in
            let values = try? url.resourceValues(forKeys: Set(keys))
            guard values?.isDirectory != true else { return nil }
            return (url, values?.contentModificationDate ?? .distantPast, order)
        }
        let newestFirst = dated.sorted { $0.date != $1.date ? $0.date > $1.date : $0.order < $1.order }
        return newestFirst.first(where: { accepts($0.url) })?.url
    }

    /// How many entries are under `folder`, at any depth, for the question
    /// asked before it goes to the Trash (`ExplorerMenu.trashConfirmation`).
    ///
    /// Hidden entries count, because the Trash takes them too: a folder that
    /// holds a repository is thousands of items whatever its sidebar row
    /// shows, and that is the case the number is there to warn about. The
    /// Finder's own `.DS_Store` is left out, being nobody's content. A
    /// package is one item, as the Finder shows it. The walk stops at `cap`
    /// so a huge tree costs a bounded walk; `capped` says it stopped.
    public static func itemCount(in folder: URL, cap: Int = 10_000,
                                 fileManager: FileManager = .default) -> (items: Int, capped: Bool) {
        guard let walk = fileManager.enumerator(at: folder, includingPropertiesForKeys: nil,
                                                options: [.skipsPackageDescendants]) else {
            return (0, false)
        }
        var items = 0
        for case let url as URL in walk where url.lastPathComponent != ".DS_Store" {
            if items == cap { return (cap, true) }
            items += 1
        }
        return (items, false)
    }
}
