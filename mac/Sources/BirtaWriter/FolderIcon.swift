import AppKit
import BirtaWriterCore

/// Draw the app's mark onto the notes folder, the way the Finder shows for
/// every other app that keeps a folder in iCloud Drive.
///
/// It is a small thing and it does real work: a folder called Birta Writer
/// sitting among a dozen identical blue folders is found by reading, and one
/// with the mark on it is found by looking. The apps beside it in iCloud Drive
/// all do this, so a plain folder is the odd one out rather than the neutral
/// choice.
///
/// `BirtaWriterCore.FolderIcon` holds the decision and the geometry, and its
/// header holds the mechanism. This is the half that needs a drawing context.
@MainActor
enum FolderMarker {
    /// Silent about failure, and that is a decision rather than an oversight.
    /// Every way this can fail is a way that costs the user nothing: a folder
    /// on a volume that will not take a custom icon, a sandbox that refuses the
    /// write, an iCloud folder that is not downloaded yet. A person who came to
    /// write a note is not helped by being told their folder is undecorated, so
    /// nothing is reported and the plain folder stands.
    /// Mark every notes folder this app derives.
    ///
    /// The call to make wherever a folder may have JUST come into existence,
    /// rather than only at launch. The mark is a file inside the folder, so
    /// deleting the folder deletes it, and the app recreates that folder
    /// itself the moment anything is written into it (`AtomicFile.write` makes
    /// every directory above its target). Without a second caller the folder
    /// comes back plain and stays plain until the next launch, which is the
    /// shape of every folder-icon bug: nothing is broken, the picture is
    /// simply not there and nothing says why.
    ///
    /// Cheap enough to call on a gesture: `FolderIcon.shouldMark` is two
    /// `stat` calls per folder and there are at most two folders, and the
    /// composition and the write only happen for a folder that is really
    /// unmarked.
    static func markNotesFolders() {
        let folders = Prefs.derivedNotesDirectories
        // The wiring, for `mac/scripts/measure.sh`, because the drawing is
        // deliberately unreachable from a checking run: `mark` refuses under a
        // throwaway defaults domain, since a folder icon is a file in the
        // user's real notes folder whatever domain the run is using. What a run
        // CAN ask is whether this was reached at the moment a folder may have
        // just been rebuilt, which is the half that had no caller.
        Measure.trace("markfolders count=\(folders.count) userStore=\(Prefs.isUserStore)")
        folders.forEach(mark)
    }

    /// Mark `folder`, unless it is already marked or is not there.
    static func mark(_ folder: URL) {
        // Never during a measurement run, on the same rule that stops one
        // remembering the panel's frame. `BIRTA_MAC_DEFAULTS_SUITE` isolates
        // everything this app STORES, and a folder icon is not stored: it is a
        // file written into a folder derived from the product name, which is
        // the person's real notes folder whatever defaults domain the run is
        // using. A checking run would decorate it for them.
        guard Prefs.isUserStore else { return }
        guard FolderIcon.shouldMark(folder), let composed = image() else { return }
        // The return value is read rather than discarded, and logged rather
        // than shown. Silent for the user, because a person who came to write a
        // note is not helped by being told their folder is undecorated; not
        // silent in the log, because `setFrameAutosaveName` in `AppPanel` is
        // the same shape of call in this app and throwing its answer away is
        // exactly how a window came to remember nothing with nothing to say so.
        if !NSWorkspace.shared.setIcon(composed, forFile: folder.path, options: []) {
            NSLog("Birta Writer: could not put the folder icon on \(folder.path)")
        }
    }

    /// The folder picture with the app's mark drawn into it.
    ///
    /// Built from the SYSTEM's folder icon rather than from a folder shape of
    /// our own, so it follows macOS: the folder has been redrawn more than once
    /// across releases, and a copy shipped here would be the previous version's
    /// folder sitting beside everybody else's current one.
    ///
    /// Cached for the length of a launch. It is asked for once per folder and
    /// there are at most two, but the composition allocates a bitmap the size
    /// of an icon and there is no reason to do it twice.
    private static var cached: NSImage?

    private static func image() -> NSImage? {
        if let cached { return cached }
        guard let mark = appIcon() else { return nil }
        let folder = NSWorkspace.shared.icon(for: .folder)
        // The largest representation the system offers, so the result is sharp
        // at every size the Finder asks for rather than at the one that
        // happened to be current.
        let size = NSSize(width: 512, height: 512)
        let composed = NSImage(size: size)
        composed.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .high
        folder.draw(in: NSRect(origin: .zero, size: size))
        mark.draw(in: FolderIcon.markRect(in: size))
        composed.unlockFocus()
        cached = composed
        return composed
    }

    /// The app's own icon.
    ///
    /// `NSApp.applicationIconImage` rather than reading `AppIcon.icns` off the
    /// bundle: it is what the app is actually wearing, so the DEVELOPMENT
    /// flavour marks its folder with the icon it shows in the Dock, and a
    /// `swift run` with no bundle at all gets nil here and leaves the folder
    /// plain rather than drawing something wrong.
    private static func appIcon() -> NSImage? {
        guard let icon = NSApp.applicationIconImage, icon.size.width > 0 else { return nil }
        return icon
    }
}
