import Foundation

/// The folder edge index (MAR-467) for a directory window's root: which notes
/// under it name which, as the page's `folderIndex` message carries it
/// (shared/folderIndex.ts). What the Backlinks tab reads.
///
/// The same index the extension's producer builds (`src/folderIndex.ts`),
/// made the same way: walk the root, read each note once (`NoteLinks`), and
/// resolve every reference against the walk's own file list
/// (`NoteLinkResolver`), so a note whose links resolve in VS Code resolves
/// here. Four rules carry over unchanged, and each is a promise the page's
/// views rely on:
///
/// - the walk stops at `cap` notes and says so in `truncated`, so an absent
///   backlink can read as "not reached" rather than "not linked";
/// - an edge is kept only between notes: a reference that resolves to a file
///   which is not a note (an image, a PDF) is dropped, not drawn dangling;
/// - an unresolved reference is kept with `to` nil, because a broken
///   cross-link is not a malformed one;
/// - every path is root-relative and POSIX, like the explorer's.
///
/// The walk is `FileIndex`'s: hidden entries and everything under them are
/// skipped, and package contents are not entered. That is the one place the
/// two producers see different trees, since VS Code's search walks dotted
/// folders its `files.exclude` does not name.
///
/// Built off the main thread and swapped in, like `FileIndex`, by a
/// `FolderIndexer` per root, which the app's `WindowSet` asks again when that
/// root's `DirectoryWatcher` reports a change.
public struct FolderIndex: Equatable, Sendable {
    public struct Node: Equatable, Sendable {
        public var path: String
        public var name: String
        public var type: String?
        public var tags: [String]
        public var status: String?
        public var trust: String?
        public var staleAfter: String?
    }

    public struct Edge: Equatable, Sendable {
        public var from: String
        public var to: String?
        public var target: String
        public var kind: NoteLinks.Kind
        public var text: String
        public var line: Int
    }

    public let rootName: String
    public let nodes: [Node]
    public let edges: [Edge]
    public let truncated: Bool

    /// How many notes one walk reads before it stops and says it stopped:
    /// the extension's `FOLDER_INDEX_CAP`, so the two hosts cut a large
    /// folder at the same size.
    public static let cap = 2000
    /// How many files of any kind the walk keeps to resolve against, the Go
    /// to File index's cap.
    public static let fileCap = 20_000

    /// Is this a file the index reads as a note? Every spelling the editor opens.
    public static func isNotePath(_ path: String) -> Bool {
        let ext = NoteLinkResolver.extname(NoteLinkResolver.basename(path)).lowercased()
        return DocumentTypes.opened.contains { ".\($0)" == ext }
    }

    /// `abs` relative to `root`, or nil when it is not under it (`underRoot`).
    static func relative(_ abs: String, to root: String) -> String? {
        guard abs.hasPrefix(root + "/") else { return nil }
        let rel = String(abs.dropFirst(root.count + 1))
        return rel.isEmpty || rel.hasPrefix("..") ? nil : rel
    }

    /// Resolutions already made, by kind, naming directory and target. Valid
    /// for as long as the file list they were made against: a resolution
    /// depends on which files exist and on nothing a note's text can change.
    public typealias ResolutionMemo = [String: String?]

    /// The index of `root` from what a walk found: `notes` are the note files
    /// it read (absolute), `readings` what each said (absent for one that
    /// could not be read), `files` every file a reference may resolve to.
    ///
    /// Pure, so a test hands it a tree it made up; the walk and the reads are
    /// `FolderIndexer`'s. `memo` carries resolutions between two assemblies
    /// over the same file list, and the caller empties it when the list moves.
    public static func assemble(root: String, notes: [String], readings: [String: NoteLinks.Reading],
                                files: [String], truncated: Bool, memo: inout ResolutionMemo) -> FolderIndex {
        let sorted = notes.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
        // Every note the walk read exists, whatever the file list reached.
        var allFiles = files
        let fileSet = Set(files)
        allFiles.append(contentsOf: sorted.filter { !fileSet.contains($0) })
        // Built on the first miss only: an assembly whose every resolution is
        // memoized never pays for the resolver's per-file keys.
        var resolver: NoteLinkResolver?
        let nodePaths = Set(sorted.compactMap { relative($0, to: root) })

        // A wikilink resolves by name against the whole folder, so the same
        // name from the same directory lands on the same note every time:
        // memoized per naming directory rather than resolved once per link.
        func resolve(_ doc: String, _ target: String, wiki: Bool) -> String? {
            let key = "\(wiki ? "w" : "l")\u{0}\(NoteLinkResolver.dirname(doc))\u{0}\(target)"
            if let known = memo[key] { return known }
            if resolver == nil { resolver = NoteLinkResolver(root: root, files: allFiles) }
            let found = wiki ? resolver!.resolveWiki(target, from: doc) : resolver!.resolveLink(target, from: doc)
            memo[key] = .some(found)
            return found
        }

        var nodes: [Node] = []
        var edges: [Edge] = []
        for note in sorted {
            guard let rel = relative(note, to: root) else { continue }
            let reading = readings[note]
            let base = NoteLinkResolver.basename(note)
            let ext = NoteLinkResolver.extname(base)
            let stem = JSText.string(Array(base.utf16.dropLast(ext.utf16.count)))
            let meta = reading?.meta
            nodes.append(Node(path: rel, name: meta?.title ?? stem, type: meta?.type, tags: meta?.tags ?? [],
                              status: meta?.status, trust: meta?.trust, staleAfter: meta?.staleAfter))
            for link in reading?.links ?? [] where !link.path.isEmpty {
                let abs = resolve(note, link.path, wiki: link.kind == .wiki)
                let inRoot = abs.flatMap { relative($0, to: root) }
                // A reference to a file that is not a note is not a relation
                // between notes: left out, not drawn as a dangling note.
                if let abs, inRoot != nil, !isNotePath(abs) { continue }
                edges.append(Edge(from: rel, to: inRoot.flatMap { nodePaths.contains($0) ? $0 : nil },
                                  target: link.path, kind: link.kind, text: link.text, line: link.line))
            }
        }
        return FolderIndex(rootName: NoteLinkResolver.basename(root), nodes: nodes, edges: edges, truncated: truncated)
    }

