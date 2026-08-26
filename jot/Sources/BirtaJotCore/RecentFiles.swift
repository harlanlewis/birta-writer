import Foundation

/// The files the app has been pointed at lately: what the list keeps, and how
/// a menu of it is split and labelled.
///
/// It is a memory of the window rather than a setting, in the same family as
/// `Prefs.saveAsDirectory`, which is why it has no row in Settings and why
/// Clear Menu is the only control over it.
///
/// ## Why the list is longer than the menu
///
/// Thirty entries, ten of them on the menu itself and the other twenty behind
/// More. The split is the whole reason the list is this long: ten is about as
/// many rows as anyone reads without scanning, and a menu that stops there
/// forgets a file the day after you stop using it. Behind one more gesture,
/// twenty more cost nothing to carry and are there on the week you go back for
/// one.
///
/// ## Why a row can say more than a file name
///
/// Two notes in different folders are very often called the same thing, and
/// two identical rows in a menu is a choice nobody can make. So a name that
/// appears twice in the SAME menu is drawn with its folder after it, and a name
/// that appears once is not: the folder is disambiguation rather than
/// decoration, and adding it everywhere would make every row longer to fix a
/// collision most menus do not have.
///
/// It disambiguates as far as the folder's own name and no further. Two files
/// with the same name in two folders that are also named the same still read
/// alike, and what tells them apart there is the path in the row's tooltip. The
/// alternative, walking up until the paths diverge, buys a correct row at the
/// cost of a menu whose widths jump around; the tooltip already answers it.
public enum RecentFiles {
    /// How many rows the menu itself carries.
    public static let firstPage = 10
    /// How many more sit behind More. The two together are what is stored, so
    /// the list is never longer than a menu could show.
    public static let morePage = 20
    public static let capacity = firstPage + morePage

    /// One row: the file it opens, and what it says.
    public struct Row: Equatable {
        public let url: URL
        public let title: String

        public init(url: URL, title: String) {
            self.url = url
            self.title = title
        }
    }

    /// `url` at the front of `existing`, with any earlier mention of the same
    /// file removed and the tail trimmed to `capacity`.
    ///
    /// Compared by standardized path rather than by `URL`, because the same
    /// file reached through `/tmp` and `/private/tmp`, or with a trailing
    /// slash, is one file and must not become two rows.
    public static func recording(_ url: URL, into existing: [URL]) -> [URL] {
        let target = url.standardizedFileURL
        let rest = existing.filter { $0.standardizedFileURL.path != target.path }
        return Array(([target] + rest).prefix(capacity))
    }

    /// The rows a menu draws, in order: everything still on disk, titled so no
    /// two rows in the result read the same.
    ///
    /// A missing file is dropped from the MENU and left in the stored list,
    /// which is the difference between a file that has been deleted and one
    /// that is on a volume you have not plugged in this morning. Pruning the
    /// store on every read would lose the second permanently, silently, and at
    /// the moment its owner is least able to notice.
    public static func rows(from stored: [URL],
                            exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }) -> [Row] {
        let live = stored.filter(exists).prefix(capacity)
        var counts: [String: Int] = [:]
        for url in live { counts[url.lastPathComponent, default: 0] += 1 }
        return live.map { url in
            let name = url.lastPathComponent
            guard counts[name, default: 0] > 1 else { return Row(url: url, title: name) }
            let folder = url.deletingLastPathComponent().lastPathComponent
            return Row(url: url, title: folder.isEmpty ? name : "\(name) (\(folder))")
        }
    }

    /// The rows split into the menu's own and More's. `more` is empty whenever
    /// everything fits, which is what tells a caller not to draw More at all.
    public static func pages(_ rows: [Row]) -> (first: [Row], more: [Row]) {
        (Array(rows.prefix(firstPage)), Array(rows.dropFirst(firstPage)))
    }
}
