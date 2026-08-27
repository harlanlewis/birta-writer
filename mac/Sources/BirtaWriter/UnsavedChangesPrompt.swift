import AppKit
import BirtaWriterCore

/// The Save / Discard Changes / Cancel sheet, shown on the way out when
/// autosave is off and the buffer is ahead of the file.
///
/// A SHEET on the panel rather than an app-modal alert, for the reasons
/// `UpdatePrompt` gives: it belongs to the window whose document is at stake,
/// it cannot appear over another application's window, and it does not spin a
/// nested run loop, which matters more here than anywhere else in the app.
/// This is raised from inside `applicationShouldTerminate`'s deferred reply,
/// and that reply arrives on the main queue; a `runModal` there would stop the
/// queue that has to deliver it.
///
/// Nothing here writes anything. It asks, and hands the answer back.
@MainActor
enum UnsavedChangesPrompt {
    /// Put the question on `window` and call back exactly once.
    static func present(document: String,
                        on window: NSWindow,
                        then answer: @escaping (UnsavedChanges.Answer) -> Void) {
        let alert = NSAlert()
        alert.messageText = UnsavedChanges.title(document: document)
        alert.informativeText = UnsavedChanges.detail
        alert.alertStyle = .warning
        alert.addButton(withTitle: UnsavedChanges.saveTitle)
        let discard = alert.addButton(withTitle: UnsavedChanges.discardTitle)
        let cancel = alert.addButton(withTitle: UnsavedChanges.cancelTitle)
        // Escape cancels and nothing else does. AppKit gives the second button
        // Escape by default, which would put Discard Changes one keystroke
        // from a person dismissing what they took for a notification.
        discard.keyEquivalent = ""
        cancel.keyEquivalent = "\u{1b}"

        alert.beginSheetModal(for: window) { response in
            switch response {
            case .alertFirstButtonReturn: answer(.save)
            case .alertSecondButtonReturn: answer(.discard)
            default: answer(.cancel)
            }
        }
    }
}
