import Foundation

/// Where a link the page asked to follow (`openFile`) goes: which file, and
/// which line of it. The Swift half of the extension's `_handleOpenFile` and
/// `_findHeadingLine` (src/MarkdownEditorProvider.ts), with `slugify` and
/// `scanHeadings` ported from shared/slug.ts and shared/headingScan.ts. The
/// port is held by mirrored cases in `LinkTargetTests`, not by a golden file
/// recorded from the TypeScript, so a change to either TypeScript function
/// is a change to make here by hand.
///
/// Three steps, each pure so a test can hand it text and a file list:
///
/// - `split` takes the fragment off. A wikilink's fragment is always a
///   heading; a Markdown link's is a line (`file.md#27`, `file.md#27-30`)
///   when it is all digits, and a heading otherwise.
/// - `resolve` is `NoteLinkResolver`, the resolver the folder index uses, so
///   a link the Backlinks tab resolved opens the file it named.
/// - `headingLine` finds the heading a fragment names, by its anchor slug or
///   by its text in any case, the two spellings the extension accepts.
public enum LinkTarget {
    public struct Split: Equatable, Sendable {
        public init(path: String, heading: String? = nil, line: Int? = nil) {
            self.path = path
            self.heading = heading
            self.line = line
        }

        /// The path or wikilink name, fragment removed.
        public var path: String
        /// A heading to land on, still as written (percent-encoded or not).
        public var heading: String?
        /// A 1-based document line to land on.
        public var line: Int?
    }

    public static func split(_ raw: String, wiki: Bool) -> Split {
        guard let hash = raw.firstIndex(of: "#") else { return Split(path: raw) }
        let path = String(raw[..<hash])
        let fragment = String(raw[raw.index(after: hash)...])
        if !wiki, let line = lineNumber(fragment) {
            return Split(path: path, line: line)
        }
        return Split(path: path, heading: fragment.isEmpty ? nil : fragment)
    }

