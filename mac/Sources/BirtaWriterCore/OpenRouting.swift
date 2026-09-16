import Foundation

/// WHERE a file the app is asked to open lands, once windows can be rooted at
/// folders and hold tabs (MAR-457).
///
/// Every gesture that opens a file (Open With in the Finder, a Dock drop,
/// `open -a`, Cmd+O, a row of Open Recent, a row of the file explorer) funnels
/// through one decision, and this is it, written with no window so each arm
/// can be asked about:
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
/// 4. Otherwise a new window, which the system's tab preference may make a
///    tab.
public enum OpenRouting {
    /// One open window as the decision sees it. `root` is the folder a
    /// directory window is rooted at, nil for a window on a loose file.
    public struct Window: Equatable, Sendable {
        public let file: String
        public let root: String?
        public let isVacant: Bool

        public init(file: String, root: String? = nil, isVacant: Bool = false) {
            self.file = file
            self.root = root
            self.isVacant = isVacant
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
        case newWindow
    }

    /// - Parameters:
    ///   - windows: every open window, most recently fronted LAST, which is
    ///     the order `WindowSet.windows` keeps.
    ///   - sameFile: whether two paths name one file.
    ///   - isInside: whether a file path is inside a root path.
    public static func destination(for file: String,
                                   windows: [Window],
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
        return .newWindow
    }
}
