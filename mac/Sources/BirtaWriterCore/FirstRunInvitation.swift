import Foundation

/// What the menu bar says to somebody who has just installed this, and how
/// long it waits before opening the panel anyway.
///
/// The one thing a first run has to teach is the summon, and the only way to
/// teach a gesture is to have the person make it. So this says where the app
/// lives and which keys to press, and nothing else: no buttons, nothing to
/// dismiss, and no route to the panel except the chord. What the panel then
/// holds is `FirstRunNote`.
///
/// The refused arm is the one that cannot be left out. This is now the FIRST
/// surface that teaches the chord, and on a first run nobody has recorded
/// anything, so a refusal is a refusal of the DEFAULT: the reader would be
/// told to press a chord macOS has already given to somebody else, would
/// press it, and would conclude the app is broken (MAR-407). So the chord is
/// not drawn at all when it is dead, the sentence names the one that was
/// taken, and the panel arrives on its own instead.
public struct FirstRunInvitation: Equatable, Sendable {
    /// What the registration left to work with.
    public enum Chord: Equatable, Sendable {
        /// The chord macOS is holding, in the glyphs a person reads.
        case press(String)
        /// The chord macOS refused, which is the one thing this must not tell
        /// anybody to press.
        case refused(String)
    }

    /// The build's own name, taken rather than read.
    ///
    /// `AppFlavor.current` answers `.release` inside an xctest process, so a
    /// type that read it would have one arm nothing could reach. The same
    /// reason `WelcomeView` and `SettingsWindowController` take theirs.
    public let name: String
    public let chord: Chord

    public init(name: String, chord: Chord) {
        self.name = name
        self.chord = chord
    }

    /// The invitation for a build whose default chord is `combo`, given what
    /// the registration actually did.
    ///
    /// `refused` is `GlobalHotkey.refusedCombo`, read rather than derived, for
    /// the reason that type's header gives: it is the one place that knows
    /// what macOS answered, and nothing retries, so a refusal stays true for
    /// as long as it is worth reading.
    public static func of(name: String,
                          combo: HotkeyCombo,
                          refused: HotkeyCombo?) -> FirstRunInvitation {
        FirstRunInvitation(name: name,
                           chord: refused.map { .refused($0.symbols) } ?? .press(combo.symbols))
    }

    /// Where the app lives, which is the fact the menu bar is the only place
    /// to learn.
    public var headline: String { "\(name) lives up here." }

    /// The chord to draw on its own, or nil when there is none worth pressing.
    public var chordToPress: String? {
        switch chord {
        case .press(let chord): return chord
        case .refused: return nil
        }
    }

    /// The sentence under it. Both halves of the gesture in the working case,
    /// because putting it away is the half that makes summoning it safe.
    public var body: String {
        switch chord {
        case .press:
            return "Press it to open a note, and press it again to put it away."
        case .refused(let taken):
            return "Another app on this Mac already uses \(taken), so it will not open "
                + "\(name). The panel is opening now, and Settings can give it a chord of "
                + "its own."
        }
    }

    /// Whether the sentence is reporting a problem rather than teaching a
    /// gesture, which is what decides the colour it is drawn in.
    public var isProblem: Bool {
        switch chord {
        case .press: return false
        case .refused: return true
        }
    }

    /// How long the panel waits for the chord before coming up on its own.
    ///
    /// A menu bar item is easy to miss, and somebody who launched the app and
    /// immediately switched away would otherwise have installed a thing that
    /// never opened. So there is a floor under the first run, and the panel
    /// takes it. Only the chord clears it: a popover dismissed by a click
    /// elsewhere says the sentence was in the way, not that the gesture was
    /// learned.
    ///
    /// Long enough to read a sentence and try the keys, and no longer: what it
    /// trades is a chance to learn the gesture against a window that never
    /// opens. The refused arm is much shorter because there is no gesture to
    /// wait for, and waiting on a dead chord only delays the one thing that
    /// can still happen.
    public var wait: TimeInterval {
        switch chord {
        case .press: return Self.waitForChord
        case .refused: return Self.waitWhenChordIsDead
        }
    }

    public static let waitForChord: TimeInterval = 20
    public static let waitWhenChordIsDead: TimeInterval = 3
}
