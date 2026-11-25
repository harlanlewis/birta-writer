import Foundation

/// What a macOS window title SAYS, with no window involved.
///
/// The drawing lives in `BirtaWriter.TitleBarView`, which turns these runs into
/// an attributed string and hangs the gestures off it. Everything decidable
/// without a screen is here, because that is the line this package's two
/// targets are drawn along, and because the parts worth getting exactly right
/// are all on this side: whether the suffix appears, what separates it, and
/// where the popup's list of folders stops (`pathRows`).
public enum WindowTitle {
    /// One stretch of the title, and whether it is the quiet half. macOS draws
    /// the document's name in the title ink and everything after it in a
    /// secondary one, so the split is what the caller needs and the colours
    /// are the caller's to choose.
    public struct Run: Equatable, Sendable {
        public let text: String
        public let secondary: Bool

        public init(text: String, secondary: Bool) {
            self.text = text
            self.secondary = secondary
        }
    }

    /// The separator macOS puts between a document's name and its state. An em
    /// dash with a space each side, which is the platform's spelling and not a
    /// choice this app gets to make.
    public static let separator = " — "

    /// The word for a document with bytes its file does not have.
    public static let editedSuffix = "Edited"

    /// The title of a document called `name`, marked `edited` or not.
    ///
    /// The suffix is one run including its separator, so a caller cannot draw
    /// the dash in the loud ink and the word in the quiet one, which is the
    /// way this gets built wrong.
    public static func runs(name: String, edited: Bool) -> [Run] {
        var runs = [Run(text: name, secondary: false)]
        if edited {
            runs.append(Run(text: separator + editedSuffix, secondary: true))
        }
        return runs
    }

    /// The character that stands for the part of a name that did not fit. One
    /// glyph, not three periods: a real ellipsis is what the platform draws and
    /// what a reader recognises as damage rather than as punctuation.
    public static let ellipsis = "\u{2026}"

    /// The same title, with the NAME shortened until the whole line fits.
    ///
    /// The name is what gives way, and the suffix never does. A cell asked to
    /// truncate a whole line eats its tail first, so `Edited` would go before
    /// any of the name did, and `Edited` is the half a reader is scanning for.
    /// macOS shortens the name and keeps the state; this is that rule, and the
    /// reason the two are separate `Run`s in the first place.
    ///
    /// `measure` is injected so this is decidable with no window: the drawing
    /// side passes a text measurer in its own title font, and a test passes
    /// arithmetic. It is asked about whole candidate strings rather than about
    /// characters, because a font kerns and the width of a prefix is not the
    /// sum of its glyphs.
    ///
    /// Returns the untouched runs when they already fit, and a name of nothing
    /// but the ellipsis when even one character will not go, which is still
    /// preferable to a suffix with no subject.
    public static func runs(name: String, edited: Bool,
                            fitting ceiling: Double,
                            measure: (String) -> Double) -> [Run] {
        let full = runs(name: name, edited: edited)
        let line = full.map(\.text).joined()
        if measure(line) <= ceiling { return full }

        let suffix = edited ? separator + editedSuffix : ""
        let characters = Array(name)
        // The largest prefix length that fits, by bisection over LENGTHS. The
        // predicate is monotonic in length for any sane font, and asking the
        // measurer O(log n) times rather than O(n) matters because this runs on
        // every repaint of a window being dragged narrower.
        var low = 0
        var high = characters.count
        while low < high {
            let mid = (low + high + 1) / 2
            let candidate = String(characters[0..<mid]) + ellipsis + suffix
            if measure(candidate) <= ceiling { low = mid } else { high = mid - 1 }
        }
        var shortened = [Run(text: String(characters[0..<low]) + ellipsis, secondary: false)]
        if edited { shortened.append(Run(text: suffix, secondary: true)) }
        return shortened
    }

    /// Whether a title should carry the suffix at all, given the buffer's
    /// state and the autosave setting.
    ///
    /// Autosave OFF, unwritten bytes: yes, and it is the only case. There the
    /// word is a fact the reader can act on, and the action is Cmd+S.
    ///
    /// Autosave ON: never. macOS says the same thing about its own documents
    /// and for the same reason: a file that is always being written has no
    /// unwritten state worth a word. The app's flag does still go up and down as
    /// you type, between the keystroke that raises it and the write that
    /// clears it, so drawing it would put a word in the titlebar that appears
    /// and vanishes several times a sentence and names nothing anybody can
    /// do. Not a repaint to make cheaper: a claim not worth making.
    ///
    /// Read at PAINT time, never captured. The setting can be changed while
    /// the app is running, and turning it off with the buffer already dirty
    /// has to show the suffix immediately rather than at the next keystroke.
    public static func showsEdited(hasUnwrittenBytes: Bool, autosaveEnabled: Bool) -> Bool {
        hasUnwrittenBytes && !autosaveEnabled
    }

    /// The rows of the title's path popup and of the title popover's Where
    /// menu: `url`, then each folder above it, nearest first, as far as the
    /// path bar goes (`PathBar.segments`) and named as it names them.
    ///
    /// Not every directory up to the volume, which is what a bare walk gives
    /// and what the platform's own popup lists. Under iCloud that walk spends
    /// five rows on `Mobile Documents`, `Library`, the home folder, `Users`
    /// and the volume, none of which the Finder shows as a place a note is,
    /// and it lists an app's container twice, since the container and the
    /// `Documents` folder inside it both display under the app's name. So
    /// the popup stops where the path bar starts, and the two can never
    /// disagree about where a note is.
    ///
    /// A directory `url` (the Where menu's) is named by `displayName`, as the
    /// folders above it are; a file keeps its name as written.
    public static func pathRows(of url: URL, home: URL,
                                displayName: (String) -> String) -> [(name: String, url: URL)] {
        let directory = url.hasDirectoryPath
        return PathBar.segments(for: url, home: home, displayName: displayName).reversed().map { segment in
            let name = segment.kind == .file && directory ? displayName(segment.path) : segment.name
            return (name, URL(fileURLWithPath: segment.path, isDirectory: segment.kind != .file || directory))
        }
    }

    /// The name Finder shows, which is not always the last path component: a
    /// localized folder and a mounted volume both rename themselves for
    /// display. Falls back to the component when the file manager has nothing,
    /// so a row is never blank.
    public static func displayName(of url: URL, using manager: FileManager = .default) -> String {
        let shown = manager.displayName(atPath: url.path)
        return shown.isEmpty ? url.lastPathComponent : shown
    }
}
