import Foundation

/// What a macOS window title SAYS, with no window involved.
///
/// The drawing lives in `BirtaJot.TitleBarView`, which turns these runs into
/// an attributed string and hangs the gestures off it. Everything decidable
/// without a screen is here, because that is the line this package's two
/// targets are drawn along, and because the parts worth getting exactly right
/// are all on this side: whether the suffix appears, what separates it, and
/// where the popup's list of folders stops.
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

    /// `url` and every directory above it, nearest first, ending at the volume.
    ///
    /// This is the list the Cmd-click popup shows, in the order it shows them.
    /// The walk stops where a path is its own parent, which is what `/` is, so
    /// a relative path or a root reaches an end rather than spinning.
    public static func ancestry(of url: URL) -> [URL] {
        var chain: [URL] = []
        var current = url.standardizedFileURL
        while true {
            chain.append(current)
            let parent = current.deletingLastPathComponent().standardizedFileURL
            if parent.path == current.path { return chain }
            current = parent
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
