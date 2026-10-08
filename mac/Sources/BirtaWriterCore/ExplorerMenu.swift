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
/// entry opens, where it is, and where it goes. Rename is deliberately absent,
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
        /// The folder as a window of its own, rooted there: the Finder's
        /// Open in New Window. A tab is what a document opens as; a folder
        /// has no page to show in one, so the window is its whole answer.
        case openInNewWindow
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
            rows.append(Item("Open in New Window", .openInNewWindow))
            rows.append(.separator)
        case .other:
            break
        }
        rows.append(Item("Reveal in Finder", .revealInFinder))
        rows.append(Item("Copy Path", .copyPath))
        // A folder too. A sidebar row shows only a name, so what a folder's
        // row would take with it is not in view; the confirmation says how
        // much it holds (`trashConfirmation(name:contents:)`) before anything
        // moves, and the Trash gives the whole tree back.
        rows.append(.separator)
        rows.append(Item("Move to Trash", .moveToTrash))
        return rows
    }

    /// What the app asks before moving a file to the Trash, from this menu or
    /// from File > Move to Trash (and so the palette). Asked even though the
    /// Trash gives the file back, because a right-click row sits one slip away
    /// from Copy Path and the palette runs on Return.
    public struct TrashConfirmation: Equatable, Sendable {
        public let message: String
        public let detail: String
        public let confirm: String
        public let cancel: String
    }

    /// What is being trashed, as far as the question needs to know.
    public enum TrashContents: Equatable, Sendable {
        case file
        /// A folder and how many entries are under it, at any depth
        /// (`DirectoryListing.itemCount`). `capped` says the count stopped at
        /// its ceiling, so `items` is a floor rather than the total.
        case folder(items: Int, capped: Bool)
    }

    public static func trashConfirmation(name: String, contents: TrashContents = .file) -> TrashConfirmation {
        let message: String
        switch contents {
        case .file, .folder(items: 0, capped: false):
            message = "Move “\(name)” to the Trash?"
        case .folder(let items, let capped):
            let count = items.formatted()
            let what = capped ? "more than \(count) items" : items == 1 ? "the 1 item" : "the \(count) items"
            message = "Move “\(name)” and \(what) in it to the Trash?"
        }
        return TrashConfirmation(
            message: message,
            detail: "You can put it back from the Trash in the Finder.",
            confirm: "Move to Trash",
            cancel: "Cancel")
    }
}
