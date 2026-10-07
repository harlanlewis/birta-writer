import Foundation

/// What link and path completion offer, answered with no window: a port of
/// `buildLinkTargetItems` (src/utils/linkTargetSuggestions.ts), the ranking
/// in shared/linkTargetSuggest.ts, and `getPathSuggestions`
/// (src/suggestionProviders.ts), so the page's completers get the same
/// candidates from this host that they get from the extension.
///
/// The page re-ranks every reply against what the field holds by then, with
/// the TypeScript ranking, so the order here decides only which candidates
/// make the cut. Ties after length are broken by code units rather than by
/// the locale order `localeCompare` uses; the page's re-rank restores its
/// own order within what was sent. `LinkSuggestionsTests` holds the ranking
/// to answers recorded from the TypeScript over the same files; a change to
/// that TypeScript is a change to make here by hand.
public enum LinkSuggestions {
    /// One file in both of the forms a link can name it by.
    public struct Target: Equatable, Sendable {
        /// From the note's folder, `../notes/a.md`.
        public var relative: String
        /// From the window's folder, with a leading slash, `/notes/a.md`.
        public var rootRelative: String

        public init(relative: String, rootRelative: String) {
            self.relative = relative
            self.rootRelative = rootRelative
        }

        public var jsonObject: [String: Any] { ["relative": relative, "rootRelative": rootRelative] }
    }

    /// A direct child of the folder a path being typed names.
    public struct PathItem: Equatable, Sendable {
        /// What the field completes to: the typed folder part plus the name,
        /// a folder ending in `/`.
        public var path: String
        public var isDir: Bool

        public init(path: String, isDir: Bool) {
            self.path = path
            self.isDir = isDir
        }

        public var jsonObject: [String: Any] { ["path": path, "isDir": isDir] }
    }

    /// `^[a-zA-Z][a-zA-Z0-9+.-]*:`, a URL scheme.
    static func hasScheme(_ q: String) -> Bool {
        guard let first = q.unicodeScalars.first, first.isASCII, CharacterSet.letters.contains(first) else { return false }
        for scalar in q.unicodeScalars.dropFirst() {
            if scalar == ":" { return true }
            let allowed = scalar.isASCII && (CharacterSet.alphanumerics.contains(scalar) || "+.-".unicodeScalars.contains(scalar))
            if !allowed { return false }
        }
        return false
    }

    /// `isLocalPathQuery`: non-empty, and neither an anchor nor a URL.
    public static func isLocalPathQuery(_ query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return !q.isEmpty && !q.hasPrefix("#") && !hasScheme(q)
    }

    /// `path.relative(from, to)` for absolute, normalized POSIX paths.
    public static func relative(from dir: String, to path: String) -> String {
        let a = dir.split(separator: "/", omittingEmptySubsequences: true)
        let b = path.split(separator: "/", omittingEmptySubsequences: true)
        var common = 0
        while common < a.count, common < b.count, a[common] == b[common] { common += 1 }
        let up = Array(repeating: "..", count: a.count - common)
        return (up + b[common...].map(String.init)).joined(separator: "/")
    }

    /// `buildLinkTargetItems`: every file but the note itself, in both forms,
    /// skipping any outside `root`.
    public static func targets(files: [String], doc: String, root: String) -> [Target] {
        let docDir = NoteLinkResolver.dirname(doc)
        return files.compactMap { file in
            guard file != doc, let fromRoot = FolderIndex.relative(file, to: root) else { return nil }
            return Target(relative: relative(from: docDir, to: file), rootRelative: "/" + fromRoot)
        }
    }

    static func isDocument(_ path: String) -> Bool {
        let ext = NoteLinkResolver.extname(NoteLinkResolver.basename(path)).lowercased()
        return DocumentTypes.opened.contains { ".\($0)" == ext }
    }

