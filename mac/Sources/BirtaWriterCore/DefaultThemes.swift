import Foundation

/// The colour themes Birta Writer for Mac ships with, as one declared list.
///
/// They are ordinary themes in the ordinary library: a launch copies each one
/// into `ThemeStore`'s folder once, and from that moment the store cannot tell
/// them from a theme somebody added, which is the point. A default is picked,
/// ringed and REMOVED the way any other is, and Settings offers to put back
/// the ones that are gone (`ThemeStore.installDefaults`).
///
/// The files are deliberate copies, the way `mac/Resources` copies the brand
/// marks: packaging must not depend on another checkout being present.
/// `mac/README.md` records where they came from and what a refresh is.
///
/// The word on screen is BUILT-IN rather than default: "default" in a
/// settings window reads as the thing a reset goes back to, and restoring
/// these is not a reset. The type keeps the name the code has always used for
/// what ships with a build.
///
/// This list is what both halves read. The build script copies the folder, and
/// `DefaultThemesTests` fails when a file in it is not declared here or a
/// declaration names a file that is not there, so the bundle and the list
/// cannot drift apart in either direction.
public enum DefaultThemes {
    /// One shipped theme: the name the app shows, the kind its file declares,
    /// and the file inside the bundled folder.
    public struct Bundled: Equatable, Sendable, Identifiable {
        public let name: String
        public let kind: VSCodeTheme.Kind
        public let fileName: String

        public init(name: String, kind: VSCodeTheme.Kind, fileName: String) {
            self.name = name
            self.kind = kind
            self.fileName = fileName
        }

        /// The id the store holds it under.
        ///
        /// Not the name's slug, and that is the whole of why the prefix is
        /// here. A theme somebody imports is stored under `ThemeStore.slug`
        /// of its name, so a default whose id were its slug would be the SAME
        /// file as an import carrying the same name, and adding that import
        /// would silently overwrite the shipped one. `slug` emits letters,
        /// digits and dashes and nothing else, so an underscore is a
        /// character no import can ever produce: the two namespaces cannot
        /// meet, whatever anybody names a theme.
        public var id: String { DefaultThemes.idPrefix + ThemeStore.slug(name) }
    }

    /// What marks an id as a shipped theme's. The underscore is load-bearing;
    /// see `Bundled.id`.
    public static let idPrefix = "default_"

    /// The folder inside the app bundle's Resources that holds the files, and
    /// the folder under `mac/Resources` they are committed in.
    public static let folderName = "DefaultThemes"

    /// The four, in the order the library is seeded and the pane lists them
    /// before it sorts by name.
    ///
    /// Terminal Green and Terminal Amber drop the parentheses their source
    /// files carry. A parenthesised variant reads as an aside under a theme
    /// card's two-line name, and the id would drop the brackets anyway, so
    /// the drawn name and the stored one agree letter for letter without
    /// them.
    public static let all: [Bundled] = [
        Bundled(name: "Birta Terracotta Light", kind: .light,
                fileName: "birta-terracotta-light-color-theme.json"),
        Bundled(name: "Birta Terracotta Dark", kind: .dark,
                fileName: "birta-terracotta-dark-color-theme.json"),
        Bundled(name: "Birta Terminal Green", kind: .dark,
                fileName: "birta-terminal-green-color-theme.json"),
        Bundled(name: "Birta Terminal Amber", kind: .dark,
                fileName: "birta-terminal-amber-color-theme.json"),
    ]

    /// Whether `id` names a shipped theme.
    public static func isDefault(id: String) -> Bool { id.hasPrefix(idPrefix) }

    /// Where the files are, given a bundle's Resources folder, or nil when
    /// the host has none. A test bundle and a command-line tool both have
    /// none, which is why every caller takes the optional.
    public static func folder(inResources resources: URL?) -> URL? {
        resources?.appendingPathComponent(folderName, isDirectory: true)
    }

    /// The file for `theme` under `resources`, or nil when it is not there.
    ///
    /// Checked rather than assumed: a bundle assembled without the folder
    /// must leave the library alone rather than write a theme that cannot be
    /// read back.
    public static func file(_ theme: Bundled, inResources resources: URL?) -> URL? {
        guard let folder = folder(inResources: resources) else { return nil }
        let url = folder.appendingPathComponent(theme.fileName)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
}
