import Foundation

/// What the path bar says about where a file is, with no window: the folders
/// from a root the reader recognises down to the file, each a place a click
/// can show in the Finder.
///
/// The Finder's own path bar is the model for the drawing, and the question
/// that matters is where the path STARTS. A full POSIX path opens on
/// `/Users/<name>/Library/Mobile Documents/...`, which is four segments nobody
/// reads and one of them a folder the Finder hides. So the path is cut at the
/// first root a person would name: iCloud Drive for anything under the iCloud
/// container, which is where the Finder starts it too; the home folder for
/// anything else under it, where the Finder would spend two segments on the
/// volume and `Users` first; and the volume otherwise.
///
/// An app's iCloud container (`iCloud~md~obsidian`) is the one folder that is
/// renamed rather than cut: the Finder shows it under the app's name and
/// hides the `Documents` folder inside it, so a note in Obsidian's vault reads
/// `iCloud Drive › Obsidian › Vault › note.md` here as it does there. The name
/// is the caller's to supply (`displayName`), because it is the file system's
/// localized name and nothing in this module can read one.
public struct PathSegment: Equatable, Sendable {
    public enum Kind: String, Sendable {
        case cloud, home, volume, folder, file
    }

    public let name: String
    /// The folder or file a click shows, absolute.
    public let path: String
    public let kind: Kind

    public init(name: String, path: String, kind: Kind) {
        self.name = name
        self.path = path
        self.kind = kind
    }

    public var jsonObject: [String: Any] {
        ["name": name, "path": path, "kind": kind.rawValue]
    }
}

/// One row of the menu the path bar's `…` opens: a folded segment, by the
/// name the bar drew and the path a pick reveals.
public struct PathBarMenuEntry: Equatable, Sendable {
    public let name: String
    public let path: String

    public init(name: String, path: String) {
        self.name = name
        self.path = path
    }
}

public enum PathBar {
    /// The `…` menu's rows, deepest first, as the title's path popup lists a
    /// path: the folder nearest the file at the top. Rows naming a path this
    /// bar did not draw are dropped, as `revealPath` drops them.
    public static func menuRows(_ entries: [PathBarMenuEntry], for file: URL, home: URL) -> [PathBarMenuEntry] {
        entries.filter { reveals($0.path, for: file, home: home) }.reversed()
    }

    /// The folder iCloud Drive keeps the reader's own files in.
    static let cloudDocs = "com~apple~CloudDocs"
    static let mobileDocuments = "Library/Mobile Documents"
    public static let cloudTitle = "iCloud Drive"

    /// The segments for `file`, root first, the file last.
    ///
    /// - Parameters:
    ///   - home: the reader's home folder.
    ///   - displayName: the file system's name for a path, which is what the
    ///     Finder draws (`FileManager.displayName(atPath:)` in the app).
    public static func segments(for file: URL, home: URL,
                                displayName: (String) -> String) -> [PathSegment] {
        let parts = components(file.standardizedFileURL.path)
        let homeParts = components(home.standardizedFileURL.path)
        guard !parts.isEmpty else { return [] }

        var out: [PathSegment] = []
        var index: Int
        let mobile = homeParts + components(mobileDocuments)
        // `>=`/`>` against the root itself, not one below it: a FOLDER can
        // be the root (the Where menu's walk starts at a note's folder, and a
        // recent row names a file's folder), and it then reads as that root
        // alone rather than falling through to the next branch's.
        if parts.starts(with: mobile), parts.count > mobile.count {
            let containerIndex = mobile.count
            let cloudPath = join(mobile + [cloudDocs])
            out.append(PathSegment(name: cloudTitle, path: cloudPath, kind: .cloud))
            if parts[containerIndex] == cloudDocs {
                index = containerIndex + 1
            } else {
                // An app's container, under the app's name, with the
                // `Documents` folder the Finder hides folded into it, the
                // path that ends AT that folder included: the container and
                // its `Documents` both display as the app's name, so leaving
                // either unfolded names the app twice.
                var containerEnd = containerIndex + 1
                if parts.count > containerEnd, parts[containerEnd] == "Documents" { containerEnd += 1 }
                let containerPath = join(Array(parts[..<containerEnd]))
                out.append(PathSegment(name: displayName(join(Array(parts[...containerIndex]))),
                                       path: containerPath, kind: .folder))
                index = containerEnd
            }
        } else if parts.starts(with: homeParts), parts.count >= homeParts.count, !homeParts.isEmpty {
            out.append(PathSegment(name: displayName(join(homeParts)), path: join(homeParts), kind: .home))
            index = homeParts.count
        } else {
            out.append(PathSegment(name: displayName("/"), path: "/", kind: .volume))
            index = 0
        }

        while index < parts.count {
            let path = join(Array(parts[...index]))
            let last = index == parts.count - 1
            // The file's own name as written, extension included: the Finder
            // shows it so and `displayName` would drop a hidden extension.
            out.append(PathSegment(name: last ? parts[index] : displayName(path), path: path,
                                   kind: last ? .file : .folder))
            index += 1
        }
        return out
    }

    /// Where `folder` is, as one line: the bar's segment names root first,
    /// between chevrons. For a row that names a file and has to
    /// say where it is beside the name (the start view's recent files), so the
    /// place reads the way the path bar under the document reads it rather
    /// than as a POSIX path through `Library/Mobile Documents`.
    public static func location(of folder: URL, home: URL,
                                displayName: (String) -> String) -> String {
        segments(for: folder, home: home, displayName: displayName)
            .map { $0.kind == .file ? displayName($0.path) : $0.name }
            .joined(separator: separator)
    }

    /// What `location` puts between two names.
    public static let separator = " \u{203A} "

    /// Whether `path` is one the bar for `file` drew, which is the only kind
    /// a page may ask to have shown: a page naming a path of its own choosing
    /// is refused rather than handed to the Finder.
    public static func reveals(_ path: String, for file: URL, home: URL) -> Bool {
        segments(for: file, home: home, displayName: { $0 }).contains { $0.path == path }
    }

    private static func components(_ path: String) -> [String] {
        path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    }

    private static func join(_ parts: [String]) -> String { "/" + parts.joined(separator: "/") }
}
