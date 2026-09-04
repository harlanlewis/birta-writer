import Foundation

/// A summon's activation, issued again once the Space switch it caused has
/// landed.
///
/// A window brought forward from inside another application's full screen
/// cannot come to the reader: `WindowPolicy` keeps it off other
/// applications' full screens, so what macOS does instead is switch to the
/// Space the window is already on. That switch is a window-server transition
/// and it is not synchronous with the activation the summon has just issued, so
/// its tail lands afterwards and undoes it. A Space arrives with the
/// application it remembers in front, which is how a summon ends with the
/// window drawn for a moment and somebody else's application frontmost.
/// `AppDelegate.applyActivationPolicy` states the same hazard for the other
/// window-server transition this app makes, and answers it the same way.
///
/// So the activation is issued a second time when the switch lands. What this
/// type decides is WHICH Space change is the summon's own, because a reader who
/// changes Space themselves must not be dragged back to a window they did not
/// ask for: a change belongs to the summon only while the summon is armed, and
/// the first change disarms it whether it is answered or not.
///
/// Decidable from a clock and nothing else, so it is checkable with no AppKit,
/// no window server and no second Space. `WindowSet` is the adapter: it arms
/// wherever a window comes forward, which is the hotkey and every other route
/// too, disarms on dismissal, and asks here from its observer of
/// `NSWorkspace.activeSpaceDidChangeNotification`.
public struct SummonActivation: Sendable {
    /// How long after a summon a Space change is still that summon's own.
    ///
    /// A budget rather than a measurement, and it is chosen from both
    /// directions: long enough to outlast a Space transition this app does not
    /// own and cannot ask about, short enough that a Space change the reader
    /// made themselves falls outside it and stays theirs.
    public static let settleInterval: TimeInterval = 2

    /// When the last summon issued its activation, while a Space change is
    /// still expected to answer it.
    private var armedAt: TimeInterval?

    public init() {}

    /// Whether a Space change would still be answered.
    public var isArmed: Bool { armedAt != nil }

    /// A summon has issued its activation.
    public mutating func summoned(at now: TimeInterval) {
        armedAt = now
    }

    /// Nothing is owed any more: the windows have been dismissed, so there is
    /// no activation left to defend.
    public mutating func disarm() {
        armedAt = nil
    }

    /// The active Space changed. Answers whether the summon's activation has to
    /// be issued again, and disarms either way.
    ///
    /// Disarming on a change that is too late matters as much as answering one
    /// that is not. A summon that never caused a Space switch leaves the arm
    /// standing until it expires, and the reader's own next Space change is the
    /// first thing to arrive: it reads the expiry, answers nothing, and clears
    /// the arm rather than leaving it to be re-read.
    public mutating func spaceChanged(at now: TimeInterval) -> Bool {
        defer { armedAt = nil }
        guard let armedAt else { return false }
        return (0..<Self.settleInterval).contains(now - armedAt)
    }
}
