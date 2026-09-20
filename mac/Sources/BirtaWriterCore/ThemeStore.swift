import Foundation

/// A theme the store holds, as the menus and the palette list it.
public struct ThemeSummary: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let kind: VSCodeTheme.Kind
    /// The few colours a card needs to look like the theme.
    public let preview: ThemePreview

    public init(id: String, name: String, kind: VSCodeTheme.Kind, preview: ThemePreview? = nil) {
        self.id = id
        self.name = name
        self.kind = kind
        self.preview = preview ?? ThemePreview.system(kind)
    }
}

/// What a theme looks like from across the room: its paper, its ink, its
/// accent and its sidebar, as hex colours. Read off a theme's colours with
/// the palette's own fallbacks, so a theme that leaves a role unsaid draws
/// the way the page would draw it.
public struct ThemePreview: Equatable, Sendable {
    public let paper: String
    public let ink: String
    public let accent: String
    public let sidebar: String

    public init(paper: String, ink: String, accent: String, sidebar: String) {
        self.paper = paper
        self.ink = ink
        self.accent = accent
        self.sidebar = sidebar
    }

    /// The page's own palette for `kind`, as a card.
    public static func system(_ kind: VSCodeTheme.Kind) -> ThemePreview {
        let palette = AppearanceOverlay.systemPalette(kind)
        return ThemePreview(paper: palette["editor.background"]!,
                            ink: palette["editor.foreground"]!,
                            accent: palette["focusBorder"]!,
                            sidebar: palette["editorWidget.background"]!)
    }

    public init(_ theme: VSCodeTheme) {
        let fallback = ThemePreview.system(theme.kind)
        let colors = theme.colors
        self.init(paper: colors["editor.background"] ?? fallback.paper,
                  ink: colors["editor.foreground"] ?? colors["foreground"] ?? fallback.ink,
                  accent: colors["focusBorder"] ?? colors["textLink.foreground"] ?? fallback.accent,
                  sidebar: colors["sideBar.background"] ?? colors["editorWidget.background"] ?? fallback.sidebar)
    }
}

/// One theme as an extension declares it: the manifest's label and base
/// kind, and the file. What `ThemeStore.importThemes(_:)` takes.
public struct ThemeSource: Equatable, Sendable {
    public let label: String?
    public let uiTheme: String?
    public let url: URL

    public init(label: String?, uiTheme: String?, url: URL) {
        self.label = label
        self.uiTheme = uiTheme
        self.url = url
    }
}