    /// `^(\d+)(-\d+)?$`: the first number of a line fragment.
    static func lineNumber(_ fragment: String) -> Int? {
        let parts = fragment.split(separator: "-", omittingEmptySubsequences: false)
        guard (1...2).contains(parts.count),
              parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy { $0.isASCII && $0.isNumber } }) else { return nil }
        return Int(parts[0])
    }

    /// The absolute file `split.path` names from the document at `doc`,
    /// against `files` (absolute paths under `root`), or nil.
    ///
    /// A Markdown link the list cannot answer is tried once more as a plain
    /// path from the document's folder, decoded, against `exists`: a window
    /// with no folder walks only its own note's directory, and `../other.md`
    /// is outside that walk but is still a file the link names.
    public static func resolve(_ path: String, wiki: Bool, from doc: String,
                               root: String, files: [String],
                               exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> String? {
        let resolver = NoteLinkResolver(root: root, files: files.contains(doc) ? files : files + [doc])
        if wiki { return resolver.resolveWiki(path, from: doc) }
        if let found = resolver.resolveLink(path, from: doc) { return found }
        guard !path.isEmpty else { return nil }
        let decoded = path.removingPercentEncoding ?? path
        let base = decoded.hasPrefix("/") ? root : NoteLinkResolver.dirname(doc)
        let candidate = URL(fileURLWithPath: base).appendingPathComponent(decoded).standardizedFileURL.path
        return exists(candidate) ? candidate : nil
    }

    /// The 1-based line of the heading `fragment` names in `text`, or nil.
    /// Matched as the extension matches it: the fragment decoded, then
    /// compared lower-cased and slugged against each heading's anchor slug,
    /// collision suffixes included.
    public static func headingLine(in text: String, fragment: String) -> Int? {
        let decoded = fragment.removingPercentEncoding ?? fragment
        let wanted: Set<String> = [decoded.lowercased(), slugify(decoded)]
        var counts: [String: Int] = [:]
        for heading in scanHeadings(text) {
            let base = slugify(rendered(heading.text))
            if base.isEmpty { continue }
            let n = counts[base, default: 0]
            counts[base] = n + 1
            if wanted.contains(n == 0 ? base : "\(base)-\(n)") { return heading.line }
        }
        return nil
    }

    /// `shared/slug.ts` `slugify`: lower-cased, everything but letters,
    /// digits, `_`, `-` and space dropped, each space a hyphen.
    public static func slugify(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in text.lowercased().unicodeScalars {
            switch scalar.properties.generalCategory {
            case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
                 .decimalNumber, .letterNumber, .otherNumber:
                out.append(scalar)
            default:
                if scalar == " " { out.append("-") } else if scalar == "_" || scalar == "-" { out.append(scalar) }
            }
        }
        return String(out)
    }

    /// The constructs whose source differs from their rendering, reduced so
    /// a raw heading slugs the way the page slugs the rendered one: links and
    /// images keep their text, code loses its backticks.
    static func rendered(_ raw: String) -> String {
        var s = raw
        for (pattern, template) in [(#"!\[([^\]]*)\]\([^)]*\)"#, "$1"),
                                    (#"\[([^\]]*)\]\([^)]*\)"#, "$1"),
                                    (#"`([^`]*)`"#, "$1")] {
            let re = try! NSRegularExpression(pattern: pattern)
            s = re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: template)
        }
        return s
    }

    struct Heading: Equatable {
        var text: String
        var line: Int
    }

    /// `shared/headingScan.ts` `scanHeadings`: ATX and setext headings with
    /// their 1-based lines, skipping a leading frontmatter block and fenced
    /// code.
    static func scanHeadings(_ text: String) -> [Heading] {
        let lines = text.components(separatedBy: "\n").map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
        let n = lines.count
        var out: [Heading] = []
        var i = 0
        func matches(_ s: String, _ pattern: String) -> NSTextCheckingResult? {
            let re = try! NSRegularExpression(pattern: pattern)
            return re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s))
        }
        func group(_ m: NSTextCheckingResult, _ k: Int, in s: String) -> String? {
            Range(m.range(at: k), in: s).map { String(s[$0]) }
        }
        let yaml = #"^(---|\.\.\.)[ \t]*$"#
        let toml = #"^\+\+\+[ \t]*$"#
        if n > 0 {
            let closer = matches(lines[0], #"^---[ \t]*$"#) != nil ? yaml
                : matches(lines[0], toml) != nil ? toml : nil
            if let closer {
                var j = 1
                while j < n, matches(lines[j], closer) == nil { j += 1 }
                if j < n { i = j + 1 }
            }
        }
        let fence = #"^(`{3,}|~{3,})"#
        while i < n {
            let line = lines[i]
            let trimmedStart = String(line.drop { $0 == " " || $0 == "\t" })
            if let open = matches(trimmedStart, fence), let run = group(open, 1, in: trimmedStart) {
                i += 1
                while i < n {
                    let t = String(lines[i].drop { $0 == " " || $0 == "\t" })
                    if let close = matches(t, fence), let c = group(close, 1, in: t),
                       c.first == run.first, c.count >= run.count { break }
                    i += 1
                }
                i += 1
                continue
            }
            if let atx = matches(line, #"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$"#) {
                var content = group(atx, 2, in: line) ?? ""
                if let closer = matches(content, #"[ \t]+#+[ \t]*$"#), let r = Range(closer.range, in: content) {
                    content.removeSubrange(r)
                }
                out.append(Heading(text: content.trimmingCharacters(in: .whitespaces), line: i + 1))
                i += 1
                continue
            }
            if !line.trimmingCharacters(in: .whitespaces).isEmpty, !line.hasPrefix("    "), i + 1 < n,
               matches(lines[i + 1], #"^ {0,3}(=+|-+)[ \t]*$"#) != nil {
                out.append(Heading(text: line.trimmingCharacters(in: .whitespaces), line: i + 1))
                i += 2
                continue
            }
            i += 1
        }
        return out
    }
}

/// Where a link lands, against a folder walked from disk: the file list
/// `LinkTarget.resolve` needs, kept briefly so the link popup, which asks
/// where a link goes on every hover, does not walk the folder each time.
///
/// An open never trusts a kept list's miss: a file made since the walk is a
/// file the link names, so a miss walks again before saying it names nothing.
/// A kept list's hit can be stale only by a file moved in that window, and
/// then the open lands on the path the link names, which is what it says.
///
/// Not thread-safe; its owner calls it from one serial queue.
public final class LinkLocator: @unchecked Sendable {
    public struct Located: Equatable, Sendable {
        /// Absolute path of the file the link names.
        public var path: String
        /// The 1-based line a fragment asked for, when it named one.
        public var line: Int?
    }

    private let maxAge: TimeInterval
    private let now: () -> Date
    private let walk: (URL, Bool) -> [String]
    private var kept: (root: String, deep: Bool, at: Date, files: [String])?

    /// How many times the folder has been walked; what a test reads to see
    /// a hover answered from the kept list.
    public private(set) var walks = 0

    public init(maxAge: TimeInterval = 5, now: @escaping () -> Date = Date.init,
                walk: @escaping (URL, Bool) -> [String] = LinkLocator.walkFolder) {
        self.maxAge = maxAge
        self.now = now
        self.walk = walk
    }

    /// The files under `root`, absolute. `deep` is a window's folder,
    /// walked as `FileIndex` walks it; otherwise only `root`'s own entries,
    /// because a window on a loose file roots its links at that file's
    /// folder, which can be the home folder, and the cap bounds what a walk
    /// keeps but not what it visits.
    public static func walkFolder(_ root: URL, deep: Bool) -> [String] {
        if deep {
            return FileIndex.build(root: root, cap: FolderIndex.fileCap, accepts: { _ in true }).paths
                .map { root.path + "/" + $0 }
        }
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: root, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles])) ?? []
        return entries.filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }
            .map { root.path + "/" + $0.lastPathComponent }
    }

    /// The files a link can name under `root`, from the kept list when it is
    /// fresh: what link completion offers, so a burst of keystrokes shares
    /// one walk with each other and with the popup's lookups.
    public func candidates(under root: URL, deep: Bool) -> [String] {
        files(under: root, deep: deep, fresh: false)
    }

    private func files(under root: URL, deep: Bool, fresh: Bool) -> [String] {
        let key = root.path
        if !fresh, let kept, kept.root == key, kept.deep == deep,
           now().timeIntervalSince(kept.at) < maxAge { return kept.files }
        walks += 1
        let files = walk(root, deep)
        kept = (key, deep, now(), files)
        return files
    }

    /// The file `raw` (an `openFile` path, fragment included) names from the
    /// note at `doc`, under `root`, walked whole when `deep` and listed one
    /// level otherwise (`walkFolder`). `forOpen` is the click's ask: it
    /// retries a miss against a fresh walk, and reads the target for a
    /// heading's line.
    public func locate(_ raw: String, wiki: Bool, from doc: String, root: URL, deep: Bool = true,
                       forOpen: Bool, read: (String) -> String? = { try? String(contentsOfFile: $0, encoding: .utf8) }) -> Located? {
        let split = LinkTarget.split(raw, wiki: wiki)
        guard !split.path.isEmpty else { return nil }
        var found = LinkTarget.resolve(split.path, wiki: wiki, from: doc, root: root.path,
                                       files: files(under: root, deep: deep, fresh: false))
        if found == nil, forOpen {
            found = LinkTarget.resolve(split.path, wiki: wiki, from: doc, root: root.path,
                                       files: files(under: root, deep: deep, fresh: true))
        }
        guard let found else { return nil }
        var line = split.line
        if forOpen, line == nil, let heading = split.heading, FolderIndex.isNotePath(found), let text = read(found) {
            line = LinkTarget.headingLine(in: text, fragment: heading)
        }
        return Located(path: found, line: line)
    }

    /// What the link popup shows for a located file: root-relative when it
    /// is under the root, absolute otherwise, as the extension answers.
    public static func display(_ path: String, root: URL) -> String {
        FolderIndex.relative(path, to: root.path) ?? path
    }
}
