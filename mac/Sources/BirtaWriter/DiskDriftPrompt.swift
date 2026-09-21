import AppKit
import BirtaWriterCore

/// The Reload from Disk / Keep What Is Here sheet, shown when the bound file
/// changed outside the app and the buffer holds something the file does not.
///
/// A sheet on the panel for the reasons `UnsavedChangesPrompt` gives, and
/// built the same way so the two questions about somebody's bytes look and
/// behave alike. Nothing here writes or reads anything; it asks.
///
/// Two buttons and no Cancel, deliberately. Cancel would mean "leave it as it
/// is", and the app is already in that state: nothing has been written, and
/// the question is put again at the next write or the next summon. A sheet
/// dismissed by any other means therefore answers nothing, which is why the
/// callback is optional rather than defaulting to one of the two.
@MainActor
enum DiskDriftPrompt {
    /// Put the question on `window`. The callback runs exactly once, with nil
    /// for a sheet that ended without either button.
    static func present(document: String,
                        on window: NSWindow,
                        then answer: @escaping (DiskDrift.Answer?) -> Void) {
        let alert = NSAlert()
        alert.messageText = DiskDrift.title(document: document)
        alert.informativeText = DiskDrift.detail
        alert.alertStyle = .warning
        alert.addButton(withTitle: DiskDrift.reloadTitle)
        let keep = alert.addButton(withTitle: DiskDrift.keepTitle)
        // Escape must not write the buffer over the other tool's file, which
        // is what it would mean for somebody dismissing what they took for a
        // notification. AppKit hands a second button Escape in some alert
        // configurations (the three-button quit sheet is one) and, with two
        // buttons, in none: removing this line leaves every check here
        // passing, so it is a guard against that default rather than
        // something a test can hold.
        keep.keyEquivalent = ""

        alert.beginSheetModal(for: window) { response in
            switch response {
            case .alertFirstButtonReturn: answer(.reload)
            case .alertSecondButtonReturn: answer(.keep)
            default: answer(nil)
            }
        }
    }
}