/// The themes the app has been given, kept as files in one folder.
///
/// The folder IS the list. Each theme is one plain JSON file named by its
/// id, written by `VSCodeTheme.stored()` with its includes folded in and its
/// comments gone, so the launch that reads it back needs neither the
/// extension it came from nor the tolerance reading that extension's file
/// took. A list kept in the defaults beside the files would be a second
/// record of the same folder, and the two would disagree the first time a
/// file was removed by hand.
///
/// The id is the name's slug, so importing a theme again replaces it rather
/// than adding a second copy: a theme extension updates in place, and that is
/// what somebody re-importing one wants.
///
/// What it accepts, in `importThemes(from:)`: a theme file (`.json`), a theme
/// extension's folder (the one holding `package.json`, or its parent as a
/// VSIX unpacks it), or a `.vsix`, which is that folder zipped. The manifest's
/// `contributes.themes` names the files, their labels and their base kinds,
/// which is what VS Code itself reads.
public struct ThemeStore: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// Where an install keeps its themes: under Application Support, in a
    /// folder named for the flavour so a development build's themes do not
    /// stand in for the release's.
    public static func directory(applicationSupport: URL, appName: String) -> URL {
        applicationSupport
            .appendingPathComponent(appName, isDirectory: true)
            .appendingPathComponent("Themes", isDirectory: true)
    }

    public enum ImportError: Error, LocalizedError, Equatable {
        case nothingFound(String)
        case unpackFailed(String)
        case notAThemeFile(String)

        public var errorDescription: String? {
            switch self {
            case let .nothingFound(what): return "No VS Code colour themes were found in \(what)."
            case let .unpackFailed(what): return "\(what) could not be unpacked."
            case let .notAThemeFile(what): return "\(what) is not a theme file, a theme extension or a .vsix."
            }
        }
    }

    // MARK: reading

    /// Every theme in the folder, by name.
    public func list() -> [ThemeSummary] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { file -> ThemeSummary? in
                guard let theme = try? Self.read(file) else { return nil }
                return ThemeSummary(id: file.deletingPathExtension().lastPathComponent,
                                    name: theme.name, kind: theme.kind, preview: ThemePreview(theme))
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// `themes` with the ones of `kind` first, each group keeping the order
    /// it arrived in, which for `list()` is by name.
    ///
    /// What a picker OF a kind lists. A dark slot is being filled for dark
    /// mode, so the dark themes are what somebody is choosing between and a
    /// light one interleaved alphabetically is a row to read past; VS Code's
    /// own theme picker groups its list the same way. A theme of the other
    /// kind is still offered rather than hidden, because a slot takes a
    /// theme of either kind on purpose (`AppearanceSettings`).
    public static func ordered(_ themes: [ThemeSummary], preferring kind: VSCodeTheme.Kind) -> [ThemeSummary] {
        themes.filter { $0.kind == kind } + themes.filter { $0.kind != kind }
    }

    public func theme(id: String) -> VSCodeTheme? {
        guard Self.isId(id) else { return nil }
        return try? Self.read(file(for: id))
    }

    public func remove(id: String) throws {
        guard Self.isId(id) else { return }
        let url = file(for: id)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }

    private func file(for id: String) -> URL {
        directory.appendingPathComponent(id).appendingPathExtension("json")
    }

    private static func read(_ url: URL) throws -> VSCodeTheme {
        try VSCodeTheme.parse(try JSONSerialization.jsonObject(with: try Data(contentsOf: url)))
    }

    /// An id is what `slug` makes, and nothing else may name a file here: a
    /// stored id is a defaults value, and a path in one would otherwise reach
    /// past the folder.
    static func isId(_ id: String) -> Bool {
        !id.isEmpty && id.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || $0 == "-" }
    }

    /// The file name a theme's name becomes: lower-case words joined by
    /// dashes, so "Harlan Terminal (Amber)" is `harlan-terminal-amber`.
    public static func slug(_ name: String) -> String {
        let folded = name.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
        var out = ""
        var pendingDash = false
        for scalar in folded.unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar), scalar.isASCII {
                if pendingDash, !out.isEmpty { out.append("-") }
                pendingDash = false
                out.unicodeScalars.append(scalar)
            } else {
                pendingDash = true
            }
        }
        return out.isEmpty ? "theme" : out
    }

    // MARK: writing

    /// Add what is at `url`, replacing any theme already here by the same
    /// name, and say what was added.
    @discardableResult
    public func importThemes(from url: URL) throws -> [ThemeSummary] {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            throw ImportError.notAThemeFile(url.lastPathComponent)
        }
        if isDirectory.boolValue {
            let sources = Self.themes(inExtension: url)
            guard !sources.isEmpty else { throw ImportError.nothingFound(url.lastPathComponent) }
            return try importThemes(sources)
        }
        switch url.pathExtension.lowercased() {
        case "vsix", "zip":
            let unpacked = try Self.unpack(url)
            defer { try? FileManager.default.removeItem(at: unpacked) }
            let sources = Self.themes(inExtension: unpacked)
            guard !sources.isEmpty else { throw ImportError.nothingFound(url.lastPathComponent) }
            return try importThemes(sources)
        case "json":
            return try importThemes([ThemeSource(label: nil, uiTheme: nil, url: url)])
        default:
            throw ImportError.notAThemeFile(url.lastPathComponent)
        }
    }

    /// Add each of `sources`, written under its name's slug.
    @discardableResult
    public func importThemes(_ sources: [ThemeSource]) throws -> [ThemeSummary] {
        var added: [ThemeSummary] = []
        for source in sources {
            let theme = try VSCodeTheme.load(from: source.url, label: source.label, uiTheme: source.uiTheme)
            let id = Self.slug(theme.name)
            try AtomicFile.write(try theme.stored(), to: file(for: id))
            added.append(ThemeSummary(id: id, name: theme.name, kind: theme.kind, preview: ThemePreview(theme)))
        }
        return added
    }

    /// A `.vsix` (a zip) unpacked into a temporary folder the caller removes.
    ///
    /// `ditto` rather than a zip library, as the updater unpacks its own
    /// download (`Updater.swift`): it ships with every macOS and preserves
    /// what a Mac cares about.
    static func unpack(_ archive: URL) throws -> URL {
        let target = FileManager.default.temporaryDirectory
            .appendingPathComponent("birta-theme-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        let ditto = Process()
        ditto.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        ditto.arguments = ["-x", "-k", archive.path, target.path]
        ditto.standardOutput = FileHandle.nullDevice
        ditto.standardError = FileHandle.nullDevice
        do {
            try ditto.run()
        } catch {
            try? FileManager.default.removeItem(at: target)
            throw ImportError.unpackFailed(archive.lastPathComponent)
        }
        ditto.waitUntilExit()
        guard ditto.terminationStatus == 0 else {
            try? FileManager.default.removeItem(at: target)
            throw ImportError.unpackFailed(archive.lastPathComponent)
        }
        return target
    }

    // MARK: extensions

    /// The themes an extension folder contributes, read from its manifest.
    ///
    /// `folder` may be the extension itself (holding `package.json`) or the
    /// folder a VSIX unpacks into, which holds the extension under
    /// `extension/`. Files the manifest names that are not JSON (a
    /// `.tmTheme`) are left out: VS Code reads those too, and this app does
    /// not.
    public static func themes(inExtension folder: URL) -> [ThemeSource] {
        // As a DIRECTORY, whatever the caller's URL said: a folder listed out
        // of an extensions directory can be a symlink (an author's own theme
        // linked in from a checkout is the common case), which a listing
        // reports with no trailing slash, and a relative path resolved
        // against such a URL lands beside the folder instead of inside it.
        let directory = URL(fileURLWithPath: folder.resolvingSymlinksInPath().path, isDirectory: true)
        let candidates = [directory, directory.appendingPathComponent("extension", isDirectory: true)]
        guard let root = candidates.first(where: {
            FileManager.default.fileExists(atPath: $0.appendingPathComponent("package.json").path)
        }) else { return [] }
        guard let manifest = try? JSONC.object(from: try Data(contentsOf: root.appendingPathComponent("package.json"))),
              let dict = manifest as? [String: Any],
              let contributes = dict["contributes"] as? [String: Any],
              let themes = contributes["themes"] as? [[String: Any]] else { return [] }
        let strings = localizedStrings(in: root)
        let rootPath = root.standardizedFileURL.path
        return themes.compactMap { entry -> ThemeSource? in
            guard let path = entry["path"] as? String, !path.isEmpty else { return nil }
            let url = URL(fileURLWithPath: path, relativeTo: root).standardizedFileURL
            // Under the root, the rule `DirectoryListing` keeps: a package
            // from anywhere names its files, and a name that climbs out of
            // the package is refused rather than read.
            guard url.path.hasPrefix(rootPath + "/"),
                  url.pathExtension.lowercased() == "json",
                  FileManager.default.fileExists(atPath: url.path) else { return nil }
            // A built-in theme's label is a `%key%` into package.nls.json;
            // the `id` beside it is what VS Code shows when the key is
            // missing, and it is what a theme's picker row says.
            var label = entry["label"] as? String
            if let key = label, key.hasPrefix("%"), key.hasSuffix("%"), key.count > 2 {
                label = strings[String(key.dropFirst().dropLast())] ?? (entry["id"] as? String)
            }
            return ThemeSource(label: label, uiTheme: entry["uiTheme"] as? String, url: url)
        }
    }

    /// The manifest's `package.nls.json`, for the labels written as keys.
    private static func localizedStrings(in root: URL) -> [String: String] {
        guard let data = try? Data(contentsOf: root.appendingPathComponent("package.nls.json")),
              let object = try? JSONC.object(from: data) as? [String: Any] else { return [:] }
        return object.compactMapValues { $0 as? String }
    }

    /// Where the VS Code family keeps its extensions on this Mac, for the
    /// ones that exist: the folders each editor installs into under the
    /// home directory, and the built-in extensions inside each editor's app
    /// bundle, which is where the stock themes (Dark Modern, Solarized,
    /// Monokai and the rest) live.
    public static func installedExtensionRoots(home: URL, applications: URL = URL(fileURLWithPath: "/Applications", isDirectory: true)) -> [URL] {
        let user = [".vscode", ".vscode-insiders", ".vscode-oss", ".cursor", ".windsurf"].map {
            home.appendingPathComponent($0, isDirectory: true).appendingPathComponent("extensions", isDirectory: true)
        }
        let bundled = ["Visual Studio Code.app", "Visual Studio Code - Insiders.app", "VSCodium.app",
                       "Cursor.app", "Windsurf.app"].map {
            applications.appendingPathComponent($0, isDirectory: true)
                .appendingPathComponent("Contents/Resources/app/extensions", isDirectory: true)
        }
        return (user + bundled).filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// Every theme every extension under `roots` contributes, by label.
    public static func themesInExtensions(roots: [URL]) -> [ThemeSource] {
        var found: [ThemeSource] = []
        var seen = Set<String>()
        for root in roots {
            let folders = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
            // Newest version first, so an extension installed twice over
            // (`name-2.1.269` beside `name-2.1.261`) is read from the later.
            // Numeric-aware, as `DirectoryListing` sorts: a plain string
            // compare puts `name-2.1.9` after `name-2.1.10` and reads the
            // older copy.
            for folder in folders.sorted(by: {
                $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedDescending
            }) {
                for source in themes(inExtension: folder) {
                    let key = source.label ?? source.url.lastPathComponent
                    guard seen.insert(key).inserted else { continue }
                    found.append(source)
                }
            }
        }
        return found.sorted {
            ($0.label ?? $0.url.lastPathComponent).localizedCaseInsensitiveCompare($1.label ?? $1.url.lastPathComponent) == .orderedAscending
        }
    }
}
