import Foundation

/// The label on a settings row, in one place because two screens draw it.
///
/// A raw value here is user-visible text. It is an enum rather than a string
/// at each call site so that a row appearing on both screens is spelled once,
/// and it must stay that way: two spellings of one control leave somebody who
/// answered the question on first run with no row by that name to go back to.
public enum SettingsRow: String, CaseIterable, Sendable {
    case summon = "Show and hide Birta Writer"
    case storeInICloud = "Store in iCloud Drive"
    case location = "Location"
    case autosave = "Automatically save changes"
    case showInMenuBar = "Show in menu bar"
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

/// One card: the rows in it, and nothing else.
///
/// A card carries no heading of its own, and that is a decision rather than an
/// omission. A card of plain switches is bounded by its own fill, so a title
/// over it names what the rows already say; and where a pane really does need
/// explaining, the thing being explained is the pane, whose tab already names
/// it. That sentence belongs to `SettingsPane.intro`.
public struct SettingsGroup: Sendable {
    public let rows: [SettingsRow]

    public init(rows: [SettingsRow]) {
        self.rows = rows
    }
}

/// One Settings pane: what it says before the first card, and the cards.
///
/// The intro sits under the pane's own tab title, which is the heading it
/// belongs to. It is for a pane holding a capability somebody has to opt into
/// and would otherwise have to guess at; a pane of ordinary settings has none,
/// because a paragraph over a list of switches is a preamble nobody reads on
/// the way to a control they can already see.
public struct SettingsPane: Sendable {
    /// Paragraphs above the first card. Empty for most panes.
    public let intro: [String]
    public let groups: [SettingsGroup]

    public init(intro: [String] = [], groups: [SettingsGroup]) {
        self.intro = intro
        self.groups = groups
    }
}

/// WHICH rows each screen shows and in what order, as data both screens
/// render rather than a layout each screen writes out.
///
/// The rule this exists to hold: the first-run screen is a SUBSET of Settings,
/// in the same order and the same words, so a question somebody answered on
/// first run is found again by looking for it in Settings, reading the tabs
/// left to right and each pane top to bottom. That reading order is `allRows`,
/// and it is what the subset is taken of. It is deliberately not General
/// alone: a first-run question can belong to a pane that is not General, and
/// the invariant that matters is that the question is FINDABLE and that the
/// two screens agree on the order, not that Settings keeps every answer on one
/// tab. Automatically update is the row that makes the distinction real.
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

    /// What the app IS: how you reach it, where it puts your bytes, which note a
    /// summon opens, and how it behaves as an application on this Mac.
    ///
    /// Which note a summon opens is a General question and not an editor one,
    /// under the same argument that keeps Autosave here: both are about which
    /// file your typing ends up in, which is settled before the editor sees
    /// anything.
    ///
    /// A card is one SUBJECT: a question and its dependents, or the few
    /// questions a reader would look for in the same place. Two cards here hold
    /// more than one switch, and each earns it differently.
    ///
    /// The presence rows are one question asked twice (where can this app be
    /// reached from), and `RowAvailability.appPresence` makes each one's answer
    /// depend on the other, so the card is where that dependence is visible.
    ///
    /// Store in iCloud Drive and Automatically save changes are independent of
    /// each other and share a card anyway: both are about where your typing ends
    /// up, which is the same argument that keeps Autosave on this pane at all
    /// rather than with the editor's own settings. Nothing links them
    /// mechanically, so nothing enforces the pairing; it is a reading order.
    ///
    /// `.location` and `.newNoteName` are hidden dependents rather than cards
    /// of their own, and each sits directly under the row that takes it away.
    /// `SettingsWindowController.setRowHidden` reaches into a card by index,
    /// so the pair has to stay in one card and in that order.
    public static let general = SettingsPane(groups: [
        SettingsGroup(rows: [.summon]),
        SettingsGroup(rows: [.storeInICloud, .location, .autosave]),
        SettingsGroup(rows: [.opens, .newNoteName]),
        SettingsGroup(rows: [.showInDock, .showInMenuBar]),
        SettingsGroup(rows: [.startAtLogin]),
        SettingsGroup(rows: [.richLinks]),
    ])

