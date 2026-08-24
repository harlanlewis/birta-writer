import Foundation

/// What moving Jot's notes from one folder to another would DO, decided
/// without touching a disk.
///
/// The plan is a separate type from the doing for two reasons. It is the half
/// that can be tested, and it is the half the offer has to show: the button
/// says how many notes it is about to move, so the count on screen and the
/// work performed come from one place and cannot disagree.
///
/// `Prefs.notesDirectory` is the scratchpad's PARENT, so this is a folder Jot
/// does not exclusively own. Three rules follow, and the second is the one
/// that is easy to get wrong:
///
///   - Every `.md` at the top level travels, and nothing else does. A file Jot
///     did not put there is left where its owner put it, and named in
///     `leftBehind` so the caller can say so rather than going quiet.
///
///   - Attachments MERGE, they never number. Notes reference their images
///     relatively, as `Attachments/<name>.png` (see `AttachmentStore`, whose
///     whole shape is built to keep a note portable). Moving the folder to
///     `Attachments 2` because the destination already had one would break
///     every image reference in every note that just moved, in files that
///     still open perfectly. So the folder's FILES are planned individually
///     into the destination's `Attachments`, and a name already taken there is
///     skipped rather than renamed: `AttachmentStore` names a file after a
///     hash of its bytes, so a name that collides is the same image, and
///     skipping it is the dedup that store already does on every paste.
///
///   - A note whose name is taken at the destination is NUMBERED, because a
///     note by the same name is a different note and overwriting one would be
///     the loss this whole feature exists to prevent. The numbering is
///     `Coordinator.unusedURL`'s, restated here against an injected predicate
///     so a plan can be made and asserted with no filesystem at all.
public struct NoteMove: Equatable, Sendable {
    /// One file to copy, with the name it will have when it lands.
    public struct Item: Equatable, Sendable {
        public let source: URL
        public let destination: URL
        /// True for a file under `Attachments/`, which lands under the
        /// destination's `Attachments/` and is skipped on a name collision.
        public let isAttachment: Bool

        public init(source: URL, destination: URL, isAttachment: Bool) {
            self.source = source
            self.destination = destination
            self.isAttachment = isAttachment
        }
    }

    /// Everything that travels, notes first, then attachments.
    public let items: [Item]

    /// Files in the source folder that are NOT Jot's and stay where they are.
    /// The caller names these rather than moving them; a folder Jot shares is
    /// not a folder Jot may empty.
    public let leftBehind: [URL]

    /// Attachments already present at the destination under the same name.
    /// Same name means same bytes, so these are not moved and not lost; they
    /// are reported so a caller can account for every file it was shown.
    public let duplicateAttachments: [URL]

    /// The count the button says, which is notes and not attachments: the
    /// person is moving their writing, and the images are what has to travel
    /// with it rather than a second thing to decide about.
    public var noteCount: Int { items.filter { !$0.isAttachment }.count }

    /// Nothing to offer. A move with no notes in it is not worth a dialog.
    public var isEmpty: Bool { noteCount == 0 }

    /// Decide the move.
    ///
    /// - Parameters:
    ///   - source: the folder notes are leaving.
    ///   - destination: the folder they are going to.
    ///   - entries: the top-level contents of `source`.
    ///   - attachments: the contents of `source`'s `Attachments` folder.
    ///   - exists: whether a path is already taken at the destination.
    ///     Injected so the whole decision is testable without a disk, and so
    ///     the numbering below cannot silently stop numbering.
    public static func plan(
        source: URL,
        destination: URL,
        entries: [URL],
        attachments: [URL],
        exists: (URL) -> Bool
    ) -> NoteMove {
        var items: [Item] = []
        var leftBehind: [URL] = []
        var duplicates: [URL] = []

        // Names claimed by this plan, so two notes that would land on the same
        // name do not both get it. `exists` cannot see a file this plan is
        // about to create.
        var claimed: Set<String> = []
        let taken: (URL) -> Bool = { url in claimed.contains(url.path) || exists(url) }

        for entry in entries.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            guard entry.pathExtension.lowercased() == DocumentTypes.written else {
                leftBehind.append(entry)
                continue
            }
            let landing = unused(in: destination,
                                 stem: entry.deletingPathExtension().lastPathComponent,
                                 extension: entry.pathExtension,
                                 taken: taken)
            claimed.insert(landing.path)
            items.append(Item(source: entry, destination: landing, isAttachment: false))
        }

        let attachmentsHome = destination.appendingPathComponent(AttachmentStore.directoryName)
        for file in attachments.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let landing = attachmentsHome.appendingPathComponent(file.lastPathComponent)
            // A name already there is the same bytes, by construction: the
            // store names a file after a hash of its content.
            if exists(landing) {
                duplicates.append(file)
                continue
            }
            items.append(Item(source: file, destination: landing, isAttachment: true))
        }

        return NoteMove(items: items, leftBehind: leftBehind, duplicateAttachments: duplicates)
    }

    /// `stem.ext` in `directory`, numbered until nothing is there. The same
    /// rule `Coordinator.unusedURL` applies to a new note, against an injected
    /// predicate rather than `FileManager`.
    private static func unused(in directory: URL, stem: String, extension ext: String,
                               taken: (URL) -> Bool) -> URL {
        var candidate = directory.appendingPathComponent("\(stem).\(ext)")
        var n = 2
        while taken(candidate) {
            candidate = directory.appendingPathComponent("\(stem) \(n).\(ext)")
            n += 1
        }
        return candidate
    }
}
