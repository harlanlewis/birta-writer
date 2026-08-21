import Foundation

/// The label on a settings row, in one place because two screens draw it.
///
/// A raw value here is user-visible text. It is an enum rather than a string
/// at each call site so that a row appearing on both screens is spelled once,
/// and it must stay that way: two spellings of one control leave somebody who
/// answered the question on first run with no row by that name to go back to.
public enum SettingsRow: String, CaseIterable, Sendable {
    case summon = "Show and hide Jot"
    case storeInICloud = "Store in iCloud Drive"
    case location = "Location"
    case autosave = "Autosave"
    case showInDock = "Show in Dock"
    case startAtLogin = "Start at login"
    case autoUpdate = "Automatically update"
    case richLinks = "Rich link previews and embeds"
    case opens = "New windows open with"
    case newNoteName = "File name"
    case agentEnabled = "Enable /ai commands"
    case agentCommand = "Terminal command"
    case resetSettings = "Reset all settings"
    case welcomeScreen = "Welcome screen"
}

/// The rows the FIRST RUN asks about, as their own type.
///
/// A subset of `SettingsRow`, declared rather than described. The first-run
/// screen switches exhaustively over this, so a row added here is a compile
/// error until it is wired, and a Settings-only row cannot reach that screen
/// at all: naming the subset in a comment and hoping is what let two screens
/// spell one control two ways.
public enum WelcomeRow: CaseIterable, Sendable {
    case summon, storeInICloud, location, showInDock, startAtLogin, autoUpdate

    /// The Settings row it is, which is where its label lives.
    public var settingsRow: SettingsRow {
        switch self {
        case .summon: return .summon
        case .storeInICloud: return .storeInICloud
        case .location: return .location
        case .showInDock: return .showInDock
        case .startAtLogin: return .startAtLogin
        case .autoUpdate: return .autoUpdate
        }
    }
}

/// One card on the first-run screen. No heading: that screen draws none.
public struct WelcomeGroup: Sendable {
    public let rows: [WelcomeRow]
    public init(rows: [WelcomeRow]) { self.rows = rows }
}

/// One card: the rows in it, the heading above it, and the sentence between
/// the two.
///
/// Both optional, and they are different kinds of absent. Most groups carry no
/// heading, because a card of plain switches is bounded by its own fill and a
/// title over it would name what the rows already say. A heading earns its
/// place where a card is a SUBJECT rather than a list, which today is the
/// agent group: it holds a capability somebody has to opt into, and the intro
/// beneath the heading is where the thing being opted into is explained.
public struct SettingsGroup: Sendable {
    public let heading: String?
    /// A sentence under the heading and above the card. For a group whose rows
    /// cannot explain themselves; never a caption belonging to one row, which
    /// is the row's own.
    public let intro: String?
    public let rows: [SettingsRow]

    public init(heading: String? = nil, intro: String? = nil, rows: [SettingsRow]) {
        self.heading = heading
        self.intro = intro
        self.rows = rows
    }
}

/// WHICH rows each screen shows and in what order, as data both screens
/// render rather than a layout each screen writes out.
///
/// The rule this exists to hold: the first-run screen is a SUBSET of Settings'
/// General pane, in the same order and the same words, so a question somebody
/// answered on first run is found again by looking where they answered it.
/// Two arrays a test compares, never a rule each screen is trusted to keep;
/// `SettingsFormTests` is what compares them, and `SettingsPaneTests` and
/// `WelcomeScreenTests` compare each against what is actually drawn.
///
/// What the first run leaves out is every row with a default worth keeping and
/// no consequence for somebody who never opens Settings. A screen listing all
/// of them is a form rather than a welcome.
public enum SettingsForm {
    public static let welcome: [WelcomeGroup] = [
        WelcomeGroup(rows: [.summon]),
        WelcomeGroup(rows: [.storeInICloud, .location]),
        WelcomeGroup(rows: [.showInDock, .startAtLogin, .autoUpdate]),
    ]

    /// What Jot IS: how you reach it, where it puts your bytes, and how it
    /// behaves as an application on this Mac. Every first-run question is
    /// here, in the order it was asked.
    public static let general: [SettingsGroup] = [
        SettingsGroup(rows: [.summon]),
        SettingsGroup(rows: [.storeInICloud, .location, .autosave]),
        SettingsGroup(rows: [.showInDock, .startAtLogin, .autoUpdate, .richLinks]),
    ]

    /// What happens INSIDE the panel: which note a summon opens, what a new
    /// one is called, and the agent `/ai` hands a prompt to.
    public static let editor: [SettingsGroup] = [
        SettingsGroup(rows: [.opens, .newNoteName]),
        SettingsGroup(heading: "AI Agent",
                      intro: "Jot can hand a prompt to a command-line coding agent you have "
                           + "already installed, and write what it says back into the note. It "
                           + "runs on this Mac under your own subscription or API key; Jot adds "
                           + "no account of its own and sends nothing anywhere else.",
                      rows: [.agentEnabled, .agentCommand]),
    ]

    /// The two gestures that undo rather than set: see the first run again,
    /// and put every setting back.
    public static let advanced: [SettingsGroup] = [
        SettingsGroup(rows: [.welcomeScreen, .resetSettings]),
    ]

    /// Every pane, in toolbar order. `SettingsFormTests` sums these to check
    /// that a case added to `SettingsRow` was actually placed on a screen, and
    /// summing a LIST rather than naming each array is what stops a new pane
    /// being invisible to that guard: an array left out of a hand-written sum
    /// reads as rows unplaced, and an array left out of this one cannot be
    /// left out, because the panes are what this is.
    public static let panes: [[SettingsGroup]] = [general, editor, advanced]

    /// The rows of a Settings pane, top to bottom, with the cards flattened
    /// away.
    public static func rows(of groups: [SettingsGroup]) -> [SettingsRow] {
        groups.flatMap(\.rows)
    }

    /// The same for the first-run screen, as Settings rows, which is what makes
    /// the two comparable.
    public static func rows(of groups: [WelcomeGroup]) -> [SettingsRow] {
        groups.flatMap(\.rows).map(\.settingsRow)
    }

    /// Where a row sits in its own card, so the code that shows and hides one
    /// under the answer above it asks rather than counting.
    public static func index(of row: SettingsRow, inGroupOf groups: [SettingsGroup]) -> Int? {
        groups.first { $0.rows.contains(row) }?.rows.firstIndex(of: row)
    }

    public static func index(of row: WelcomeRow, inGroupOf groups: [WelcomeGroup]) -> Int? {
        groups.first { $0.rows.contains(row) }?.rows.firstIndex(of: row)
    }
}
