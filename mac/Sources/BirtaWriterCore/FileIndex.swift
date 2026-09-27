import Foundation

/// The files Go to File can reach: a folder walked once, kept as root-relative
/// paths, and rebuilt when the folder changes (MAR-458).
///
/// A walk rather than a live query, because a palette answers per keystroke
/// and a keystroke cannot wait on the disk; the app builds this off the main
/// thread and swaps it in, and the root's `DirectoryWatcher` is what asks for
/// it again. Hidden entries and everything under them are skipped, as the
/// explorer skips them by default, and a folder past the cap keeps the first
/// `cap` files BY PATH, never the first the walk happened to meet: the
/// enumeration order is not stable between launches, and a cut taken in it
/// would let a file Go to File can reach today be gone tomorrow (the folder
/// index's cut had the same shape, MAR-492). The walk still visits the whole
/// folder either way; what the cap bounds is the list, which is what the
/// palette holds and scores per keystroke.
public struct FileIndex: Equatable, Sendable {
    /// Root-relative POSIX paths, sorted by UTF-16 code unit.
    public let paths: [String]
    /// Whether the folder held more files than the cap, so the palette can
    /// say the list is partial rather than let an absence read as the file
    /// not existing.
    public let truncated: Bool

    public init(paths: [String], truncated: Bool) {
        self.paths = paths
        self.truncated = truncated
    }

    public static let empty = FileIndex(paths: [], truncated: false)

    private static let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey]

    /// The walk the product runs. A parameter of `build` rather than a call
    /// inside it because `FileManager.enumerator` cannot be overridden, and
    /// the order it visits in is the one thing a test has to be able to set.
    public static func walk(_ root: URL, fileManager: FileManager = .default) -> FileManager.DirectoryEnumerator? {
        fileManager.enumerator(at: root, includingPropertiesForKeys: keys,
                               options: [.skipsHiddenFiles, .skipsPackageDescendants])
    }

    /// Walk `root`, keeping the files `accepts` admits.
    ///
    /// - Parameter cap: how many files to keep, the first that many by path.
    public static func build(root: URL, cap: Int = 20_000,
                             accepts: (URL) -> Bool,
                             walk: FileManager.DirectoryEnumerator? = nil) -> FileIndex {
        guard let walk = walk ?? Self.walk(root) else { return .empty }
        var kept = SmallestByPath<Void>(cap: cap)
        for case let url as URL in walk {
            guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
            guard accepts(url) else { continue }
            guard let relative = DirectoryListing.relativePath(of: url, in: root) else { continue }
            kept.offer(relative, ())
        }
        let (paths, truncated) = kept.finish()
        return FileIndex(paths: paths.map(\.path), truncated: truncated)
    }
}
