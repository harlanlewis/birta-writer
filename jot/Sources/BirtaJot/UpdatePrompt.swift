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
        let alert = NSAlert()
        alert.messageText = UpdatePolicy.title(appName: AppFlavor.current.displayName, tag: tag)
        alert.informativeText = UpdatePolicy.detail(hasUnwrittenBytes: hasUnwrittenBytes)
        alert.alertStyle = .informational
        let confirm = alert.addButton(withTitle: UpdatePolicy.confirmTitle(hasUnwrittenBytes: hasUnwrittenBytes))
        let cancel = alert.addButton(withTitle: "Cancel")

        // BOTH of them, and the key equivalents with them. Leaving Cancel live
        // would still let a stray Escape spend the offer, and leaving Return
        // bound to a disabled button is a key that does nothing rather than a
        // key that is not yet a key.
        let armed = [confirm, cancel]
        let keys = armed.map(\.keyEquivalent)
        for button in armed {
            button.isEnabled = false
            button.keyEquivalent = ""
        }

        alert.beginSheetModal(for: window) { response in
            answer(response == .alertFirstButtonReturn ? .install : .cancel)
        }

        // On the main queue rather than a Timer, so it is bound to nothing
        // that has to be invalidated: the sheet either outlives the delay or
        // is gone, and arming a button that is no longer on screen is a write
        // to an object nobody is looking at rather than a crash.
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            for (button, key) in zip(armed, keys) {
                button.isEnabled = true
                button.keyEquivalent = key
            }
        }
    }
}
