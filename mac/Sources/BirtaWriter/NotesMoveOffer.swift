import AppKit
import BirtaWriterCore

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
/// Changing where the app keeps notes rebinds the editor and moves nothing. The
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
/// The location can also change with nobody changing anything, which is what
/// `offerAtLaunch` is for: the folder is derived from the product name, so a
/// rename moves it. That one asks the same question at launch, and the two
/// entries differ only in what they can lean on, a settings window and a
/// buffer that has to be flushed first against neither.
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
        // Every gesture that can change where the notes folder is derived ends
        // here, so this is where the record a launch compares against is
        // brought up to date. Without it, a location the user changed by hand
        // and has already answered for would be raised again at the next
        // launch as a folder that moved out from under them.
        Prefs.recordNotesDerivation()
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

    /// The same offer, for the trigger no gesture can reach: the DERIVED notes
    /// folder moved because the product name it is spelled from changed.
    ///
    /// Run at LAUNCH, before anything is bound to a file, and app-modal rather
    /// than as a sheet. Both follow from the same constraint. There is no
    /// window yet to hang a sheet on, and there must not be: the binding is
    /// the new folder's scratchpad, so a note carried into that folder while
    /// the panel is open can land on the very path the panel is editing.
    /// Asking and finishing before the Coordinator exists is what keeps a
    /// note from being opened as it arrives, and it is why the nested run loop
    /// `runModal` starts costs nothing here: at that point in the launch there
    /// is nothing on the main queue for it to hold up.
    ///
    /// The seams are for the arms rather than for the sheet: asking is a
    /// modal alert and moving is a file copy, so a test that could not answer
    /// the first would never reach the second.
    static func offerAtLaunch(
        stranded: URL? = Prefs.strandedNotesDirectory,
        destination: URL = Prefs.derivedNotesDirectory,
        formerScratchpadName: String? = Prefs.strandedScratchpadName,
        derivedScratchpadName: String = Prefs.defaultScratchpadURL.lastPathComponent,
        ask: (_ from: URL, _ to: URL, _ plan: NotesMove.Plan) -> Bool = askModally,
        tell: ([String]) -> Void = tellModally,
        // BOTH halves of the record, which is why this is the same call the
        // settings path makes rather than a folder assignment of its own. A
        // launch that recorded only the folder would leave the file record
        // pointing into the folder just emptied, and the NEXT rename could no
        // longer tell which of the carried notes was the scratchpad: correct
        // once, then wrong for anyone renamed twice.
        //
        // The argument is what a test observes; production has no use for it,
        // since `destination` is `derivedNotesDirectory` and this records that
        // same derivation from its own source.
        record: (URL) -> Void = { _ in Prefs.recordNotesDerivation() }
    ) {
        // On every arm, the ones that ask nothing included. What is recorded
        // is where the notes are derived NOW, and a launch that left it
        // unwritten would put the same question again next time.
        defer { record(destination) }
        guard let stranded else { return }
        // A rename renames the note as well as the folder, so the scratchpad
        // is carried across under the name the app derives now. Without this
        // the writing lands beside the empty note this launch made and the
        // panel opens the empty one, which is the whole rescue failing on its
        // last step.
        let rename = formerScratchpadName.map { (from: $0, to: derivedScratchpadName) }
        let plan = buildPlan(from: stranded, to: destination, scratchpadRename: rename)
        // Nothing of ours is in there. The folder itself is left alone: it is
        // the user's to see and to delete, and an empty one is clutter rather
        // than loss.
        guard !plan.isEmpty else { return }
        guard ask(stranded, destination, plan) else { return }
        // On this thread, unlike the settings path, because nothing is waiting
        // on it: the alert was answered a moment ago and no file is open yet.
        let lines = stayedLines(NotesMove.perform(plan))
        if !lines.isEmpty { tell(lines) }
    }

    /// What the launch asks, built apart from the asking so the sentence can
    /// be read without a run loop.
    static func launchAlert(from oldDirectory: URL,
                            to newDirectory: URL,
                            plan: NotesMove.Plan) -> NSAlert {
        let count = plan.noteCount
        let alert = NSAlert()
        alert.messageText = "Your notes are in a folder Birta Writer no longer uses"
        alert.informativeText = """
            Birta Writer now keeps notes in \(display(newDirectory)). \
            \(count == 1 ? "One note is" : "\(count) notes are") still in \
            \(display(oldDirectory)), with any images they use.
            """
        alert.addButton(withTitle: count == 1 ? "Move Note" : "Move \(count) Notes")
        alert.addButton(withTitle: "Leave Them")
        return alert
    }

    private static func askModally(from oldDirectory: URL,
                                   to newDirectory: URL,
                                   plan: NotesMove.Plan) -> Bool {
        // A menu-bar app has nothing on screen of its own to raise, so the
        // alert has to be asked for; without this it can come up behind
        // whatever the person was already looking at.
        NSApp.activate(ignoringOtherApps: true)
        return launchAlert(from: oldDirectory, to: newDirectory, plan: plan).runModal()
            == .alertFirstButtonReturn
    }

    private static func tellModally(_ lines: [String]) {
        let alert = NSAlert()
        alert.messageText = stayedTitle
        alert.informativeText = lines.joined(separator: "\n\n")
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    /// Everything `NotesMove.plan` needs, read off the disk here so the
    /// planning itself stays testable without one.
    private static func buildPlan(from oldDirectory: URL,
                                  to newDirectory: URL,
                                  scratchpadRename: (from: String, to: String)? = nil) -> NotesMove.Plan {
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
            },
            scratchpadRename: scratchpadRename)
    }

    /// Only speaks when something did NOT come along. A move that worked has
    /// already been reported by the notes being there.
    private static func reportIfAnythingStayed(_ report: NotesMove.Report, in window: NSWindow) {
        let lines = stayedLines(report)
        guard !lines.isEmpty else { return }

        let alert = NSAlert()
        alert.messageText = stayedTitle
        alert.informativeText = lines.joined(separator: "\n\n")
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window, completionHandler: nil)
    }

    static let stayedTitle = "Some things stayed where they were"

    /// What did not come along, as sentences. Apart from the presenting,
    /// because the two surfaces raise it differently and must say the same
    /// thing.
    static func stayedLines(_ report: NotesMove.Report) -> [String] {
        var lines: [String] = []
        // Notes and images are counted apart, because a failure takes whatever
        // was in the way of it and the two are not the same news. Calling an
        // image a note sends the reader looking for writing that is not
        // missing, and the images are the half they can do nothing about.
        let failedImages = report.failed.filter {
            $0.deletingLastPathComponent().lastPathComponent == AttachmentStore.directoryName
        }
        let failedNotes = report.failed.count - failedImages.count
        if failedNotes > 0 {
            lines.append(failedNotes == 1
                ? "One note could not be copied and is still where it was."
                : "\(failedNotes) notes could not be copied and are still where they were.")
        }
        if !failedImages.isEmpty {
            lines.append(failedImages.count == 1
                ? "One image could not be copied and is still where it was."
                : "\(failedImages.count) images could not be copied and are still where they were.")
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
        return lines
    }

    /// A path as the user would say it, with the home directory as a tilde.
    private static func display(_ url: URL) -> String {
        (url.path as NSString).abbreviatingWithTildeInPath
    }
}