    /// `rankLinkTargets`: substring matches in either form, in any case,
    /// minus the one the field already holds exactly; documents first, then
    /// shorter paths, then by path.
    public static func rank(_ items: [Target], query: String, limit: Int = 20) -> [Target] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        var q = trimmed
        if q.hasPrefix("./") { q.removeFirst(2) }
        q = q.lowercased()
        let rootForm = trimmed.hasPrefix("/")
        let matches = items.filter { item in
            (q.isEmpty || item.relative.lowercased().contains(q) || item.rootRelative.lowercased().contains(q))
                && (rootForm ? item.rootRelative : item.relative) != trimmed
        }
        let sorted = matches.sorted { a, b in
            let aDoc = isDocument(a.rootRelative), bDoc = isDocument(b.rootRelative)
            if aDoc != bDoc { return aDoc }
            let al = a.rootRelative.utf16.count, bl = b.rootRelative.utf16.count
            if al != bl { return al < bl }
            return a.rootRelative.utf16.lexicographicallyPrecedes(b.rootRelative.utf16)
        }
        return Array(sorted.prefix(limit))
    }

    /// What `getLinkTargetSuggestions` answers: nothing for a query that is a
    /// URL or an anchor, everything ranked for an empty one (a bare `[[`).
    public static func linkTargets(query: String, files: [String], doc: String, root: String) -> [Target] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.isEmpty || isLocalPathQuery(q) else { return [] }
        return rank(targets(files: files, doc: doc, root: root), query: query)
    }

    /// Entries a path completion never offers, as the extension skips them.
    static let ignoredEntries: Set<String> = ["node_modules", ".git", "dist", ".DS_Store", "out", ".vscode-test"]

    /// The folder a path being typed names, absolute, and the name prefix
    /// after its last `/`. `@/` is the window's folder; anything else is from
    /// the note's own folder, as the extension resolves it.
    public static func pathQuery(_ query: String, docDir: String, root: String) -> (dir: String, dirPart: String, name: String)? {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return nil }
        let dirPart: String
        let name: String
        if let slash = q.lastIndex(of: "/") {
            dirPart = String(q[...slash])
            name = String(q[q.index(after: slash)...])
        } else {
            dirPart = ""
            name = q
        }
        let base: String
        let rest: String
        if dirPart.hasPrefix("@/") {
            base = root
            rest = String(dirPart.dropFirst(2))
        } else {
            base = docDir
            rest = dirPart
        }
        let dir = URL(fileURLWithPath: base).appendingPathComponent(rest.isEmpty ? "." : rest)
            .standardizedFileURL.path
        return (dir, dirPart, name)
    }

    /// `getPathSuggestions` over a listing of the named folder: its direct
    /// children starting with the typed name in any case, folders first,
    /// at most fifteen, minus a file the field already names exactly.
    public static func pathItems(query: String, docDir: String, root: String,
                                 list: (String) -> [(name: String, isDir: Bool)]?) -> [PathItem] {
        guard let parsed = pathQuery(query, docDir: docDir, root: root),
              let entries = list(parsed.dir) else { return [] }
        let prefix = parsed.name.lowercased()
        let kept = entries.filter { entry in
            !ignoredEntries.contains(entry.name)
                && entry.name.lowercased().hasPrefix(prefix)
                && !(!entry.isDir && entry.name.lowercased() == prefix)
        }
        let sorted = kept.sorted { a, b in
            if a.isDir != b.isDir { return a.isDir }
            return a.name.localizedCompare(b.name) == .orderedAscending
        }
        return sorted.prefix(15).map {
            PathItem(path: parsed.dirPart + $0.name + ($0.isDir ? "/" : ""), isDir: $0.isDir)
        }
    }

    /// The listing `pathItems` reads: files and folders only, as the
    /// extension's `readDirectory` filter keeps them.
    public static func listFolder(_ dir: String) -> [(name: String, isDir: Bool)]? {
        let url = URL(fileURLWithPath: dir)
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: url, includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey]) else { return nil }
        return entries.compactMap { entry in
            guard let values = try? entry.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey]) else { return nil }
            if values.isDirectory == true { return (entry.lastPathComponent, true) }
            if values.isRegularFile == true { return (entry.lastPathComponent, false) }
            return nil
        }
    }
}
