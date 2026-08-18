import Foundation

/// The folders notes have gone to lately, newest first.
///
/// The chute pipes content elsewhere without integrating with anything: the
/// destinations are folders the user already keeps, and the second note bound
/// for a folder should cost one click rather than another trip through the
/// save panel. A folder appears once however often it is used, and only the
/// most recent `limit` are kept, because a list longer than a glance is a menu
/// nobody reads.
public struct RecentDestinations: Equatable, Sendable {
    public static let limit = 5

    /// Directory paths, newest first.
    public private(set) var paths: [String]

    public init(_ paths: [String] = []) {
        self.paths = Array(paths.prefix(RecentDestinations.limit))
    }

    public var urls: [URL] { paths.map { URL(fileURLWithPath: $0, isDirectory: true) } }

    /// Record a directory as the newest destination.
    ///
    /// Comparison is by standardized path rather than by file identity: this
    /// list is a menu, and a folder that has been moved or deleted since should
    /// simply age out of it, not cost a stat call per entry every time the
    /// menu opens.
    public mutating func remember(_ directory: URL) {
        let path = directory.standardizedFileURL.path
        guard !path.isEmpty else { return }
        paths.removeAll { $0 == path }
        paths.insert(path, at: 0)
        if paths.count > RecentDestinations.limit { paths.removeLast(paths.count - RecentDestinations.limit) }
    }
}
