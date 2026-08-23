import AppKit
import BirtaJotCore

/// Work that must land BETWEEN the buffer's flush and the page's reload, given
/// the completion that lets the reload proceed.
///
/// The ordering is the whole reason this exists. `Coordinator.writeLatest`
/// writes to `boundURL`, which still names the OLD file while a preference
/// change is being processed, so a notes move performed BEFORE the flush is
/// promptly undone by it: the note the user was editing reappears at the
/// location it was just moved out of. Flush first and the move carries a file
/// that is already current.
typealias BeforeReload = (@escaping () -> Void) -> Void

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

    /// Ask, if there is anything to ask about, then apply the answer.
    ///
    /// `apply` is the preference reload the caller was going to do anyway, and
    /// it takes the move as `BeforeReload` work rather than having it done
    /// here. That is not plumbing for its own sake: the move MUST happen after
    /// the buffer has been flushed to the file it belongs to, or the flush
    /// writes the note being edited straight back to the folder it was moved
    /// out of. See `BeforeReload`.
    static func offer(movingFrom oldDirectory: URL,
                      to newDirectory: URL,
                      in window: NSWindow?,
                      apply: @escaping (BeforeReload?) -> Void) {
        let plan = buildPlan(from: oldDirectory, to: newDirectory)
        guard !plan.isEmpty, let window else {
            apply(nil)
            return
        }

        let count = plan.noteCount
        let alert = NSAlert()
        alert.messageText = "Move your notes to the new location?"
        alert.informativeText = """
            \(count == 1 ? "One note is" : "\(count) notes are") in \(display(oldDirectory)), \
            with any images they use. Birta Writer writes to the new location either way.
            """
        alert.addButton(withTitle: count == 1 ? "Move Note" : "Move \(count) Notes")
        alert.addButton(withTitle: "Leave Them")
        alert.beginSheetModal(for: window) { response in
            // Leave Them is a real answer and needs no follow-up: the sheet
            // named the folder the notes are in, which is the whole thing the
            // silent version failed to say.
            guard response == .alertFirstButtonReturn else {
                apply(nil)
                return
            }
            apply { continueReload in
                // Off the main thread: this is a file copy, and into iCloud
                // Drive it is an upload with a delay behind it. The reload
                // waits for it rather than racing it, which is what the
                // completion is for.
                DispatchQueue.global(qos: .userInitiated).async {
                    let report = NotesMove.perform(plan)
                    DispatchQueue.main.async {
                        continueReload()
                        reportIfAnythingStayed(report, in: window)
                    }
                }
            }
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
            // Size first: this is only asked when a name collides, and the
            // colliding file can be a video. Two whole reads to answer a
            // question a pair of sizes settles is worth avoiding.
            identical: { source, target in
                guard NotesMove.sizesMatch(source, target, fileManager) else { return false }
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
