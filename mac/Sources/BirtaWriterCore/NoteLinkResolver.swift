import Foundation

/// Which file a note's reference means, answered over a folder's file list
/// with no disk access: a port of the smart-links chain in
/// `src/utils/linkResolver.ts` (`resolveLinkPath`, `resolveWikiTarget`), the
/// resolver a click on a link uses in the extension.
///
/// The folder index is the only caller, and it resolves against the walk's own
/// file list, as the extension's producer does (`src/folderIndex.ts` answers
/// `isFile` from its list rather than by a stat). So every answer is a path the
/// list holds, or nil.
///
/// What is ported: every form of the link path (the bytes, the percent-decoded
/// form, then both again with Notion's export ids stripped, in that order);
/// document-relative, `@/` and leading-`/` as root-relative with the ancestor
/// walk between the document and the root; the suffix inference (every
/// document spelling, plain first, then `index.md` and `_index.md`, and a
/// trailing slash preferring the index); the suffix match over the file list;
/// and wikilink names matched case-insensitively by file name, Markdown
/// preferred, shortest path then closest to the document. What is left out is
/// the non-smart branch, because this host has no `birta.smartLinks` setting
/// and the extension's default is smart, and the "document outside the
/// workspace" arms, because every document the index reads is under its root.
///
/// Paths are absolute POSIX strings. Lengths and orderings are the
/// TypeScript's (UTF-16 lengths, code-unit comparison), because the tiebreak
/// between two candidates is part of the answer.
/// `NoteLinkResolverGoldenTests` holds this to `linkResolver.ts` over the
/// cases `shared/__tests__/noteLinksGolden.test.ts` records.
public struct NoteLinkResolver {
    /// The workspace root: what a leading `/` or `@/` names.
    public let root: String
    private let files: [String]
    private let fileSet: Set<String>
    /// Each file's path lower-cased, by position in `files`.
    private let lowerPaths: [String]
    /// Positions in `files` by lower-cased base name: the only files a suffix
    /// match can land on, since a path ending in `/tail` ends in `tail`'s last
    /// segment.
    private let byLowerBase: [String: [Int]]
    /// Positions in `files` by lower-cased base name AND by lower-cased stem:
    /// the files a wikilink name can match.
    private let byLowerName: [String: [Int]]
    /// Whether each file is in the Markdown preference tier.
    private let isMarkdown: [Bool]

    /// Every per-file key the two matches compare against is computed here,
    /// once, rather than once per reference: a folder's index resolves tens
    /// of thousands of references against thousands of files, and a scan of
    /// the list per miss is what made that quadratic.
    public init(root: String, files: [String]) {
        self.root = root
        self.files = files
        self.fileSet = Set(files)
        var lowerPaths: [String] = []
        var byLowerBase: [String: [Int]] = [:]
        var byLowerName: [String: [Int]] = [:]
        var isMarkdown: [Bool] = []
        lowerPaths.reserveCapacity(files.count)
        isMarkdown.reserveCapacity(files.count)
        for (i, file) in files.enumerated() {
            lowerPaths.append(file.lowercased())
            let base = Self.basename(file).lowercased()
            let ext = Self.extname(base)
            let stem = JSText.string(Array(base.utf16.dropLast(ext.utf16.count)))
            byLowerBase[base, default: []].append(i)
            byLowerName[base, default: []].append(i)
            if stem != base { byLowerName[stem, default: []].append(i) }
            isMarkdown.append(Self.markdownSuffixes.contains(ext))
        }
        self.lowerPaths = lowerPaths
        self.byLowerBase = byLowerBase
        self.byLowerName = byLowerName
        self.isMarkdown = isMarkdown
    }

    /// Every spelling of a document the editor opens, plain first.
    private static let inferredSuffixes = DocumentTypes.opened.map { ".\($0)" }
    /// The Markdown preference tier.
    private static let markdownSuffixes = DocumentTypes.plainMarkdown.map { ".\($0)" }

    // MARK: path arithmetic, as Node's `path.posix` does it

    /// `path.normalize` for an absolute path: `.` and `..` resolved, runs of
    /// `/` collapsed, a trailing slash kept.
    static func normalize(_ p: String) -> String {
        var out: [Substring] = []
        for seg in p.split(separator: "/", omittingEmptySubsequences: true) {
            if seg == "." { continue }
            if seg == ".." {
                if !out.isEmpty { out.removeLast() }
                continue
            }
            out.append(seg)
        }
        let joined = "/" + out.joined(separator: "/")
        return p.hasSuffix("/") && joined != "/" ? joined + "/" : joined
    }

