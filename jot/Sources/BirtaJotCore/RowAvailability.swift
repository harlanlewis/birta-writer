import Foundation

/// Whether a settings row can do what it says, and what to say when it cannot.
///
/// Two facts a row needs and neither of which is the other. A row can be
/// operable and still be reporting a problem (login registered and waiting on
/// the user), and a row can be inoperable for a reason that is nobody's fault
/// (a development build cannot replace itself). Collapsing them into one flag
/// is what leaves a dead switch with a grey sentence under it that reads like a
/// description of the setting.
///
/// So: `isEnabled` decides whether the controls take a click and whether the
/// LABEL is drawn dimmed, and `tone` decides the colour of the sentence. The
/// surfaces apply that pairing in one place each, which is what keeps a row
/// added later from inventing a third way to look unavailable.
///
/// Here rather than in the window because every rule below is decidable from
/// values: what a development build cannot do, and what macOS reported about a
/// login registration. `RowAvailabilityTests` holds them, and the AppKit half
/// (a dimmed label, a red caption) is read back off a live row by
/// `SettingsRowViewTests`.
public struct RowAvailability: Sendable, Equatable {
    /// Whether the row's controls take a click. False also dims the label, so
    /// a dead switch is not the only thing saying so.
    public let isEnabled: Bool
    /// The sentence under the row. Empty means the label says it already.
    public let note: String
    /// What the sentence IS, which is what colours it.
    public let tone: Tone

    public enum Tone: Sendable, Equatable {
        /// Describes the setting. Drawn in the ordinary secondary ink.
        case explanatory
        /// Reports something wrong or withheld. Drawn in the system's red.
        case problem
    }

    public init(isEnabled: Bool, note: String, tone: Tone) {
        self.isEnabled = isEnabled
        self.note = note
        self.tone = tone
    }

    /// The row works. Its note, if it has one, describes it.
    public static func available(_ note: String = "") -> RowAvailability {
        RowAvailability(isEnabled: true, note: note, tone: .explanatory)
    }

    /// The row cannot be operated, and the note says why.
    public static func blocked(_ reason: String) -> RowAvailability {
        RowAvailability(isEnabled: false, note: reason, tone: .problem)
    }

    /// The row works and is reporting a problem anyway.
    public static func warning(_ note: String) -> RowAvailability {
        RowAvailability(isEnabled: true, note: note, tone: .problem)
    }

    /// The same availability with an explanatory note dropped.
    ///
    /// For a screen with no room to describe settings that are working, which
    /// is the first run: it asks questions rather than documenting answers. A
    /// PROBLEM survives, and deliberately, because the two screens must not
    /// disagree about what is wrong with a row: the first run is exactly where
    /// somebody meets a copy macOS will not register.
    public var problemsOnly: RowAvailability {
        tone == .problem ? self : RowAvailability(isEnabled: isEnabled, note: "", tone: tone)
    }

    /// Whether the caption is drawn in red. The one reader of `tone`, so the
    /// mapping from meaning to colour lives here rather than at each surface.
    public var isProblem: Bool { tone == .problem }

    /// The auto-update row, given whether this build replaces itself.
    ///
    /// A development build cannot: installing the newest release over it would
    /// delete the change it was installed to show. That is a fact about the
    /// build rather than a setting, so the row is dead and says so in the ink
    /// that means something is withheld.
    public static func autoUpdate(updatesItself: Bool) -> RowAvailability {
        updatesItself
            ? .available("Asks the project's own release page what the newest version is. "
                         + "Installing is always a click.")
            : .blocked("A development build does not replace itself.")
    }

    /// A presence row (the menu-bar icon, the Dock icon), from where the app
    /// can be reached right now.
    ///
    /// The rule is `AppPresence`'s and this is only the adapter, in the shape
    /// `startAtLogin` below already established. Both rows go through it, so
    /// the one that is currently last says so and the other stays live.
    public static func appPresence(_ surface: AppPresence.Surface,
                                   menuBar: Bool, dock: Bool) -> RowAvailability {
        AppPresence.isOnlyWayIn(surface, menuBar: menuBar, dock: dock)
            ? .blocked(surface.lastWayInReason)
            : .available()
    }

    /// The start-at-login row, from what the system reported.
    ///
    /// `LoginItemState` already answers both halves; this is the adapter that
    /// puts its answer in the shape every other row uses, so the login row does
    /// not stay the one place with its own vocabulary.
    public static func startAtLogin(_ state: LoginItemState) -> RowAvailability {
        RowAvailability(isEnabled: state.isEnabled, note: state.caption,
                        tone: state.isWarning ? .problem : .explanatory)
    }
}
