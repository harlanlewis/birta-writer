import Foundation

/// What the app's palette lists and in what order, with no window (MAR-458).
///
/// The palette is one field over four kinds of thing: the commands the app's
/// menus and the page can run, the files a window can open, the windows that
/// are open, and the settings rows. Each kind is a section, and a row can hold
/// rows of its own (a menu's submenu, a Settings pane), which the palette
/// opens as a level in the way Linear's does, with Backspace on an empty field
/// going back up.
///
/// Two modes, because two chords open it: Cmd+Shift+P over everything and
/// Cmd+P over files alone, which is Go to File. The mode filters; the query
/// ranks. With no query the list is the sections in their given order, with
/// the rows picked lately at the top; with a query every row is scored by
/// `FuzzyMatch` over its title (and its detail, for a file, so a path segment
/// counts), rows in a group are reached through the group with the group's
/// title in front, and the best scores come first.
public enum PaletteMode: Equatable, Sendable {
    case all
    case files
}

public struct PaletteItem: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case command
        case file
        case window
        case setting
        /// A row that opens rows of its own.
        case group
    }

    /// Stable across builds of the list, so a pick can be remembered: a
    /// command id, a file path, a window's file path, a settings row.
    public let id: String
    public let title: String
    /// What the row says after its title: a chord for a command, a folder for
    /// a file, a pane for a setting. Nil for nothing.
    public let detail: String?
    public let section: String
    public let kind: Kind
    public let children: [PaletteItem]

    public init(id: String, title: String, detail: String? = nil, section: String, kind: Kind,
                children: [PaletteItem] = []) {
        self.id = id
        self.title = title
        self.detail = detail
        self.section = section
        self.kind = kind
        self.children = children
    }
}

/// One row as the palette draws it: the item, and which letters matched.
public struct PaletteRow: Equatable, Sendable {
    public let item: PaletteItem
    /// The title as drawn: a child carries its group's title in front.
    public let title: String
    public let matched: [Range<Int>]
    public let score: Int

    public init(item: PaletteItem, title: String, matched: [Range<Int>], score: Int) {
        self.item = item
        self.title = title
        self.matched = matched
        self.score = score
    }
}

public enum PaletteModel {
    /// How many recent picks are remembered and how much a remembered pick is
    /// worth: enough to put a row somebody keeps reaching for above the rest
    /// of its section, not enough to outrank a better match.
    public static let recentsKept = 20
    private static let recentBonus = 2

    /// The rows for `query`, best first, over `items` in `mode`.
    ///
    /// - Parameters:
    ///   - items: the sections' rows in the order the palette lists them with
    ///     nothing typed.
    ///   - recents: ids picked lately, most recent first.
    public static func rank(_ items: [PaletteItem], query: String, mode: PaletteMode,
                            recents: [String]) -> [PaletteRow] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        let eligible = items.filter { fits(mode, $0) }
        if trimmed.isEmpty {
            // Recents first, in the order they were picked; then the list as
            // given. Groups stay closed with nothing typed.
            let byId = Dictionary(eligible.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            let picked = recents.compactMap { byId[$0] }.filter { $0.kind != .group }
            let pickedIds = Set(picked.map(\.id))
            let rest = eligible.filter { !pickedIds.contains($0.id) }
            return (picked + rest).map { PaletteRow(item: $0, title: $0.title, matched: [], score: 0) }
        }
        // Three components, each outranking the next whatever its size: the
        // match, then whether the row was picked lately, then the order the
        // list was given in, so two equal matches keep the order their menu
        // has them in rather than falling to the alphabet. The order term
        // holds past any list this palette builds (`FileIndex` caps a folder's
        // files well under it).
        var rows: [PaletteRow] = []
        for (order, item) in flattened(eligible).enumerated() {
            guard let match = best(trimmed, for: item) else { continue }
            let boost = recents.contains(item.item.id) ? recentBonus : 0
            rows.append(PaletteRow(item: item.item, title: item.title, matched: match.ranges,
                                   score: match.score * 1_000_000 + boost * 100_000 + (orderCeiling - min(order, orderCeiling))))
        }
        return rows.sorted { $0.score > $1.score }
    }

    /// The last list position the order term can tell apart.
    private static let orderCeiling = 99_999

    /// The rows grouped by section, in the order the sections first appear.
    public static func sections(_ rows: [PaletteRow]) -> [(section: String, rows: [PaletteRow])] {
        var order: [String] = []
        var groups: [String: [PaletteRow]] = [:]
        for row in rows {
            if groups[row.item.section] == nil { order.append(row.item.section) }
            groups[row.item.section, default: []].append(row)
        }
        return order.map { ($0, groups[$0] ?? []) }
    }

    /// `recents` with `id` at the front, capped.
    public static func recording(_ id: String, into recents: [String]) -> [String] {
        Array(([id] + recents.filter { $0 != id }).prefix(recentsKept))
    }

    // MARK: pieces

    private static func fits(_ mode: PaletteMode, _ item: PaletteItem) -> Bool {
        switch mode {
        case .all: return true
        case .files: return item.kind == .file
        }
    }

    private struct Flat {
        let item: PaletteItem
        let title: String
    }

    /// Every leaf, with a child's title prefixed by its group's, so a query
    /// reaches into a submenu the way a person reads it: `Paragraph Style ›
    /// Heading 2`.
    private static func flattened(_ items: [PaletteItem], prefix: String = "") -> [Flat] {
        items.flatMap { item -> [Flat] in
            let title = prefix.isEmpty ? item.title : "\(prefix) › \(item.title)"
            guard item.kind == .group else { return [Flat(item: item, title: title)] }
            return flattened(item.children, prefix: title)
        }
    }

    /// The better of the match on the drawn title and, for a file, the match
    /// on its detail (the folder), so a typed folder name finds files in it.
    private static func best(_ query: String, for flat: Flat) -> FuzzyMatch.Match? {
        let onTitle = FuzzyMatch.match(query, in: flat.title)
        guard flat.item.kind == .file, let detail = flat.item.detail,
              let onDetail = FuzzyMatch.match(query, in: detail + "/" + flat.item.title) else { return onTitle }
        // The detail match marks letters in a string the row does not draw,
        // so it contributes a score and no ranges.
        let detailScore = FuzzyMatch.Match(score: onDetail.score - 1, ranges: onTitle?.ranges ?? [])
        guard let onTitle else { return detailScore }
        return onTitle.score >= detailScore.score ? onTitle : detailScore
    }
}