    /// `path.join(a, b)` with an absolute `a`.
    static func join(_ a: String, _ b: String) -> String {
        normalize(b.isEmpty ? a : a + "/" + b)
    }

    /// `path.resolve(dir, p)`: absolute, normalized, no trailing slash.
    static func resolve(_ dir: String, _ p: String) -> String {
        var n = normalize(p.hasPrefix("/") ? p : dir + "/" + p)
        if n.count > 1, n.hasSuffix("/") { n.removeLast() }
        return n
    }

    static func dirname(_ p: String) -> String {
        guard let slash = p.lastIndex(of: "/") else { return "." }
        return slash == p.startIndex ? "/" : String(p[..<slash])
    }

    static func basename(_ p: String) -> String {
        guard let slash = p.lastIndex(of: "/") else { return p }
        return String(p[p.index(after: slash)...])
    }

    /// `path.extname` for a base name: from its last dot, unless that dot
    /// opens the name (`.bashrc` has none) or the name is `..`.
    static func extname(_ base: String) -> String {
        guard let dot = base.lastIndex(of: "."), dot != base.startIndex, base != ".." else { return "" }
        return String(base[dot...])
    }

    /// Code-unit order, which is what JavaScript's `<` compares.
    private static func utf16Less(_ a: String, _ b: String) -> Bool {
        a.utf16.lexicographicallyPrecedes(b.utf16)
    }

    private static func ancestors(of dir: String, upTo root: String) -> [String] {
        var out: [String] = []
        var cur = dir
        while true {
            out.append(cur)
            if cur == root { break }
            let parent = dirname(cur)
            if parent == cur { break }
            cur = parent
        }
        return out
    }

    private static func withSuffixes(_ base: String, trailingSlash: Bool) -> [String] {
        if trailingSlash { return [join(base, "index.md"), join(base, "_index.md"), base] }
        return [base] + inferredSuffixes.map { base + $0 } + [join(base, "index.md"), join(base, "_index.md")]
    }

    private static func commonDirPrefixLength(_ a: String, _ b: String) -> Int {
        let asegs = a.split(separator: "/", omittingEmptySubsequences: false)
        let bsegs = b.split(separator: "/", omittingEmptySubsequences: false)
        var i = 0
        while i < asegs.count, i < bsegs.count, asegs[i] == bsegs[i] { i += 1 }
        return i
    }

    /// Shortest path, then closest to the document, then code-unit order.
    private static func pickBest(_ matches: [String], doc: String) -> String? {
        matches.min { a, b in
            if a.utf16.count != b.utf16.count { return a.utf16.count < b.utf16.count }
            let ca = commonDirPrefixLength(a, doc)
            let cb = commonDirPrefixLength(b, doc)
            if ca != cb { return ca > cb }
            return utf16Less(a, b)
        }
    }

    // MARK: Notion export ids (shared/notionIds.ts)

    /// ` <32 lowercase hex>` before an optional extension, at the end of a segment.
    static func stripNotionId(fromSegment seg: String) -> String? {
        let u = Array(seg.utf16)
        // `(\.\w+)?$`: the id ends the segment, or a dot and a run of word
        // characters to the end follow it. At most one of the two can hold,
        // since the first needs a space where the second needs a word run.
        func isWord(_ x: UInt16) -> Bool { JSText.isAsciiLetter(x) || JSText.isAsciiDigit(x) || x == 0x5F }
        func isHex(_ x: UInt16) -> Bool { JSText.isAsciiDigit(x) || (x >= 0x61 && x <= 0x66) }
        func idEnding(at end: Int) -> Int? {
            let start = end - 33
            guard start >= 0, u[start] == 0x20 else { return nil }
            return u[(start + 1)..<end].allSatisfy(isHex) ? start : nil
        }
        var candidates: [(idStart: Int, ext: ArraySlice<UInt16>)] = []
        if let s = idEnding(at: u.count) { candidates.append((s, [])) }
        var k = u.count
        while k > 0, isWord(u[k - 1]) { k -= 1 }
        // `\w` has no dot, so only a dot directly before the trailing word
        // run can open the extension.
        if k < u.count, k > 0, u[k - 1] == 0x2E, let s = idEnding(at: k - 1) {
            candidates.append((s, u[(k - 1)...]))
        }
        guard let best = candidates.first, best.idStart > 0 else { return nil }
        return JSText.string(u[0..<best.idStart]) + JSText.string(best.ext)
    }

