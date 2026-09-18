import Foundation

/// The themes the VS Code family has installed, as a list to pick from,
/// with no window.
///
/// One row per theme an extension contributes (`ThemeStore.themesInExtensions`),
/// named by its label, with the extension it comes from and the kind its
/// manifest declares. A row whose theme the store already holds is shown
/// and cannot be picked: adding it again would only rewrite the same file
/// under the same id, and a list that let it be ticked would count it in
/// the Add button's number for nothing.
///
/// A picker rather than an import of the lot, because a Mac with VS Code on
/// it has every stock theme and every theme any extension ever brought, and
/// a library of forty is a library nobody chose.
public struct InstalledThemesPick: Equatable, Sendable {
    public struct Row: Equatable, Sendable, Identifiable {
        public var id: String { source.url.path }
        public let source: ThemeSource
        public let name: String
        /// The extension the theme comes from, by its folder's name, and
        /// the kind, as one line under the name.
        public let detail: String
        /// The manifest's base kind, or nil when it declares none: the file
        /// itself decides then, and it is not read until the theme is added.
        public let kind: VSCodeTheme.Kind?
        public let alreadyAdded: Bool
    }

    public private(set) var rows: [Row]
    public private(set) var picked: Set<String> = []

    /// `held` is what the store lists now, by id.
    public init(sources: [ThemeSource], held: [String]) {
        let ids = Set(held)
        rows = sources.map { source in
            let name = source.label ?? source.url.deletingPathExtension().lastPathComponent
            let kind = VSCodeTheme.Kind(uiTheme: source.uiTheme)
            let extensionName = Self.extensionName(of: source.url)
            let kindWord = kind.map { $0 == .dark ? "Dark" : "Light" }
            return Row(source: source, name: name,
                       detail: [extensionName, kindWord].compactMap { $0 }.joined(separator: ", "),
                       kind: kind,
                       alreadyAdded: ids.contains(ThemeStore.slug(name)))
        }
    }

    /// The extension folder a theme file sits in: the child of an
    /// `extensions` folder on its path, or nil for a file somewhere else.
    static func extensionName(of url: URL) -> String? {
        let parts = url.pathComponents
        guard let index = parts.lastIndex(of: "extensions"), index + 1 < parts.count - 1 else { return nil }
        return parts[index + 1]
    }

    public func isPicked(_ row: Row) -> Bool { picked.contains(row.id) }

    /// Tick or untick a row; a row already held cannot be ticked.
    public mutating func toggle(_ row: Row) {
        guard !row.alreadyAdded else { return }
        if picked.contains(row.id) { picked.remove(row.id) } else { picked.insert(row.id) }
    }

    /// The sources to add, in the list's order.
    public var chosen: [ThemeSource] {
        rows.filter { picked.contains($0.id) }.map(\.source)
    }

    /// What the Add button says: how many, or nothing to add.
    public var addTitle: String {
        picked.isEmpty ? "Add" : "Add \(picked.count)"
    }
}
