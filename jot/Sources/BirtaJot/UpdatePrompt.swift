import AppKit
import BirtaJotCore

/// The offer to take a new version, as a sheet on the panel.
///
/// A SHEET rather than the app-modal `NSAlert` this replaces, for three
/// reasons that all point the same way. It belongs to the window whose app is
/// about to be replaced, so it is attached to the thing it is about. It does
/// not run a nested run loop, which `runModal` does: every
/// `DispatchQueue.main.async` in the app stops being serviced for as long as
/// one of those is up, the sync scheduler's max-wait and the flush timeout
/// among them, and the old code needed a hop through the run loop to avoid
/// raising the alert from inside a completion at all. And it cannot appear
/// over another application's window, which an app-modal alert from a
/// menu-bar app can.
///
/// The buttons are DEAD for the first few seconds, which is the whole reason
/// this is a type rather than three lines at the call site. The offer arrives
/// on its own schedule and can land mid-sentence, and both buttons do
/// something the person typing did not ask for: one quits and replaces the
/// app, the other spends the single offer this version gets. A keystroke
/// already on its way to the editor must not be able to answer it.
///
/// A wait nobody explained is indistinguishable from a dialog that does not
/// work, so the offer says both halves: `UpdatePolicy.armingNote` is why, and
/// the count on the confirming button is how much longer.
///
/// Nothing here downloads anything. It asks, and hands the answer back.
@MainActor
enum UpdatePrompt {
    /// What the person said.
    enum Answer {
        /// Take it now: write, quit, swap, reopen.
        case install
        /// Not this version. The caller records the tag so it is not raised
        /// again until a newer one exists.
        case cancel
    }

    /// The built offer and the two gestures its wait is made of, so both are
    /// checkable without a window and without anything appearing on screen.
    ///
    /// The buttons are disarmed by `build`, not by the caller: an offer that
    /// arrives armed and is disarmed a moment later has a window in which a
    /// keystroke lands, and that window is exactly the one this is here to
    /// close.
    @MainActor final class Offer {
        let alert: NSAlert
        private let hasUnwrittenBytes: Bool
        private let confirm: NSButton
        /// Every button that is held, with the key equivalent it gets back.
        ///
        /// BOTH of them, and the key equivalents with them. Leaving Cancel
        /// live would still let a stray Escape spend the offer, and leaving
        /// Return bound to a disabled button is a key that does nothing rather
        /// than a key that is not yet a key.
        private let held: [(button: NSButton, key: String)]

        fileprivate init(alert: NSAlert, hasUnwrittenBytes: Bool,
                         confirm: NSButton, held: [NSButton]) {
            self.alert = alert
            self.hasUnwrittenBytes = hasUnwrittenBytes
            self.confirm = confirm
            self.held = held.map { ($0, $0.keyEquivalent) }
            for (button, _) in self.held {
                button.isEnabled = false
                button.keyEquivalent = ""
            }
        }

        /// Put `seconds` on the confirming button. Zero is the armed title.
        func count(_ seconds: Int) {
            confirm.title = UpdatePolicy.confirmTitle(
                hasUnwrittenBytes: hasUnwrittenBytes, secondsRemaining: seconds)
        }

        /// Give the buttons back, and take the count off the one that had it.
        func arm() {
            count(0)
            for (button, key) in held {
                button.isEnabled = true
                button.keyEquivalent = key
            }
        }

        /// Count down and then arm, on the main queue.
        ///
        /// On the main queue rather than a Timer, so it is bound to nothing
        /// that has to be invalidated: the sheet either outlives the delay or
        /// is gone, and writing a title to a button that is no longer on
        /// screen is a write to an object nobody is looking at rather than a
        /// crash.
        ///
        /// The blocks hold this STRONGLY, and that is what keeps the offer
        /// alive. `NSAlert` does not retain the thing that built it and
        /// `beginSheetModal` returns at once, so an offer held weakly is gone
        /// before its first tick, and what that leaves on screen is a sheet
        /// whose buttons never come live and an Escape that is also dead. The
        /// last block releases it, so the schedule owns the offer for exactly
        /// as long as there is something left to do to it.
        func armAfter(_ delay: TimeInterval) {
            let steps = UpdatePolicy.countdownSteps(for: delay)
            guard let first = steps.first else {
                arm()
                return
            }
            count(first)
            // Each tick lands one second after the one before it, and the last
            // of them arms. Scheduled against `delay` rather than against the
            // step count so a delay that is not a whole number still ends
            // exactly when it said it would.
            for seconds in steps.dropFirst() {
                let at = delay - TimeInterval(seconds)
                DispatchQueue.main.asyncAfter(deadline: .now() + at) {
                    MainActor.assumeIsolated { self.count(seconds) }
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                MainActor.assumeIsolated { self.arm() }
            }
        }
    }

    /// The offer itself, built rather than presented.
    static func build(tag: String, hasUnwrittenBytes: Bool) -> Offer {
        let alert = NSAlert()
        alert.messageText = UpdatePolicy.title(appName: AppFlavor.current.displayName, tag: tag)
        alert.informativeText = UpdatePolicy.detail(hasUnwrittenBytes: hasUnwrittenBytes)
            + "\n\n" + UpdatePolicy.armingNote
        alert.alertStyle = .informational
        let confirm = alert.addButton(
            withTitle: UpdatePolicy.confirmTitle(hasUnwrittenBytes: hasUnwrittenBytes))
        let cancel = alert.addButton(withTitle: "Cancel")
        return Offer(alert: alert, hasUnwrittenBytes: hasUnwrittenBytes,
                     confirm: confirm, held: [confirm, cancel])
    }

    /// Put the offer on `window` and call back once.
    ///
    /// `hasUnwrittenBytes` only changes what the sheet SAYS. Jot writes on the
    /// way out either way, because quitting flushes, so this is a sentence
    /// about what is going to happen rather than a difference in what happens.
    static func present(tag: String,
                        hasUnwrittenBytes: Bool,
                        on window: NSWindow,
                        armAfter delay: TimeInterval = UpdatePolicy.armingDelay,
                        then answer: @escaping (Answer) -> Void) {
        let offer = build(tag: tag, hasUnwrittenBytes: hasUnwrittenBytes)
        // The whole count goes on the button BEFORE the sheet is laid out, so
        // the widest title it will ever hold is the one it is sized for and
        // every later one fits the frame it was given.
        offer.count(UpdatePolicy.countdownSteps(for: delay).first ?? 0)
        offer.alert.beginSheetModal(for: window) { response in
            answer(response == .alertFirstButtonReturn ? .install : .cancel)
        }
        // And the clock starts with the sheet rather than before it. What the
        // wait protects is the moment the sheet can take a keystroke, so
        // starting it any earlier gives back part of what it is for.
        offer.armAfter(delay)
    }
}
