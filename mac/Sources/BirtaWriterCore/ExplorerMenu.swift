import Foundation

/// What a row of the file explorer offers when it is right-clicked, with no
/// menu built: the rows, in order, per kind of entry.
///
/// Kept as a table so a test can read the whole vocabulary, per kind, rather
/// than sampling a built `NSMenu`; `EntryKind` is `CaseIterable` so that
/// sweep is derived from the type and a fourth kind joins it unasked. The app
/// builds the menu from this and performs the actions; nothing here touches
/// a file.
///
/// The set is the standard one for a file sidebar and no more: where the
/// file opens, where it is, and where it goes. Rename is deliberately absent,
/// because the app renames a file from its title (the popover the window's
/// name opens), and one rename with two doors is two answers about what
/// happens to a file that is open in another tab.
public enum ExplorerMenu {
    public enum EntryKind: Equatable, Sendable, CaseIterable {
        case folder
        /// A document the editor opens.
        case document
        /// A file the editor hands to its default application.
        case other
    }

    public enum Action: Equatable, Sendable {
        /// The document, as a tab beside this one.
        case openInNewTab
        /// A note made in this folder, opened as a tab.
        case newNoteInside
        case revealInFinder
        case copyPath
        case moveToTrash
    }

    /// One row; a nil action is a separator.
    public struct Item: Equatable, Sendable {
        public let title: String
        public let action: Action?

        public init(_ title: String, _ action: Action?) {
            self.title = title
            self.action = action
        }

        public static let separator = Item("", nil)
    }

    /// The rows for an entry named `name`.
    public static func items(for kind: EntryKind, name: String) -> [Item] {
        var rows: [Item] = []
        switch kind {
        case .document:
            rows.append(Item("Open in New Tab", .openInNewTab))
            rows.append(.separator)
        case .folder:
            rows.append(Item("New Note in “\(name)”", .newNoteInside))
            rows.append(.separator)
        case .other:
            break
        }
        rows.append(Item("Reveal in Finder", .revealInFinder))
        rows.append(Item("Copy Path", .copyPath))
        if kind != .folder {
            // A folder is trashed from the Finder, where what it holds is in
            // view; a sidebar row shows a name and would trash the tree under
            // it in one click.
            rows.append(.separator)
            rows.append(Item("Move to Trash", .moveToTrash))
        }
        return rows
    }
}
