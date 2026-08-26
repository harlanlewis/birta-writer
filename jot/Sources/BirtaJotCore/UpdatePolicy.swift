import Foundation

/// WHEN Jot asks about a new version, and what the offer says when it does.
///
/// Its own type, and in Core, because every rule here is a decision about
/// somebody's attention rather than about AppKit: how often is too often, what
/// a no means and how long it lasts, and which of two sentences is the true
/// one. All of that is decidable from values, so all of it is testable, and
/// the window code is left with nothing but drawing.
///
/// The shape the whole thing is built around: the CHECK is automatic and the
/// INSTALL is never. Swapping the app somebody is typing into is not a thing
/// to do behind them, so nothing here ever returns "go ahead" on its own.
public enum UpdatePolicy {
    /// How long between asking the release host.
    ///
    /// A day. The check used to run once per launch and never again, which is
    /// fine for an app you quit, and Jot is not one: it is a menu-bar
    /// scratchpad that stays running for weeks, so a launch-only check stops
    /// happening for exactly the people who use it most.
    public static let recheckInterval: TimeInterval = 24 * 60 * 60

    /// How long the buttons in the offer stay dead after it appears.
    ///
    /// The offer can arrive mid-sentence, and both of its buttons do something
    /// somebody typing did not ask for: one restarts the app, the other spends
    /// the only chance to mention this version. Three seconds is long enough
    /// that a keystroke already in flight cannot land on either, and short
    /// enough that somebody who came to read it is not kept waiting.
    public static let armingDelay: TimeInterval = 3

    /// The seconds a countdown counts through, largest first.
    ///
    /// A dead button with nothing to say about it reads as a broken dialog,
    /// and the reading is reasonable: from the outside there is no difference
    /// between a control that is not ready and one that does not work. The
    /// count is what turns the wait into something with a visible end, and
    /// `armingNote` is what says why there is a wait at all.
    ///
    /// Rounded UP, so the last number shown is never a lie in the direction
    /// that costs: a button reading (1) with a fraction of a second still to
    /// go is a moment's wait, and one reading (0) that cannot be clicked is
    /// the broken dialog this exists to avoid. Empty for a delay of nothing,
    /// which is the case where there is no wait to explain.
    public static func countdownSteps(for delay: TimeInterval) -> [Int] {
        guard delay > 0 else { return [] }
        return Array((1...max(1, Int(delay.rounded(.up)))).reversed())
    }

    /// Why the buttons are not live yet.
    ///
    /// Says what is happening and whose side it is on, in one line. It names
    /// the keystroke rather than the delay because the delay is the mechanism
    /// and the keystroke is the reason: somebody mid-sentence needs to know
    /// this was not answered for them, and the count on the button below is
    /// already saying how long.
    ///
    /// Worded as a rule the sheet keeps rather than as a state it is in, so it
    /// is still true once the wait is over. The sheet cannot take a line away
    /// after it is laid out without leaving the gap where the line was.
    public static let armingNote =
        "Its buttons wait a moment before they work, so a keystroke already on its way to "
            + "your note cannot answer for you."

    /// Whether enough time has passed to ask again.
    ///
    /// Never asked before means yes: a first launch should find out.
    public static func shouldCheck(now: Date, lastCheck: Date?) -> Bool {
        guard let lastCheck else { return true }
        // A last-checked stamp in the FUTURE is a clock that moved backwards,
        // not a check that has not come round yet. Treated as due, because the
        // alternative is an app that silently stops checking until the date
        // it recorded comes back around.
        guard lastCheck <= now else { return true }
        return now.timeIntervalSince(lastCheck) >= recheckInterval
    }

    /// Whether a version somebody has already declined should be raised again.
    ///
    /// One offer per version. Without this the re-check interval becomes a
    /// nag: a person who says no is asked again tomorrow and every day after,
    /// which teaches people to switch updates off rather than to take one. A
    /// DIFFERENT tag is different news and asks.
    public static func shouldOffer(tag: String, declined: String?) -> Bool {
        guard let declined else { return true }
        return tag != declined
    }

    /// What the confirming button says.
    ///
    /// The unwritten-bytes arm is the honest half of a thing that is easy to
    /// get wrong: Jot writes on the way out whatever this says, because
    /// quitting flushes, so neither of these is the difference between keeping
    /// and losing the work. Naming the save is worth doing anyway, since it
    /// tells somebody looking at unwritten bytes what is about to happen to
    /// them; implying that the OTHER button is what protects them would not
    /// be.
    public static func confirmTitle(hasUnwrittenBytes: Bool) -> String {
        hasUnwrittenBytes ? "Save and Restart Birta Writer" : "Restart Birta Writer"
    }

    /// The same title with the wait still to go in parentheses after it.
    ///
    /// On the confirming button rather than beside the pair, because that is
    /// the button somebody reaches for and a count anywhere else is a count
    /// they have to go looking for. Zero, and anything under it, is the armed
    /// title unchanged: there is nothing left to say once the button works.
    ///
    /// The count is a SUFFIX, and the widest form is the one the offer opens
    /// with, so the button is laid out for the longest string it will ever
    /// hold and every later title fits the frame it was given.
    public static func confirmTitle(hasUnwrittenBytes: Bool, secondsRemaining: Int) -> String {
        let armed = confirmTitle(hasUnwrittenBytes: hasUnwrittenBytes)
        guard secondsRemaining > 0 else { return armed }
        return "\(armed) (\(secondsRemaining))"
    }

    /// The sentence under the offer.
    public static func detail(hasUnwrittenBytes: Bool) -> String {
        let common = "Birta Writer will download the update, check it, replace itself and reopen this note."
        return hasUnwrittenBytes
            ? common + " Your unsaved changes are written to disk first."
            : common
    }

    /// The offer's title.
    public static func title(appName: String, tag: String) -> String {
        "\(appName) \(tag) is available."
    }
}
