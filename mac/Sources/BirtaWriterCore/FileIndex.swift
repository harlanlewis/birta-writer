import Foundation

/// The files Go to File can reach: a folder walked once, kept as root-relative
/// paths, and rebuilt when the folder changes (MAR-458).
///
/// A walk rather than a live query, because a palette answers per keystroke
/// and a keystroke cannot wait on the disk; the app builds this off the main
/// thread and swaps it in, and the root's `DirectoryWatcher` is what asks for
/// it again. Hidden entries and everything under them are skipped, as the
/// explorer skips them by default, and the walk stops at a cap so a window
/// rooted at a home directory costs a bounded amount and says it stopped.
public struct FileIndex: Equatable, Sendable {
    /// Root-relative POSIX paths, in the order the walk met them.
    public let paths: [String]
    /// Whether the walk hit the cap before it ran out of files, so the
    /// palette can say the list is partial rather than let an absence read
    /// as the file not existing.
    public let truncated: Bool

    public init(paths: [String], truncated: Bool) {
        self.paths = paths
        self.truncated = truncated
    }

    public static let empty = FileIndex(paths: [], truncated: false)

    /// Walk `root`, keeping the files `accepts` admits.
    ///
    /// - Parameter cap: how many files to keep before stopping.
    public static func build(root: URL, cap: Int = 20_000,
                             accepts: (URL) -> Bool,
                             fileManager: FileManager = .default) -> FileIndex {
        let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey]
        guard let walk = fileManager.enumerator(at: root, includingPropertiesForKeys: keys,
                                                options: [.skipsHiddenFiles, .skipsPackageDescendants]) else {
            return .empty
        }
        var paths: [String] = []
        var truncated = false
        for case let url as URL in walk {
            guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
            guard accepts(url) else { continue }
            guard let relative = DirectoryListing.relativePath(of: url, in: root) else { continue }
            if paths.count >= cap {
                truncated = true
                break
            }
            paths.append(relative)
        }
        return FileIndex(paths: paths, truncated: truncated)
    }
}
