import Foundation

/// The label on a settings row, in one place because two screens draw it.
///
/// A raw value here is user-visible text. It is an enum rather than a string
/// at each call site so that a row appearing on both screens is spelled once:
/// the first-run screen and Settings had drifted to `Show and hide Jot` and
/// `Summon Jot` for the same control, which leaves somebody who answered the
/// question on first run with no row by that name to go back to.
public enum SettingsRow: String, CaseIterable, Sendable {
    case summon = "Show and hide Jot"
    case storeInICloud = "Store in iCloud Drive"
    case location = "Location"
    case autosave = "Autosave"
    case showInDock = "Show in Dock"
    case startAtLogin = "Start at login"
    case richLinks = "Rich link previews and embeds"
    case opens = "Opens"
    case agentPreset = "Agent"
    case agentCommand = "Command"
    case checkForUpdates = "Check for updates"
    case resetSettings = "All settings"
    case welcomeScreen = "Welcome screen"
}

/// One card: the rows in it, and the heading above it where a screen draws
/// headings. The first-run screen draws none, so `heading` is optional rather
/// than each screen carrying a parallel list of titles.
public struct SettingsGroup: Sendable {
    public let heading: String?
    public let rows: [SettingsRow]

    public init(heading: String? = nil, rows: [SettingsRow]) {
        self.heading = heading
        self.rows = rows
    }
}

/// WHICH rows each screen shows and in what order, as data both screens
/// render rather than a layout each screen writes out.
///
/// The rule this exists to hold: the first-run screen is a SUBSET of Settings'
/// General pane, in the same order and the same words, so a question somebody
/// answered on first run is found again by looking where they answered it.
/// That was prose in two files, and it was already broken. Here it is two
/// arrays a test compares, and `SettingsFormTests` is what compares them.
///
/// What the first run leaves out is every row with a default worth keeping and
/// no consequence for somebody who never opens Settings. A screen listing all
/// of them is a form rather than a welcome.
public enum SettingsForm {
    public static let welcome: [SettingsGroup] = [
        SettingsGroup(rows: [.summon]),
        SettingsGroup(rows: [.storeInICloud, .location]),
        SettingsGroup(rows: [.showInDock, .startAtLogin]),
    ]

    public static let general: [SettingsGroup] = [
        SettingsGroup(heading: "Show and hide Jot", rows: [.summon]),
        SettingsGroup(heading: "Where your notes live", rows: [.storeInICloud, .location]),
        SettingsGroup(heading: "How Jot works",
                      rows: [.autosave, .showInDock, .startAtLogin, .richLinks]),
    ]

    public static let advanced: [SettingsGroup] = [
        SettingsGroup(heading: "Notes", rows: [.opens]),
        SettingsGroup(heading: "Agent", rows: [.agentPreset, .agentCommand]),
        SettingsGroup(heading: "Updates", rows: [.checkForUpdates]),
        SettingsGroup(heading: "Reset", rows: [.resetSettings, .welcomeScreen]),
    ]

    /// The rows of a screen, top to bottom, with the cards flattened away.
    public static func rows(of groups: [SettingsGroup]) -> [SettingsRow] {
        groups.flatMap(\.rows)
    }

    /// Where the Location row sits in its own card, so the code that shows and
    /// hides it under the iCloud answer above asks rather than counting.
    public static func index(of row: SettingsRow, inGroupOf groups: [SettingsGroup]) -> Int? {
        groups.first { $0.rows.contains(row) }?.rows.firstIndex(of: row)
    }
}
