import Foundation

/// A theme the store holds, as the menus and the palette list it.
public struct ThemeSummary: Equatable, Sendable, Identifiable {
    public let id: String
    /// What every surface calls it: the theme's own name, or that name with
    /// a qualifier when another theme in the same list carries it too
    /// (`ThemeStore.disambiguated`).
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

    /// Whether this is one of the themes the app ships with. Read off the id,
    /// which is the only thing that tells them apart: a default is an
    /// ordinary file in the ordinary folder once it is there.
    public var isDefault: Bool { DefaultThemes.isDefault(id: id) }

    /// The same summary under a different name, for the qualifier a clash
    /// adds.
    func named(_ name: String) -> ThemeSummary {
        ThemeSummary(id: id, name: name, kind: kind, preview: preview)
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
/// An imported theme's id is its name's slug, so importing one again replaces
/// it rather than adding a second copy: a theme extension updates in place,
/// and that is what somebody re-importing one wants.
///
/// A theme the app SHIPS takes its id from `DefaultThemes` instead, in a
/// namespace a slug cannot spell, so a shipped theme and an import that
/// happens to carry the same name are two files rather than one. Both are
/// listed, both are picked and both are removed on their own; `disambiguated`
/// is what stops the two reading identically in a strip of cards.
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
        let themes = files
            .filter { $0.pathExtension == "json" }
            .compactMap { file -> ThemeSummary? in
                guard let theme = try? Self.read(file) else { return nil }
                return ThemeSummary(id: file.deletingPathExtension().lastPathComponent,
                                    name: theme.name, kind: theme.kind, preview: ThemePreview(theme))
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        return Self.disambiguated(themes)
    }

    /// What a shipped theme is called once something else in the list carries
    /// its name.
    public static let bundledQualifier = "Built-in"

    /// `themes` with any name shared by two of them made tellable apart.
    ///
    /// A shipped theme and an imported one are separate files under separate
    /// ids (`DefaultThemes.Bundled.id`), so both are listed, both are picked
    /// and both are removed on their own. What they can share is the NAME,
    /// and a strip of cards or a menu of rows is nothing but names: two rows
    /// reading the same is a choice with no way to make it.
    ///
    /// Only the shipped one takes the qualifier. It is the one whose
    /// provenance a reader cannot otherwise see, and marking both would put
    /// a word on the theme somebody named themselves.
    ///
    /// Applied in `list()`, so every surface gets it from the one place they
    /// all read. Two IMPORTS cannot reach this: they would share an id and
    /// the second would have replaced the first.
    public static func disambiguated(_ themes: [ThemeSummary]) -> [ThemeSummary] {
        var counts: [String: Int] = [:]
        for theme in themes { counts[theme.name, default: 0] += 1 }
        return themes.map { theme in
            guard theme.isDefault, counts[theme.name, default: 0] > 1 else { return theme }
            return theme.named("\(theme.name) (\(bundledQualifier))")
        }
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

    /// What may name a file here: letters, digits, dashes, and the underscore
    /// a shipped theme's id carries. A stored id is a defaults value, and a
    /// path in one would otherwise reach past the folder; none of these four
    /// can spell a separator or a `..`.
    ///
    /// The underscore is admitted here and never emitted by `slug`, which is
    /// what keeps the two namespaces apart (`DefaultThemes.Bundled.id`).
    static func isId(_ id: String) -> Bool {
        !id.isEmpty && id.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_"
        }
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
            added.append(try write(theme, as: Self.slug(theme.name)))
        }
        return added
    }

    /// `theme` written under `id`, as the one file the folder keeps it in.
    ///
    /// The id is a parameter rather than derived here, because the two kinds
    /// of theme choose it differently: an import takes its name's slug, so
    /// re-importing one replaces it, and a shipped theme takes its declared
    /// id, so an import can never land on top of it.
    private func write(_ theme: VSCodeTheme, as id: String) throws -> ThemeSummary {
        try AtomicFile.write(try theme.stored(), to: file(for: id))
        return ThemeSummary(id: id, name: theme.name, kind: theme.kind, preview: ThemePreview(theme))
    }

    // MARK: the themes the app ships with

    /// Which of `defaults` the folder does not hold right now.
    public func missingDefaults(_ defaults: [DefaultThemes.Bundled] = DefaultThemes.all) -> [DefaultThemes.Bundled] {
        let held = Set(list().map(\.id))
        return defaults.filter { !held.contains($0.id) }
    }

    /// Write each of `defaults` into the folder from the bundle's `resources`,
    /// and say what landed and what could not.
    ///
    /// The name is the DECLARED one rather than the file's, so the id a theme
    /// lands under is decided by the list and not by a copy whose own `name`
    /// has drifted; `DefaultThemesTests` is what holds the two in step, and
    /// it fails loudly where this would otherwise be silent.
    ///
    /// It only ever adds. Restoring is not a reset: a default already in the
    /// folder is left exactly as it is, and nothing else in the library is
    /// touched.
    public func installDefaults(_ defaults: [DefaultThemes.Bundled],
                                from resources: URL?) -> (added: [ThemeSummary], failures: [String]) {
        var added: [ThemeSummary] = []
        var failures: [String] = []
        for bundled in defaults {
            guard let url = DefaultThemes.file(bundled, inResources: resources) else {
                failures.append("\(bundled.name): the app bundle does not carry \(bundled.fileName).")
                continue
            }
            do {
                let theme = try VSCodeTheme.load(from: url, label: bundled.name)
                added.append(try write(theme, as: bundled.id))
            } catch {
                failures.append("\(bundled.name): \(error.localizedDescription)")
            }
        }
        return (added, failures)
    }

    /// Put the shipped themes this install has never been GIVEN into the
    /// folder, and answer with the record of them a later launch reads.
    ///
    /// `seeded` is what has already been offered, by id. It is what makes the
    /// remove button honest: the folder alone cannot tell a default nobody
    /// has seen yet from one somebody removed, so a launch reading the folder
    /// would put back every theme they took out, every time. The record only
    /// ever grows, so a default added in a later version is seeded when that
    /// version first runs.
    ///
    /// A default whose file the bundle does not carry is left OUT of the
    /// record, so a build assembled without the folder (a test host is one)
    /// does not spend the one chance each theme gets.
    public func seedDefaults(from resources: URL?, seeded: Set<String>,
                             defaults: [DefaultThemes.Bundled] = DefaultThemes.all)
        -> (added: [ThemeSummary], seeded: Set<String>) {
        let held = Set(list().map(\.id))
        var record = seeded
        var added: [ThemeSummary] = []
        for bundled in defaults where !seeded.contains(bundled.id) {
            // Already there, and never recorded: an install that had the
            // theme before the record existed. Nothing to write, and the one
            // chance is spent, because it has plainly been given.
            if held.contains(bundled.id) {
                record.insert(bundled.id)
                continue
            }
            let result = installDefaults([bundled], from: resources)
            guard result.failures.isEmpty else { continue }
            added += result.added
            record.insert(bundled.id)
        }
        return (added, record)
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