    /// The agent `/ai` hands a prompt to.
    ///
    /// The only pane with an intro, and it earns one: everything on it is off
    /// until somebody turns it on, and what they would be turning on runs a
    /// program on their Mac and may cost them money. The tab is the heading
    /// the paragraphs sit under, which is why no card here carries one.
    public static let aiAgent = SettingsPane(
        intro: [
            "Optionally enable Birta Writer to use your existing AI agent CLI tool to read and edit "
                + "your note files. Requires the tool to be installed and runnable from Terminal.",
            "The /ai command uses your existing authentication and needs no additional "
                + "configuration.",
            "Your AI provider (OpenAI, Anthropic, etc) may charge standard API or subscription "
                + "utilization when used.",
        ],
        groups: [SettingsGroup(rows: [.agentEnabled, .agentCommand])])

    /// What the app does to ITSELF: how it replaces itself, and the gestures
    /// that undo rather than set.
    ///
    /// Automatically update is here rather than on General because it is a
    /// question about the program and not about the writing, and it is the one
    /// row on either pane that some builds cannot answer at all: a development
    /// build cannot replace itself, so the row is dead and says so
    /// (`RowAvailability.autoUpdate`). Its own card, because the reset
    /// gestures below are destructive and a card is the boundary that keeps a
    /// switch from reading as one of them.
    ///
    /// Reset before Welcome screen: reset is the row every build shows, and
    /// the one below it exists only on a build that shows the first run.
    ///
    /// Take the flavour rather than reading it, so both arms are checkable
    /// without a defaults domain or a second bundle.
    public static func advanced(showsWelcomeScreen: Bool) -> SettingsPane {
        SettingsPane(groups: [
            SettingsGroup(rows: [.autoUpdate]),
            SettingsGroup(rows: showsWelcomeScreen ? [.resetSettings, .welcomeScreen]
                                                   : [.resetSettings]),
        ])
    }

    /// Every pane, in toolbar order. `SettingsFormTests` sums these to check
    /// that a case added to `SettingsRow` was actually placed on a screen, and
    /// summing a LIST rather than naming each array is what stops a new pane
    /// being invisible to that guard: an array left out of a hand-written sum
    /// reads as rows unplaced, and an array left out of this one cannot be
    /// left out, because the panes are what this is.
    ///
    /// Advanced appears in its WIDEST form, because what this list is read for
    /// is coverage: a row some build hides is still a row that has to be
    /// placed somewhere, and a `panes` that hid it would report it unplaced.
    public static var panes: [SettingsPane] {
        [general, aiAgent, advanced(showsWelcomeScreen: true)]
    }

    /// The rows of a Settings pane, top to bottom, with the cards flattened
    /// away.
    public static func rows(of pane: SettingsPane) -> [SettingsRow] {
        pane.groups.flatMap(\.rows)
    }

    /// Every Settings row in the order somebody looking for one walks: the
    /// tabs left to right, each pane top to bottom.
    ///
    /// This is the sequence the first-run screen is an ordered subset of, and
    /// naming it here rather than at each test is what keeps the invariant one
    /// claim: `SettingsFormTests` takes the subset of this declaration, and
    /// `SettingsPaneTests` takes it of the labels read back off the live panes
    /// in the same tab order.
    ///
    /// In Advanced's WIDEST form, for the same reason `panes` is: what this is
    /// read for is where a row can be found, and a row some build hides is
    /// still a row that has to have somewhere to be.
    public static var allRows: [SettingsRow] { panes.flatMap(rows(of:)) }

    /// The same for the first-run screen, as Settings rows, which is what makes
    /// the two comparable.
    public static func rows(of groups: [WelcomeGroup]) -> [SettingsRow] {
        groups.flatMap(\.rows).map(\.settingsRow)
    }

    /// Where a row sits in its own card, so the code that shows and hides one
    /// under the answer above it asks rather than counting.
    public static func index(of row: SettingsRow, inPane pane: SettingsPane) -> Int? {
        pane.groups.first { $0.rows.contains(row) }?.rows.firstIndex(of: row)
    }

    public static func index(of row: WelcomeRow, inGroupOf groups: [WelcomeGroup]) -> Int? {
        groups.first { $0.rows.contains(row) }?.rows.firstIndex(of: row)
    }
}
