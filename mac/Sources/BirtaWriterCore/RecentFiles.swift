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
        titling(Array(stored.filter(exists).prefix(capacity)))
    }

    /// The rows split into the menu's own and More's. `more` is empty whenever
    /// everything fits, which is what tells a caller not to draw More at all.
    public static func pages(_ rows: [Row]) -> (first: [Row], more: [Row]) {
        (Array(rows.prefix(firstPage)), Array(rows.dropFirst(firstPage)))
    }

    /// The whole menu, once there can be more than one window.
    ///
    /// The list is one thing and the menu is another, and the difference is
    /// what a row DOES. Every row here goes to the same place
    /// (`WindowSet.openDocument`), which already brings a file's window forward
    /// rather than opening a second one over it, so the grouping is not about
    /// wiring: it is about what the reader is choosing between. Two of these
    /// rows switch windows and the rest open files, and a flat list said
    /// neither.
    ///
    ///     Open in Other Windows
    ///       Meeting.md            ← switches to that window
    ///       Draft.md
    ///     ─────────
    ///       Notes.md              ← opens the file
    ///       …
    ///
    /// Three rules, and each is a claim about what the reader is looking at.
    ///
    /// The file THIS window is on is not offered at all, in either group. It
    /// used to be listed with a checkmark, which is what a macOS menu does for
    /// the row you are already on, and that reading does not survive several
    /// windows: the mark answered "is this the app's active file" using an
    /// app-wide setting, so with two windows open it could tick a row in the
    /// wrong window's menu. The menu is a list of places to go, and where you
    /// already are is not one of them.
    ///
    /// A file open in ANOTHER window appears once, in the group, and never
    /// again below. Listed twice it would be two rows doing the same thing,
    /// with only the group heading saying so.
    ///
    /// The group is built from the WINDOWS rather than filtered out of the
    /// recents list, and existence is not asked of it. A window is a place to
    /// go whatever has happened to its file: a note deleted underneath a window
    /// leaves that window on screen showing the missing-file card, and a group
    /// that dropped it would offer no way back to a buffer that may be the only
    /// copy of the text. It also covers the file that has not joined the
    /// recents list yet, which is every file currently open in its first
    /// window.
    public struct Menu: Equatable {
        /// Open in other windows, most recently fronted first. Empty with one
        /// window, which is what tells a caller to draw no group and no
        /// divider.
        public let elsewhere: [Row]
        /// Everything else the list remembers, in recency order.
        public let recent: [Row]

        /// Whether the menu has nothing to offer at all.
        ///
        /// What the "No Recent Files" row is for, and it is asked of BOTH
        /// groups. That row exists so an empty menu reads as an empty list
        /// rather than as rows that failed to load, and a menu already showing
        /// a group of windows is in no danger of being read that way: putting
        /// the row there as well would say there is nothing here directly
        /// underneath something.
        public var isEmpty: Bool { elsewhere.isEmpty && recent.isEmpty }

        public init(elsewhere: [Row], recent: [Row]) {
            self.elsewhere = elsewhere
            self.recent = recent
        }
    }

    /// Build that menu.
    ///
    /// - Parameters:
    ///   - stored: the remembered list, newest first.
    ///   - openElsewhere: the files open in OTHER windows, most recently
    ///     fronted first. The caller has already left this window's own file
    ///     out, because only it knows which window raised the menu.
    ///   - here: the file this window is on, or nil when it is on none.
    ///   - exists: asked of the remembered list alone; see the type's note on
    ///     why the group is not filtered.
    ///
    /// Titles are decided across BOTH groups at once, which is why this cannot
    /// be two calls to `rows`. Two notes called the same thing, one open in
    /// another window and one merely recent, are exactly the collision the
    /// folder suffix exists for, and two lists disambiguated separately would
    /// each conclude its own name was unique.
    public static func menu(stored: [URL],
                            openElsewhere: [URL],
                            here: URL?,
                            exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }) -> Menu {
        let key = { (url: URL) in url.standardizedFileURL.path }
        let mine = here.map(key)
        // Deduped on the way in: the same file cannot be open in two windows
        // (`WindowSet.openDocument` refuses it), but a caller assembling this
        // list is not the place to rely on that.
        var seen = Set<String>()
        if let mine { seen.insert(mine) }
        var group: [URL] = []
        for url in openElsewhere where seen.insert(key(url)).inserted {
            group.append(url)
        }
        let rest = stored.filter { !seen.contains(key($0)) && exists($0) }.prefix(capacity)
        let titles = titling(group + Array(rest))
        return Menu(elsewhere: Array(titles.prefix(group.count)),
                    recent: Array(titles.dropFirst(group.count)))
    }

    /// `urls` as rows, with a name that appears more than once carrying its
    /// folder. The shared half of `rows` and `menu`, so the two cannot come to
    /// disagree about when a row says more than a file name.
    private static func titling(_ urls: [URL]) -> [Row] {
        var counts: [String: Int] = [:]
        for url in urls { counts[url.lastPathComponent, default: 0] += 1 }
        return urls.map { url in
            let name = url.lastPathComponent
            guard counts[name, default: 0] > 1 else { return Row(url: url, title: name) }
            let folder = url.deletingLastPathComponent().lastPathComponent
            return Row(url: url, title: folder.isEmpty ? name : "\(name) (\(folder))")
        }
    }
}
