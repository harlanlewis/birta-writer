import AppKit
import BirtaWriterCore

/// The answer to a check somebody asked for, as a sheet on the window they
/// asked from.
///
/// The unasked offer is `UpdatePrompt`, and the two differ in exactly the way
/// their occasions do. That one arrives on its own schedule and can land
/// mid-sentence, so its buttons are dead for a moment and it offers one
/// answer besides no. This one answers a press: the person is at the keyboard
/// and reached for it, so its buttons are live on arrival, it speaks even
/// when there is nothing to report, and when there is something it offers
/// both ways of taking it, now or after the next quit.
///
/// The words are `UpdatePolicy.checkReport`'s, decided from values in Core
/// where they can be checked without a window. This draws them and hands the
/// choice back; nothing here downloads or installs anything.
@MainActor
enum UpdateCheckPrompt {
    /// What the person chose. Read off the button's title against the titles
    /// `UpdatePolicy` declares, so a report with one button and a report with
    /// three route through one table.
    enum Choice: Equatable {
        /// Write, quit, swap, reopen.
        case installNow
        /// Stage now and swap after the next quit, reopening nothing.
        case installOnQuit
        /// A swap already armed for the next quit, taken now instead.
        case restartNow
        /// Nothing. Not a decline: the automatic offer still asks in its
        /// own time, because Not Now on a check you asked for is about now.
        case dismiss
    }

    /// The sheet, built rather than presented, so a check can read it back.
    static func build(_ report: UpdatePolicy.CheckReport) -> NSAlert {
        let alert = NSAlert()
        alert.messageText = report.title
        alert.informativeText = report.detail
        alert.alertStyle = .informational
        let buttons = report.buttons.map { alert.addButton(withTitle: $0) }
        // Return takes the first button and Escape the last, whatever they
        // say. AppKit binds Escape to a button called Cancel and to nothing
        // else, and none of these is called that: Not Now and OK are the
        // dismissals here, and a sheet Escape cannot leave is a sheet that
        // has taken the keyboard from somebody who came to read a sentence.
        for button in buttons.dropFirst() { button.keyEquivalent = "" }
        if buttons.count > 1 { buttons.last?.keyEquivalent = "\u{1b}" }
        return alert
    }

    /// Which choice a button title stands for.
    static func choice(for title: String) -> Choice {
        switch title {
        case UpdatePolicy.installNowTitle: return .installNow
        case UpdatePolicy.installOnQuitTitle: return .installOnQuit
        case UpdatePolicy.restartNowTitle: return .restartNow
        default: return .dismiss
        }
    }

    /// Put the report on `window` and call back exactly once.
    static func present(_ report: UpdatePolicy.CheckReport, on window: NSWindow,
                        then answer: @escaping (Choice) -> Void) {
        let alert = build(report)
        alert.beginSheetModal(for: window) { response in
            answer(choice(for: report, response: response))
        }
    }

    /// The choice an `NSAlert` response stands for, by position in the
    /// report's own button list. Anything the list does not cover is a
    /// dismissal, which is what the sheet going away without a button is.
    static func choice(for report: UpdatePolicy.CheckReport,
                       response: NSApplication.ModalResponse) -> Choice {
        let index = response.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        guard report.buttons.indices.contains(index) else { return .dismiss }
        return choice(for: report.buttons[index])
    }
}