    static func stripNotionIds(_ linkPath: String) -> String? {
        var found = false
        let cleaned = linkPath.split(separator: "/", omittingEmptySubsequences: false).map { seg -> String in
            guard let s = stripNotionId(fromSegment: String(seg)) else { return String(seg) }
            found = true
            return s
        }
        return found ? cleaned.joined(separator: "/") : nil
    }

    // MARK: resolution

    /// `lower` ends with `/` + `tail`, compared in code units as `endsWith` does.
    private static func endsWithSegment(_ lower: String, _ tail: String) -> Bool {
        let l = Array(lower.utf16)
        let t = Array(tail.utf16)
        guard l.count > t.count, l[l.count - t.count - 1] == 0x2F else { return false }
        return l[(l.count - t.count)...].elementsEqual(t)
    }

    private func viaIndex(_ linkPath: String, doc: String) -> String? {
        var segs = linkPath.split(separator: "/", omittingEmptySubsequences: false).filter { $0 != "" && $0 != "." }
        while segs.first == ".." { segs.removeFirst() }
        let tail = segs.joined(separator: "/").lowercased()
        guard !tail.isEmpty else { return nil }
        let variants = [tail] + Self.inferredSuffixes.map { tail + $0 } + [tail + "/index.md", tail + "/_index.md"]
        // A file path is absolute and a variant never is, so equality cannot
        // hold and the suffix is the whole test.
        var matches: [Int] = []
        for variant in variants {
            for i in byLowerBase[Self.basename(variant)] ?? [] where Self.endsWithSegment(lowerPaths[i], variant) {
                matches.append(i)
            }
        }
        return Self.pickBest(Set(matches).map { files[$0] }, doc: doc)
    }

    /// `resolveLinkPath` in smart mode: a Markdown link's path portion.
    public func resolveLink(_ linkPath: String, from doc: String) -> String? {
        let docDir = Self.dirname(doc)
        let literal = [linkPath, linkPath.removingPercentEncoding ?? linkPath]
        var forms: [String] = []
        for form in literal + literal.compactMap(Self.stripNotionIds) where !forms.contains(form) {
            forms.append(form)
        }
        var bases: [String] = []
        for raw in forms {
            let trailing = raw.utf16.count > 1 && raw.hasSuffix("/")
            let p = trailing ? String(raw.dropLast()) : raw
            if p.hasPrefix("@/") {
                bases += Self.withSuffixes(Self.join(root, String(p.dropFirst(2))), trailingSlash: trailing)
            } else if p.hasPrefix("/") {
                let docInRoot = docDir == root || docDir.hasPrefix(root + "/")
                let dirs = docInRoot ? [root] + Self.ancestors(of: docDir, upTo: root) : [root]
                var seen = Set<String>()
                for dir in dirs {
                    let base = Self.join(dir, p)
                    guard seen.insert(base).inserted else { continue }
                    bases += Self.withSuffixes(base, trailingSlash: trailing)
                }
            } else {
                bases += Self.withSuffixes(Self.resolve(docDir, p), trailingSlash: trailing)
            }
        }
        if let hit = bases.first(where: fileSet.contains) { return hit }
        for raw in forms {
            if let hit = viaIndex(raw, doc: doc) { return hit }
        }
        return nil
    }

    /// `resolveWikiTarget`: a wikilink's target, heading already split off.
    public func resolveWiki(_ target: String, from doc: String) -> String? {
        let trimmed = JSText.string(JSText.trim(JSText.units(target)))
        guard !trimmed.isEmpty else { return nil }
        if trimmed.contains("/") { return resolveLink(trimmed, from: doc) }
        var names = [trimmed]
        if let stripped = Self.stripNotionIds(trimmed) { names.append(stripped) }
        for name in names {
            let pool = byLowerName[name.lowercased()] ?? []
            let markdown = pool.filter { isMarkdown[$0] }.map { files[$0] }
            let other = pool.filter { !isMarkdown[$0] }.map { files[$0] }
            if let best = Self.pickBest(markdown.isEmpty ? other : markdown, doc: doc) { return best }
        }
        return nil
    }
}
