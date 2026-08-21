import AppKit
import BirtaJotCore

/// The offer to bring your notes along when the notes location changes.
///
/// Changing where Jot keeps notes rebinds the editor and moves nothing. The
/// old notes stay on disk, untouched and safe, and they leave the panel
/// without a word. Nothing is lost and it reads exactly like loss, which is
/// the worst pairing available: the user cannot tell those two apart from what
/// is on screen.
///
/// So the gesture asks, once, and only when there is really something to
/// carry. Both surfaces that can change the location call this, because an
/// offer on one of them and silence on the other would be a worse story than
/// silence on both.
///
/// `NotesMove` owns every decision; this owns the sentence and the sheet.
enum NotesMoveOffer {

    /// Ask, if there is anything to ask about, then call `then` either way.
    ///
    /// `then` is what the caller was going to do anyway (reload the panel onto
    /// the new location), and it runs after the answer rather than before it:
    /// the buffer is flushed to the file it belongs to by that reload, and
    /// moving a file out from under a pending write is the one ordering that
    /// could lose bytes.
    static func offer(movingFrom oldDirectory: URL,
                      to newDirectory: URL,
                      in window: NSWindow?,
                      then: @escaping () -> Void) {
        let plan = buildPlan(from: oldDirectory, to: newDirectory)
        guard !plan.isEmpty, let window else {
            then()
            return
        }

        let count = plan.noteCount
        let alert = NSAlert()
        alert.messageText = "Move your notes to the new location?"
        alert.informativeText = """
            \(count == 1 ? "One note is" : "\(count) notes are") in \(display(oldDirectory)), \
            with any images they use. Jot writes to the new location either way.
            """
        alert.addButton(withTitle: count == 1 ? "Move Note" : "Move \(count) Notes")
        alert.addButton(withTitle: "Leave Them")
        alert.beginSheetModal(for: window) { response in
            // Leave Them is a real answer and needs no follow-up: the sheet
            // named the folder the notes are in, which is the whole thing the
            // silent version failed to say.
            guard response == .alertFirstButtonReturn else {
                then()
                return
            }
            let report = NotesMove.perform(plan)
            then()
            reportIfAnythingStayed(report, in: window)
        }
    }

    /// Everything `NotesMove.plan` needs, read off the disk here so the
    /// planning itself stays testable without one.
    private static func buildPlan(from oldDirectory: URL, to newDirectory: URL) -> NotesMove.Plan {
        let fileManager = FileManager.default
        let entries = (try? fileManager.contentsOfDirectory(
            at: oldDirectory, includingPropertiesForKeys: nil)) ?? []
        let attachmentDirectory = oldDirectory.appendingPathComponent(
            AttachmentStore.directoryName, isDirectory: true)
        let attachments = (try? fileManager.contentsOfDirectory(
            at: attachmentDirectory, includingPropertiesForKeys: nil)) ?? []

        return NotesMove.plan(
            from: oldDirectory, to: newDirectory,
            entries: entries, attachments: attachments,
            occupied: { fileManager.fileExists(atPath: $0.path) },
            identical: { source, target in
                guard let a = try? Data(contentsOf: source),
                      let b = try? Data(contentsOf: target) else { return false }
                return a == b
            })
    }

    /// Only speaks when something did NOT come along. A move that worked has
    /// already been reported by the notes being there.
    private static func reportIfAnythingStayed(_ report: NotesMove.Report, in window: NSWindow) {
        var lines: [String] = []
        if !report.failed.isEmpty {
            lines.append(report.failed.count == 1
                ? "One note could not be copied and is still where it was."
                : "\(report.failed.count) notes could not be copied and are still where they were.")
        }
        let blockedAttachments = report.kept.filter {
            if case .attachmentNameTaken = $0 { return true }
            return false
        }
        if !blockedAttachments.isEmpty {
            // Renaming these would break the notes that point at them, so they
            // stay and the user is told rather than quietly given broken links.
            lines.append(blockedAttachments.count == 1
                ? "One image was left behind: a different file of that name is already there."
                : "\(blockedAttachments.count) images were left behind: different files of those names are already there.")
        }
        guard !lines.isEmpty else { return }

        let alert = NSAlert()
        alert.messageText = "Some things stayed where they were"
        alert.informativeText = lines.joined(separator: "\n\n")
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window, completionHandler: nil)
    }

    /// A path as the user would say it, with the home directory as a tilde.
    private static func display(_ url: URL) -> String {
        (url.path as NSString).abbreviatingWithTildeInPath
    }
}
