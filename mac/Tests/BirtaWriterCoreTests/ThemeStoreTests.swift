import XCTest
@testable import BirtaWriterCore

/// The folder of imported themes: what a file, an extension folder and a
/// VSIX become in it, and how VS Code's own extensions folder is read.
final class ThemeStoreTests: XCTestCase {
    private var root: URL!
    private var store: ThemeStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory.appendingPathComponent("themestore-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = ThemeStore(directory: root.appendingPathComponent("Themes", isDirectory: true))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    private func write(_ text: String, to relative: String) throws -> URL {
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    /// An extension folder with a manifest contributing two themes, one of
    /// them a `.tmTheme` the app cannot read.
    private func writeExtension(at relative: String, label: String = "Slate") throws -> URL {
        let folder = root.appendingPathComponent(relative, isDirectory: true)
        _ = try write("""
        {
          "name": "themes", "publisher": "p",
          "contributes": { "themes": [
            { "label": "\(label)", "uiTheme": "vs-dark", "path": "./themes/slate.json" },
            { "label": "Paper", "uiTheme": "vs", "path": "./themes/paper-color-theme.json" },
            { "label": "Old", "uiTheme": "vs", "path": "./themes/old.tmTheme" }
          ] }
        }
        """, to: relative + "/package.json")
        _ = try write(##"{ "colors": { "editor.background": "#182529" } } // no type: the manifest says"##,
                      to: relative + "/themes/slate.json")
        _ = try write(##"{ "name": "Paper File", "type": "light", "colors": { "editor.background": "#f7f3e8" } }"##,
                      to: relative + "/themes/paper-color-theme.json")
        _ = try write("<plist/>", to: relative + "/themes/old.tmTheme")
        return folder
    }

    func testAnEmptyOrMissingFolderShouldListNothing() {
        XCTAssertEqual(store.list(), [])
        XCTAssertNil(store.theme(id: "anything"))
    }

    func testImportingAThemeFileShouldStoreItUnderItsNamesSlugAndListIt() throws {
        let file = try write(##"{ "name": "Harlan Terminal (Amber)", "type": "dark", "colors": { "editor.background": "#101010" } }"##,
                             to: "in/amber.json")
        let added = try store.importThemes(from: file)
        XCTAssertEqual(added.map(\.id), ["harlan-terminal-amber"])
        XCTAssertEqual(added.first?.name, "Harlan Terminal (Amber)")
        XCTAssertEqual(added.first?.kind, .dark)
        XCTAssertEqual(added.first?.preview.paper, "#101010", "the card's paper is the theme's")
        XCTAssertEqual(added.first?.preview.accent, ThemePreview.system(.dark).accent, "unsaid, so the palette's")
        XCTAssertEqual(store.list(), added)
        XCTAssertEqual(store.theme(id: "harlan-terminal-amber")?.colors["editor.background"], "#101010")
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.directory.appendingPathComponent("harlan-terminal-amber.json").path))
    }

    func testImportingAgainShouldReplaceRatherThanDuplicate() throws {
        let v1 = try write(##"{ "name": "Same", "colors": { "editor.background": "#ffffff" } }"##, to: "a/same.json")
        let v2 = try write(##"{ "name": "Same", "colors": { "editor.background": "#000000" } }"##, to: "b/same.json")
        try store.importThemes(from: v1)
        try store.importThemes(from: v2)
        XCTAssertEqual(store.list().count, 1)
        XCTAssertEqual(store.theme(id: "same")?.colors["editor.background"], "#000000")
        XCTAssertEqual(store.theme(id: "same")?.kind, .dark, "the kind follows the replacement too")
    }

    func testAnExtensionFolderShouldImportWhatItsManifestContributesUnderTheManifestsLabels() throws {
        let folder = try writeExtension(at: "ext")
        let added = try store.importThemes(from: folder)
        XCTAssertEqual(added.map(\.name), ["Slate", "Paper"], "the label, not the file's name, and no .tmTheme")
        XCTAssertEqual(added.map(\.kind), [.dark, .light], "Slate's kind is the manifest's uiTheme")
        XCTAssertEqual(store.list().map(\.id), ["paper", "slate"], "listed by name")
    }

    func testAVSIXShouldBeUnpackedAndReadAsTheExtensionItHolds() throws {
        _ = try writeExtension(at: "pkg/extension", label: "Zipped")
        let vsix = root.appendingPathComponent("themes.vsix")
        let ditto = Process()
        ditto.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        ditto.arguments = ["-c", "-k", "--sequesterRsrc", root.appendingPathComponent("pkg").path, vsix.path]
        try ditto.run()
        ditto.waitUntilExit()
        XCTAssertEqual(ditto.terminationStatus, 0)

        let added = try store.importThemes(from: vsix)
        XCTAssertEqual(added.map(\.name), ["Zipped", "Paper"])
        let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: FileManager.default.temporaryDirectory.path))?
            .filter { $0.hasPrefix("birta-theme-") } ?? []
        XCTAssertEqual(leftovers, [], "the unpacked copy is removed")
    }

    func testAManifestPathThatClimbsOutOfTheExtensionShouldBeRefused() throws {
        _ = try write(##"{ "name": "Outside", "colors": { "editor.background": "#000000" } }"##, to: "outside.json")
        _ = try write(##"{ "contributes": { "themes": [ { "label": "Escape", "uiTheme": "vs-dark", "path": "../outside.json" }, { "label": "Inside", "uiTheme": "vs", "path": "./inside.json" } ] } }"##,
                      to: "ext/package.json")
        _ = try write(##"{ "colors": { "editor.background": "#ffffff" } }"##, to: "ext/inside.json")
        let found = ThemeStore.themes(inExtension: root.appendingPathComponent("ext", isDirectory: true))
        XCTAssertEqual(found.map(\.label), ["Inside"], "the path under the root, and not the one above it")
    }

    func testAFolderWithNoManifestAndAFileOfTheWrongKindShouldBeRefusedByName() throws {
        let empty = root.appendingPathComponent("nothing", isDirectory: true)
        try FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)
        XCTAssertThrowsError(try store.importThemes(from: empty)) {
            XCTAssertEqual($0 as? ThemeStore.ImportError, .nothingFound("nothing"))
        }
        let text = try write("hello", to: "notes.txt")
        XCTAssertThrowsError(try store.importThemes(from: text)) {
            XCTAssertEqual($0 as? ThemeStore.ImportError, .notAThemeFile("notes.txt"))
        }
        XCTAssertThrowsError(try store.importThemes(from: root.appendingPathComponent("absent.json")))
        XCTAssertEqual(store.list(), [], "a refused import adds nothing")
    }

    func testRemoveShouldDeleteTheFileAndRefuseAnIdThatIsNotASlug() throws {
        let file = try write(##"{ "name": "Gone", "colors": { "editor.background": "#ffffff" } }"##, to: "gone.json")
        try store.importThemes(from: file)
        try store.remove(id: "gone")
        XCTAssertEqual(store.list(), [])
        try store.remove(id: "gone")
        // A path is not an id, so nothing outside the folder can be named.
        let outside = try write("keep", to: "keep.json")
        try store.remove(id: "../keep")
        XCTAssertTrue(FileManager.default.fileExists(atPath: outside.path))
        XCTAssertNil(store.theme(id: "../keep"))
    }

    func testSlugShouldBeLowerCaseWordsJoinedByDashes() {
        XCTAssertEqual(ThemeStore.slug("Harlan Terminal (Amber)"), "harlan-terminal-amber")
        XCTAssertEqual(ThemeStore.slug("  One Dark Pro -- Darker "), "one-dark-pro-darker")
        XCTAssertEqual(ThemeStore.slug("Café"), "cafe")
        XCTAssertEqual(ThemeStore.slug("***"), "theme")
    }

    func testInstalledExtensionsShouldBeReadFromEveryEditorsFolderNewestVersionFirst() throws {
        let home = root.appendingPathComponent("home", isDirectory: true)
        _ = try writeExtension(at: "home/.vscode/extensions/pub.themes-1.0.0", label: "Slate 1")
        _ = try writeExtension(at: "home/.vscode/extensions/pub.themes-1.2.0", label: "Slate 1")
        _ = try writeExtension(at: "home/.cursor/extensions/other.set-0.1.0", label: "Cursor Slate")
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".vscode-insiders/extensions"),
                                                withIntermediateDirectories: true)
        // An author's own theme, linked into the extensions folder from a
        // checkout: a listing reports the link with no trailing slash, and
        // the manifest's relative paths have to resolve inside it anyway.
        _ = try writeExtension(at: "checkouts/my-themes", label: "Linked Slate")
        try FileManager.default.createSymbolicLink(
            at: home.appendingPathComponent(".vscode/extensions/me.my-themes-0.1.0"),
            withDestinationURL: root.appendingPathComponent("checkouts/my-themes", isDirectory: true))
        // The editor's own bundled themes, whose labels are keys into the
        // manifest's strings file, with the `id` as VS Code's fallback.
        let applications = root.appendingPathComponent("Applications", isDirectory: true)
        let bundled = "Applications/Visual Studio Code.app/Contents/Resources/app/extensions/theme-defaults"
        _ = try write("""
        { "name": "theme-defaults", "contributes": { "themes": [
            { "id": "Dark Modern", "label": "%darkModernThemeLabel%", "uiTheme": "vs-dark", "path": "./themes/dark_modern.json" },
            { "id": "Light Modern", "label": "%missingKey%", "uiTheme": "vs", "path": "./themes/light_modern.json" }
        ] } }
        """, to: bundled + "/package.json")
        _ = try write(##"{ "darkModernThemeLabel": "Dark Modern (Default)" }"##, to: bundled + "/package.nls.json")
        _ = try write(##"{ "colors": { "editor.background": "#1f1f1f" } }"##, to: bundled + "/themes/dark_modern.json")
        _ = try write(##"{ "colors": { "editor.background": "#ffffff" } }"##, to: bundled + "/themes/light_modern.json")

        let roots = ThemeStore.installedExtensionRoots(home: home, applications: applications)
        XCTAssertEqual(roots.map { $0.path.replacingOccurrences(of: home.path, with: "~").replacingOccurrences(of: applications.path, with: "/Applications") },
                       ["~/.vscode/extensions", "~/.vscode-insiders/extensions", "~/.cursor/extensions",
                        "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions"])
        let found = ThemeStore.themesInExtensions(roots: roots)
        XCTAssertEqual(found.map(\.label), ["Cursor Slate", "Dark Modern (Default)", "Light Modern", "Linked Slate", "Paper", "Slate 1"],
                       "by label, one per label; the linked extension's themes among them, the nls key resolved and the missing one falling back to the id")
        let slate = try XCTUnwrap(found.first { $0.label == "Slate 1" })
        XCTAssertTrue(slate.url.path.contains("pub.themes-1.2.0"), "the later version, not the first folder")
        let linked = try XCTUnwrap(found.first { $0.label == "Linked Slate" })
        XCTAssertTrue(FileManager.default.fileExists(atPath: linked.url.path), "resolved inside the linked folder")
        XCTAssertEqual(try store.importThemes(found).count, 6)
    }

    func testTheDefaultDirectoryShouldBeNamedForTheApp() {
        let dir = ThemeStore.directory(applicationSupport: URL(fileURLWithPath: "/tmp/AS"), appName: "Birta Writer [DEV]")
        XCTAssertEqual(dir.path, "/tmp/AS/Birta Writer [DEV]/Themes")
    }
}
