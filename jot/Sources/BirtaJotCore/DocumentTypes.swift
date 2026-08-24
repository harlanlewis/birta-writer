import Foundation
import UniformTypeIdentifiers

/// The file types Birta Writer for Mac deals with, and the one place either
/// answer is spelled.
///
/// There are TWO answers here and they are deliberately different lists. What
/// the editor OPENS is every format the webview parses, because the same
/// `dist/webview.js` runs in both surfaces and anything the extension opens
/// this app can open. What the app WRITES is one extension, because every file
/// this app creates is a note it named itself (`NoteNameTemplate`). Collapsing
/// them would be wrong in whichever direction it went: a save panel offering
/// three formats invites a name the note template cannot produce, and an Open
/// With list narrowed to the written one would refuse two formats the editor
/// renders perfectly.
///
/// `opened` is a copy. The list it copies is `shared/documentExtensions.ts`,
/// which is where a new format is added and which the extension's manifest and
/// this app's `Info.plist` also restate. Swift cannot import TypeScript and a
/// property list can import neither, so the copies exist and
/// `shared/__tests__/documentTypes.test.ts` is the only thing relating them.
/// The drift is silent in both directions: an extension here but not in the
/// plist never reaches this app from the Finder, and one in the plist but not
/// here is a file macOS hands over and `accepts` turns away.
public enum DocumentTypes {
    /// Extensions the editor opens, lowercased, without their leading dot.
    ///
    /// Mirrors `DOCUMENT_EXTENSIONS`.
    public static let opened = ["md", "markdown", "mdx"]

    /// The extension every file this app creates ends up with.
    ///
    /// One entry rather than a list, and it is `NoteNameTemplate`'s: a note is
    /// named from a template that always lands on this extension, so a panel
    /// offering another one would be offering a name nothing produces.
    public static let written = NoteNameTemplate.ext

    /// Whether `url` names a file the editor opens.
    ///
    /// Case-insensitive, because a file on disk can be `README.MD` and the
    /// Finder will hand it over as readily as the lowercase spelling.
    public static func accepts(_ url: URL) -> Bool {
        opened.contains(url.pathExtension.lowercased())
    }

    /// WHICH of several files a single-buffer app opens.
    ///
    /// Selecting five files in the Finder and choosing Open With hands over
    /// five, and this app has one buffer and one panel, so one of them is the
    /// only honest answer available. The first it can open rather than simply
    /// the first, because `open -a` passes anything: a folder of screenshots
    /// with one note in it should open the note rather than refuse on the
    /// first PNG.
    ///
    /// Falls back to the first URL when none is openable, so the caller still
    /// has something to name in the refusal. Nil only for an empty list.
    public static func firstToOpen(from urls: [URL]) -> URL? {
        urls.first(where: accepts) ?? urls.first
    }

    /// What an open or save panel that writes a note should allow.
    ///
    /// The fallback is `.plainText` rather than nothing, and it matters:
    /// `UTType(filenameExtension:)` is a lookup that can come back empty, and
    /// an empty `allowedContentTypes` means a panel that accepts any name at
    /// all rather than one that accepts none.
    public static var writtenContentTypes: [UTType] {
        [UTType(filenameExtension: written) ?? .plainText]
    }
}
