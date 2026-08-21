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
        hasUnwrittenBytes ? "Save and Restart Jot" : "Restart Jot"
    }

    /// The sentence under the offer.
    public static func detail(hasUnwrittenBytes: Bool) -> String {
        let common = "Jot will download the update, check it, replace itself and reopen this note."
        return hasUnwrittenBytes
            ? common + " Your unsaved changes are written to disk first."
            : common
    }

    /// The offer's title.
    public static func title(appName: String, tag: String) -> String {
        "\(appName) \(tag) is available."
    }
}