    /// `assemble` with nothing carried over.
    public static func assemble(root: String, notes: [String], readings: [String: NoteLinks.Reading],
                                files: [String], truncated: Bool) -> FolderIndex {
        var memo = ResolutionMemo()
        return assemble(root: root, notes: notes, readings: readings, files: files, truncated: truncated, memo: &memo)
    }

    /// `file` as the index names it, or nil when the index holds no such note.
    public func path(of file: URL, root: URL) -> String? {
        guard let rel = DirectoryListing.relativePath(of: file, in: root) else { return nil }
        return nodes.contains { $0.path == rel } ? rel : nil
    }

    /// The wire form, `FolderIndex` in shared/folderIndex.ts.
    public var jsonObject: [String: Any] {
        func orNull(_ s: String?) -> Any { s ?? NSNull() }
        return [
            "rootName": rootName,
            "truncated": truncated,
            "nodes": nodes.map { n -> [String: Any] in
                ["path": n.path, "name": n.name, "type": orNull(n.type), "tags": n.tags,
                 "status": orNull(n.status), "trust": orNull(n.trust), "staleAfter": orNull(n.staleAfter)]
            },
            "edges": edges.map { e -> [String: Any] in
                ["from": e.from, "to": orNull(e.to), "target": e.target, "kind": e.kind.rawValue,
                 "text": e.text, "line": e.line]
            },
        ]
    }
}

/// Builds one root's `FolderIndex`, again and again, reusing what did not change.
///
/// The app writes a note on every pause in the typing, and every write is a
/// change the root's watcher reports, so the index is rebuilt far more often
/// than the folder really moves. The two costs of a build go stale for
/// different reasons, as in the extension's producer: a note's READING only
/// when that file's bytes change, which the walk sees as a new modification
/// date or size; and a reference's RESOLUTION only when the file list does.
/// So a rebuild after a save walks the tree, reads the one note that changed,
/// and answers every resolution from the memo.
///
/// Not thread-safe, and `@unchecked Sendable` only so it can be handed to the
/// one serial queue its owner calls `build` from.
public final class FolderIndexer: @unchecked Sendable {
    public let root: URL
    private let cap: Int
    private let fileCap: Int
    private let read: (String) -> String?

    private struct Stamp: Equatable {
        var modified: Date?
        var size: Int?
    }

    private var readings: [String: (stamp: Stamp, reading: NoteLinks.Reading?)] = [:]
    private var lastFiles: [String]?
    private var memo = FolderIndex.ResolutionMemo()

    /// How many notes the last `build` read from disk rather than from its
    /// cache; what a test asks to see that a save re-reads one file.
    public private(set) var lastReadCount = 0

    public init(root: URL, cap: Int = FolderIndex.cap, fileCap: Int = FolderIndex.fileCap,
                read: @escaping (String) -> String? = { try? String(contentsOfFile: $0, encoding: .utf8) }) {
        self.root = root
        self.cap = cap
        self.fileCap = fileCap
        self.read = read
    }

    /// Walk the root as `FileIndex` does, read what changed, and assemble.
    /// Blocking: the caller runs it off the main thread.
    public func build(fileManager: FileManager = .default) -> FolderIndex {
        let rootPath = root.standardizedFileURL.path
        let keys: [URLResourceKey] = [.isRegularFileKey, .contentModificationDateKey, .fileSizeKey]
        var notes: [(path: String, stamp: Stamp)] = []
        var files: [String] = []
        if let walk = fileManager.enumerator(at: root, includingPropertiesForKeys: keys,
                                             options: [.skipsHiddenFiles, .skipsPackageDescendants]) {
            for case let url as URL in walk {
                guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true,
                      let rel = DirectoryListing.relativePath(of: url, in: root) else { continue }
                let abs = rootPath + "/" + rel
                if FolderIndex.isNotePath(abs) {
                    notes.append((abs, Stamp(modified: values.contentModificationDate, size: values.fileSize)))
                    // One past the cap, so a folder holding exactly the cap
                    // is not called truncated.
                    if notes.count > cap { break }
                }
                if files.count < fileCap { files.append(abs) }
            }
        }
        let truncated = notes.count > cap
        let kept = notes.sorted { $0.path.utf16.lexicographicallyPrecedes($1.path.utf16) }.prefix(cap)

        var fresh: [String: (stamp: Stamp, reading: NoteLinks.Reading?)] = [:]
        var current: [String: NoteLinks.Reading] = [:]
        lastReadCount = 0
        for note in kept {
            if let cached = readings[note.path], cached.stamp == note.stamp, cached.stamp.modified != nil {
                fresh[note.path] = cached
            } else {
                lastReadCount += 1
                fresh[note.path] = (note.stamp, read(note.path).map(NoteLinks.readNote))
            }
            if let reading = fresh[note.path]?.reading { current[note.path] = reading }
        }
        readings = fresh

        // What the resolver is built from: the file list and the notes, which
        // the list may not hold once it is past its own cap.
        let resolvable = files + kept.map(\.path)
        if resolvable != lastFiles {
            memo.removeAll()
            lastFiles = resolvable
        }
        return FolderIndex.assemble(root: rootPath, notes: kept.map(\.path), readings: current,
                                    files: files, truncated: truncated, memo: &memo)
    }
}
