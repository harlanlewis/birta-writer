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
            ? .available("Download and install application updates when not in use.")
            : .blocked("A development build does not replace itself.")
    }

    /// The auto-update row for a build of this flavour on this channel.
    ///
    /// The channel is asked first, because its reason holds whatever the
    /// flavour says: a store copy is the store's to update. A direct build
    /// then answers for its flavour exactly as before.
    public static func autoUpdate(flavour: AppFlavor, distribution: Distribution) -> RowAvailability {
        distribution.updatesItself
            ? autoUpdate(updatesItself: flavour.updatesItself)
            : .blocked("The App Store keeps this copy up to date.")
    }

    /// The Open from Terminal row, given whether this build may offer it.
    ///
    /// A store build cannot: the command is a link written outside the
    /// sandbox to a binary that runs outside it. The sentence names where the
    /// command does exist rather than only that it does not here.
    public static func terminalCommand(offered: Bool) -> RowAvailability {
        offered
            ? .available()
            : .blocked("An App Store copy cannot put a command on your PATH. The download from the project can.")
    }

    /// The `/ai` switch, given whether this build may offer it. Same reason,
    /// one step further: `/ai` runs a command, and the sandbox runs none.
    public static func agent(offered: Bool) -> RowAvailability {
        offered
            ? .available()
            : .blocked("An App Store copy cannot run a command on this Mac, which is what /ai does. The download from the project can.")
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

    /// The summon row, from what macOS said about the chord in force.
    ///
    /// `refused` is that chord, and nil means the registration was taken. **Nil
    /// says nothing rather than confirming the chord, and the silence is the rule
    /// rather than a missing sentence.** `GlobalHotkey.registrationOptions`
    /// measures why: a refusal
    /// proves the summon is dead, and a clean status proves nothing either way,
    /// because a holder that registered plainly does not refuse us and the keys
    /// macOS binds outside the Carbon registry never reach it at all. A row
    /// reading "this combination is yours" off a clean status would be claiming
    /// what nothing on this machine can check.
    ///
    /// A warning rather than `blocked`: the recorder still takes a click, and
    /// recording a replacement is the one move that fixes this.
    ///
    /// The ways back in come from `AppPresence` rather than being named here,
    /// so the escape hatch this sentence offers is one the app is actually
    /// showing. Naming the menu-bar icon unconditionally would be wrong for
    /// somebody running with the Dock icon and no menu-bar item, which is a
    /// configuration that rule permits.
    /// It takes the combo rather than a spelling, so the chord is drawn by
    /// `HotkeyCombo.symbols` here and cannot be spelled two ways by two screens,
    /// which is how the two sentences this replaces came apart in the first
    /// place.
    public static func summon(refused: HotkeyCombo?, menuBar: Bool, dock: Bool) -> RowAvailability {
        guard let refused else { return .available() }
        let waysIn = AppPresence.Surface.allCases
            .filter { AppPresence.isShown($0, menuBar: menuBar, dock: dock) }
            .map(\.name)
        let refusal = "macOS refused \(refused.symbols); another app may own it."
        // Unreachable by `AppPresence`'s invariant, and still answered rather
        // than asserted: a rule that trapped here would take the app down over
        // a sentence, and a half-sentence about an escape hatch that does not
        // exist is worse than none.
        guard !waysIn.isEmpty else { return .warning(refusal) }
        return .warning(refusal + " Birta Writer still opens from "
                        + waysIn.joined(separator: " or ") + ".")
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
