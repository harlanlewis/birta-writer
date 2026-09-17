import Foundation

/// What the app decides about window tabs, with no window (MAR-393).
///
/// A tab is a window: AppKit's window tabbing groups whole `NSWindow`s under
/// one tab bar, so every tab here is a `Coordinator` with its own page and its
/// own file, and the app's existing rules about windows carry over. What is
/// new is a handful of decisions about the GROUP, and each is written here so
/// it can be asked about without a window server: which windows may share a
/// bar, what closing means once a window holds several tabs, which chord
/// selects which tab, and how the titlebar band the page sizes its first row
/// from splits once a tab bar has taken a row of it.
public enum TabGroupPolicy {
    // MARK: grouping

    /// Which windows may share a tab bar.
    ///
    /// Windows on loose files share one identifier; a directory window's tabs
    /// share one made from its root, so Merge All Windows folds notes with
    /// notes and never a folder's explorer into a stack of loose files
    /// (MAR-457). Under the bundle id, so a development build beside the
    /// release never offers to merge with it.
    public static func tabbingIdentifier(bundleID: String, root: String?) -> String {
        guard let root else { return "\(bundleID).notes" }
        return "\(bundleID).root:\(root)"
    }

    // MARK: closing

    public enum CloseOutcome: Equatable, Sendable {
        /// Close this one tab; the window keeps the rest.
        case closeTab
        /// Close every tab in this window; other windows stay.
        case closeWindow
        /// Nothing would be left: hide everything and keep the pages mounted,
        /// so the next summon is instant. The rule the last window always had.
        case hideAll
    }

    /// Cmd+W and the close button: the tab in front goes, unless it is the
    /// last tab of the last window, which hides instead.
    public static func whatCloseDoes(windows: Int) -> CloseOutcome {
        windows > 1 ? .closeTab : .hideAll
    }

    /// Shift+Cmd+W: the whole window goes, unless it holds every window the
    /// app has, which is the last-window case again.
    public static func whatCloseWindowDoes(tabsInWindow: Int, windows: Int) -> CloseOutcome {
        tabsInWindow >= windows ? .hideAll : .closeWindow
    }

    // MARK: the band

    /// The titlebar band, split into the title row the page centres its first
    /// toolbar row on, the row the app holds open for the page's formatting
    /// controls (`FormattingRowSpacer`, zero when none is held), and the tab
    /// bar's row under both, which the page has to leave clear. Zero tab bar
    /// and zero page row mean the whole band is the title row.
    ///
    /// The tab bar is taken off the band first and the page row second: the
    /// tab bar is the system's and is drawn whatever the page says, so a
    /// band too short for all three loses the page row before it loses the
    /// tab bar, and never reports a title row below zero.
    public static func bandSplit(band: Double, tabBar: Double, pageRow: Double = 0)
        -> (titleRow: Double, pageRow: Double, tabBar: Double) {
        let whole = max(band, 0)
        let bar = min(max(tabBar, 0), whole)
        let row = min(max(pageRow, 0), whole - bar)
        return (whole - bar - row, row, bar)
    }

    // MARK: chords

    /// A key press as the tab chords read it: the characters with Command and
    /// Option folded out (AppKit's `charactersIgnoringModifiers`, which keeps
    /// Shift, so Shift+] arrives as `}` on a US layout) and the four modifier
    /// flags.
    public struct Chord: Equatable, Sendable {
        public var characters: String
        public var command: Bool
        public var shift: Bool
        public var option: Bool
        public var control: Bool

        public init(characters: String, command: Bool, shift: Bool = false, option: Bool = false, control: Bool = false) {
            self.characters = characters
            self.command = command
            self.shift = shift
            self.option = option
            self.control = control
        }
    }

    /// Which tab a chord selects, or nil for a chord that is not a tab chord
    /// or a window with fewer than two tabs.
    ///
    /// Cmd+1 through Cmd+8 pick that tab; Cmd+9 picks the LAST tab, whatever
    /// its number, as Safari and Terminal do. Shift+Cmd+] and Shift+Cmd+[
    /// step forward and back with wraparound, the chords Safari pairs with
    /// AppKit's own Ctrl+Tab. A digit past the end selects nothing, rather than
    /// the last tab: a chord that meant one tab must not land on another.
    public static func tabSelection(for chord: Chord, count: Int, selected: Int) -> Int? {
        guard count > 1, chord.command, !chord.option, !chord.control else { return nil }
        if !chord.shift, let digit = Int(chord.characters), (1...9).contains(digit) {
            if digit == 9 { return count - 1 }
            return digit <= count ? digit - 1 : nil
        }
        if chord.shift {
            switch chord.characters {
            case "]", "}": return (selected + 1) % count
            case "[", "{": return (selected - 1 + count) % count
            default: return nil
            }
        }
        return nil
    }
}
