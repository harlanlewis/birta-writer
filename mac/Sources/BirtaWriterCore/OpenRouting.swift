import Foundation

/// WHERE a file the app is asked to open lands, once windows can be rooted at
/// folders and hold tabs (MAR-457).
///
/// Every gesture that opens a file from OUTSIDE a window (Open With in the
/// Finder, a Dock drop, `open -a`, Cmd+O, a row of Open Recent, a palette
/// file outside the front window's root) funnels through `destination`, and a
/// row of a window's own explorer through `explorerDestination`. Both are
/// written with no window so each arm can be asked about.
///
/// The outside route, in order:
///
/// 1. A file already open anywhere fronts its own tab. Two buffers over one
///    path hold two writers and the later write wins silently, so this arm is
///    a data-loss guard before it is tidiness.
/// 2. A file inside an open directory window's root becomes a tab in that
///    window, so the folder's files stay together under the folder's
///    explorer. The window in front wins when several are rooted over it,
///    else the most recently fronted.
/// 3. The window in front is standing on a file that has gone with nothing
///    typed, so it takes the file over rather than leaving a dead window
///    behind a new one.
/// 4. Otherwise the "Open files in" setting decides: a tab beside the window
///    in front, or a window of its own.
public enum OpenRouting {
    /// One open window as the decision sees it. `root` is the folder a
    /// directory window is rooted at, nil for a window on a loose file.
    /// `group` names the tab bar the window shares, nil for a window with
    /// no tabs; two windows with equal non-nil groups are tabs of one window.
    public struct Window: Equatable, Sendable {
        public let file: String
        public let root: String?
        public let isVacant: Bool
        public let group: String?

        public init(file: String, root: String? = nil, isVacant: Bool = false, group: String? = nil) {
            self.file = file
            self.root = root
            self.isVacant = isVacant
            self.group = group
        }
    }

    public enum Destination: Equatable, Sendable {
        /// Front the window at this index; the file is already open there.
        case existing(Int)
        /// A new tab in the group of the window at this index, whose root
        /// holds the file.
        case tabIn(Int)
        /// The window in front takes the file over in place.
        case vacantFront
        /// A new tab beside the window at this index, on a loose file: the
        /// file is under no open root, and the setting asks for a tab.
        case tabBeside(Int)
        /// A window of its own, and one the system may not fold into a tab
        /// when the setting asked for a window.
        case newWindow
    }

    /// - Parameters:
    ///   - windows: every open window, most recently fronted LAST, which is
    ///     the order `WindowSet.windows` keeps.
    ///   - looseFilesOpenInTab: the "Open files in" setting, true for a tab.
    ///   - sameFile: whether two paths name one file.
    ///   - isInside: whether a file path is inside a root path.
    public static func destination(for file: String,
                                   windows: [Window],
                                   looseFilesOpenInTab: Bool,
                                   sameFile: (String, String) -> Bool,
                                   isInside: (String, String) -> Bool) -> Destination {
        if let open = windows.firstIndex(where: { sameFile($0.file, file) }) {
            return .existing(open)
        }
        if let rooted = windows.lastIndex(where: { root in
            root.root.map { isInside(file, $0) } ?? false
        }) {
            return .tabIn(rooted)
        }
        if windows.last?.isVacant == true {
            return .vacantFront
        }
        if looseFilesOpenInTab, !windows.isEmpty {
            return .tabBeside(windows.count - 1)
        }
        return .newWindow
    }

    // MARK: the explorer

    public enum ExplorerDestination: Equatable, Sendable {
        /// Front the tab at this index, which shares the clicked window's
        /// tab bar; the file is already open there.
        case existing(Int)
        /// The clicked window takes the file over in place of its own.
        case replaceHere
        /// A new tab in the clicked window's group.
        case tabHere
    }

    /// WHERE a file picked in a window's own explorer lands.
    ///
    /// A row click is navigation: the reader is moving the window they are
    /// looking at from one file of the folder to the next, the way a sidebar
    /// in any notes application does, so the file replaces the one in the
    /// tab that was clicked in. A new tab is the reader's explicit ask, by
    /// Cmd+click, middle click or the row's Open in New Tab.
    ///
    /// The window stays the one that was clicked in. A file already open as
    /// another tab of that same window fronts that tab; one open in some
    /// OTHER window does not pull the reader across to it, because a click
    /// in this window's sidebar is an instruction about this window. That
    /// second buffer over one path is the reader's to hold: the later write
    /// wins, and nothing here reconciles the two.
    ///
    /// One thing overrides the replace: a tab whose text is not on disk and
    /// will not be written by leaving it (autosave off, the title reading
    /// Edited). The file opens in a new tab beside it instead, and the edited
    /// one is left exactly as it was.
    ///
    /// - Parameters:
    ///   - windows: every open window, as `destination(for:)` takes them.
    ///   - here: the index of the window whose explorer was clicked.
    ///   - inNewTab: the reader asked for a new tab.
    ///   - hereHoldsUnsavedText: the clicked window's buffer is ahead of its
    ///     file with nothing about to write it.
    public static func explorerDestination(for file: String,
                                           windows: [Window],
                                           here: Int,
                                           inNewTab: Bool,
                                           hereHoldsUnsavedText: Bool,
                                           sameFile: (String, String) -> Bool) -> ExplorerDestination {
        let group = windows.indices.contains(here) ? windows[here].group : nil
        // By index, never by value: two windows can read alike (one file,
        // one root, no tabs) and still be two windows.
        if let open = windows.indices.first(where: { index in
            sameFile(windows[index].file, file)
                && (index == here || (group != nil && windows[index].group == group))
        }) {
            return .existing(open)
        }
        return inNewTab || hereHoldsUnsavedText ? .tabHere : .replaceHere
    }
}
