import XCTest
@testable import BirtaWriterCore

/// The themes the app ships with: that the declared list and the committed
/// folder are the same four, that a shipped theme's id is somewhere no import
/// can reach, and what seeding and restoring do to the library.
final class DefaultThemesTests: XCTestCase {
    private var root: URL!
    private var store: ThemeStore!

    /// The committed folder, which is also what the build script copies into
    /// the bundle. Found from this file rather than from a bundle, because
    /// the xctest host has no Resources of ours.
    private var resources: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Resources", isDirectory: true)
    }

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory.appendingPathComponent("defaultthemes-\(UUID().uuidString)")
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

    // MARK: the list and the folder are one thing

    /// Both directions, which is the whole point of asking: a file copied in
    /// and not declared is a theme that never ships, and a declaration whose
    /// file is missing is a theme the library is told to expect and cannot
    /// find. Derived from the folder's own contents rather than from a second
    /// hand-written list.
    func testTheDeclaredListAndTheCommittedFolderShouldBeTheSameFiles() throws {
        let folder = try XCTUnwrap(DefaultThemes.folder(inResources: resources))
        let onDisk = Set(try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .map(\.lastPathComponent))
        let declared = Set(DefaultThemes.all.map(\.fileName))
        XCTAssertFalse(onDisk.isEmpty, "the folder is the subject; an empty one means this guard reached nothing")
        XCTAssertEqual(onDisk, declared,
                       "mac/Resources/\(DefaultThemes.folderName) and DefaultThemes.all disagree")
    }

    /// What each declaration CLAIMS about its file, read back off the file.
    /// A copy is a copy of something, and the name is what its id is built
    /// from, so a copy whose own name drifted would be listed under a name
    /// the declaration does not know.
    func testEveryDeclaredThemeShouldMatchTheFileItNames() throws {
        for bundled in DefaultThemes.all {
            let url = try XCTUnwrap(DefaultThemes.file(bundled, inResources: resources),
                                    "\(bundled.fileName) is not in the folder")
            let theme = try VSCodeTheme.load(from: url)
            XCTAssertEqual(theme.name, bundled.name, "\(bundled.fileName) carries a different name")
            XCTAssertEqual(theme.kind, bundled.kind, "\(bundled.fileName) carries a different type")
            XCTAssertFalse(theme.colors.isEmpty, "\(bundled.fileName) parsed to no colours")
        }
        XCTAssertEqual(DefaultThemes.all.count, 4)
    }

    // MARK: the two id namespaces

    /// The invariant the whole clash story stands on. `slug` emits letters,
    /// digits and dashes, so an underscore is a character no import can
    /// produce however anybody names a theme, and a shipped theme's id
    /// therefore cannot be the file an import writes.
    func testASlugShouldNeverSpellAShippedThemesId() {
        let adversarial = DefaultThemes.all.map(\.name)
            + DefaultThemes.all.map(\.id)
            + DefaultThemes.all.map { DefaultThemes.idPrefix + $0.name }
            + ["default_birta terracotta light", "Default Birta Terracotta Light",
               "_", "a_b", "Birta Terracotta Light"]
        let ids = Set(DefaultThemes.all.map(\.id))
        for name in adversarial {
            let slug = ThemeStore.slug(name)
            XCTAssertFalse(slug.contains("_"), "slug(\(name)) emitted an underscore")
            XCTAssertFalse(ids.contains(slug), "slug(\(name)) landed on a shipped theme's id")
        }
        XCTAssertTrue(DefaultThemes.all.allSatisfy { ThemeStore.isId($0.id) },
                      "a shipped id the store refuses could be neither read nor removed")
        XCTAssertTrue(DefaultThemes.all.allSatisfy { DefaultThemes.isDefault(id: $0.id) })
        XCTAssertFalse(DefaultThemes.isDefault(id: "birta-terracotta-light"))
    }

    // MARK: seeding

    func testSeedingAnEmptyLibraryShouldInstallEveryShippedThemeAndRecordThem() {
        let result = store.seedDefaults(from: resources, seeded: [])
        XCTAssertEqual(result.added.count, 4)
        XCTAssertEqual(result.seeded, Set(DefaultThemes.all.map(\.id)))
        XCTAssertEqual(Set(store.list().map(\.id)), Set(DefaultThemes.all.map(\.id)))
        XCTAssertEqual(store.list().map(\.name).sorted(),
                       DefaultThemes.all.map(\.name).sorted(),
                       "no qualifier while nothing clashes")
        XCTAssertEqual(store.theme(id: DefaultThemes.all[0].id)?.kind, .light)
    }

    /// The whole reason the record exists. Without it the folder is the only
    /// evidence, and a removed default is indistinguishable from one never
    /// given, so every launch would put it back.
    func testARemovedShippedThemeShouldNotComeBackAtTheNextLaunch() throws {
        var seeded = store.seedDefaults(from: resources, seeded: []).seeded
        let removed = DefaultThemes.all[1]
        try store.remove(id: removed.id)
        XCTAssertFalse(store.list().map(\.id).contains(removed.id))

        let relaunch = store.seedDefaults(from: resources, seeded: seeded)
        XCTAssertEqual(relaunch.added, [], "a launch after a removal writes nothing")
        XCTAssertFalse(store.list().map(\.id).contains(removed.id),
                       "the removed theme is back, so the remove button was a lie")
        seeded = relaunch.seeded
        XCTAssertEqual(seeded, Set(DefaultThemes.all.map(\.id)), "the record only grows")
    }

    /// A theme added to a later version is seeded when that version first
    /// runs, without disturbing the three already there.
    func testAThemeAddedToTheListLaterShouldBeSeededOnItsFirstLaunch() {
        let earlier = Set(DefaultThemes.all.dropLast().map(\.id))
        let result = store.seedDefaults(from: resources, seeded: earlier)
        XCTAssertEqual(result.added.map(\.id), [DefaultThemes.all.last!.id])
        XCTAssertEqual(result.seeded, Set(DefaultThemes.all.map(\.id)))
    }

    /// A bundle with no theme folder leaves the record alone, so the one
    /// chance each theme gets is not spent by a build that could not take it.
    func testAMissingResourceFolderShouldLeaveTheLibraryAndTheRecordAlone() {
        let result = store.seedDefaults(from: root.appendingPathComponent("nowhere", isDirectory: true), seeded: [])
        XCTAssertEqual(result.added, [])
        XCTAssertEqual(result.seeded, [])
        XCTAssertEqual(store.list(), [])
        XCTAssertEqual(store.seedDefaults(from: nil, seeded: []).seeded, [])
    }

    /// A seeded theme is one the page can actually WEAR. The file landing in
    /// the folder is not the claim; being resolvable into a stylesheet in its
    /// own colours is, and a copy that parsed to nothing would pass every
    /// assertion above.
    func testEveryShippedThemeShouldResolveToAStylesheetInItsOwnColours() {
        _ = store.seedDefaults(from: resources, seeded: [])
        for bundled in DefaultThemes.all {
            let settings = AppearanceSettings(mode: AppearanceMode(holding: bundled.kind))
                .setting(bundled.id, for: bundled.kind)
            let resolved = Appearance.resolve(settings, systemIsDark: bundled.kind == .dark) { store.theme(id: $0) }
            XCTAssertEqual(resolved.themeId, bundled.id, "\(bundled.name) did not resolve")
            XCTAssertEqual(resolved.theme?.name, bundled.name)
            XCTAssertEqual(resolved.bodyClass, bundled.kind.bodyClass)
            XCTAssertTrue(resolved.stylesheet().contains(VSCodeTheme.cssVariable(for: "editor.background")),
                          "\(bundled.name) draws no paper of its own")
            XCTAssertNotEqual(resolved.paper, ThemePreview.system(bundled.kind).paper,
                              "\(bundled.name) resolved to the palette's own paper, so nothing of it is drawn")
        }
    }

    // MARK: restoring

    /// Restore is not a reset, and this is the assertion that says so: the
    /// library BEFORE and AFTER, with a custom theme and a surviving default
    /// named in both.
    func testRestoringShouldAddOnlyTheMissingShippedThemesAndTouchNothingElse() throws {
        _ = store.seedDefaults(from: resources, seeded: [])
        let custom = try write(##"{ "name": "Mine", "type": "dark", "colors": { "editor.background": "#010203" } }"##,
                               to: "in/mine.json")
        try store.importThemes(from: custom)
        let gone = DefaultThemes.all[0]
        let kept = DefaultThemes.all[3]
        try store.remove(id: gone.id)

        let before = store.list()
        XCTAssertEqual(before.count, 4, "three shipped themes and the custom one")
        let missing = store.missingDefaults()
        XCTAssertEqual(missing.map(\.id), [gone.id])

        let result = store.installDefaults(missing, from: resources)
        XCTAssertEqual(result.failures, [])
        XCTAssertEqual(result.added.map(\.id), [gone.id])

        let after = store.list()
        XCTAssertEqual(after.count, 5)
        XCTAssertEqual(Set(after.map(\.id)).subtracting(before.map(\.id)), [gone.id],
                       "restoring added exactly the one that was missing")
        XCTAssertEqual(store.theme(id: "mine")?.colors["editor.background"], "#010203",
                       "the custom theme is byte for byte what it was")
        XCTAssertEqual(store.theme(id: kept.id)?.name, kept.name, "a default still there was not rewritten")
        XCTAssertEqual(store.missingDefaults(), [], "nothing left to restore")
    }

    /// With nothing missing there is nothing to add, which is what lets the
    /// control say so instead of pressing on.
    func testRestoringAFullLibraryShouldFindNothingMissing() {
        _ = store.seedDefaults(from: resources, seeded: [])
        XCTAssertEqual(store.missingDefaults(), [])
        let result = store.installDefaults(store.missingDefaults(), from: resources)
        XCTAssertEqual(result.added, [])
        XCTAssertEqual(result.failures, [])
    }

    // MARK: a name shared by a shipped theme and an imported one

    /// The clash the two namespaces exist for: both present, both listed,
    /// both readable by id, both removable on their own, and tellable apart
    /// by the only channel a card or a menu row has.
    func testAShippedThemeAndAnImportSharingANameShouldBothStandAndBeTellableApart() throws {
        let shipped = DefaultThemes.all[0]
        _ = store.seedDefaults(from: resources, seeded: [])
        let clash = try write(##"{ "name": "\##(shipped.name)", "type": "dark", "colors": { "editor.background": "#0b0b0b" } }"##,
                              to: "in/clash.json")
        let added = try store.importThemes(from: clash)
        XCTAssertEqual(added.map(\.id), [ThemeStore.slug(shipped.name)])
        XCTAssertNotEqual(added.first?.id, shipped.id, "an import landed on the shipped theme's file")

        let list = store.list()
        XCTAssertEqual(list.count, 5, "the import replaced the shipped theme instead of joining it")
        XCTAssertEqual(store.theme(id: shipped.id)?.kind, shipped.kind, "the shipped file still reads as itself")
        XCTAssertEqual(store.theme(id: added[0].id)?.colors["editor.background"], "#0b0b0b")

        let names = list.filter { $0.id == shipped.id || $0.id == added[0].id }.map(\.name)
        XCTAssertEqual(Set(names), [shipped.name, "\(shipped.name) (\(ThemeStore.bundledQualifier))"],
                       "two rows reading the same is a choice with no way to make it")
        XCTAssertEqual(list.first { $0.id == shipped.id }?.name,
                       "\(shipped.name) (\(ThemeStore.bundledQualifier))",
                       "the qualifier goes on the shipped one, whose provenance is the unsaid part")

        // Removing one leaves the other, by id, in both directions.
        try store.remove(id: added[0].id)
        XCTAssertEqual(store.list().count, 4)
        XCTAssertNotNil(store.theme(id: shipped.id))
        XCTAssertNil(store.theme(id: added[0].id))
        XCTAssertEqual(store.list().first { $0.id == shipped.id }?.name, shipped.name,
                       "the qualifier goes away with the clash that earned it")
        XCTAssertEqual(store.missingDefaults(), [], "an import removed is not a default missing")

        try store.importThemes(from: clash)
        try store.remove(id: shipped.id)
        XCTAssertNil(store.theme(id: shipped.id), "removing the shipped one took the import instead")
        XCTAssertEqual(store.theme(id: ThemeStore.slug(shipped.name))?.colors["editor.background"], "#0b0b0b",
                       "the import is untouched by the shipped theme's removal")
        XCTAssertEqual(store.missingDefaults().map(\.id), [shipped.id],
                       "the import does not stand in for the shipped theme it was named after")
    }

    /// Two IMPORTS by one name still collapse into one file, which is the
    /// store's own documented behaviour and is deliberately unchanged: a
    /// re-import updates a theme in place. Pinned so a change to it is a
    /// decision rather than a surprise.
    func testTwoImportsSharingANameShouldStillReplaceOneAnother() throws {
        let first = try write(##"{ "name": "Same", "colors": { "editor.background": "#ffffff" } }"##, to: "a/s.json")
        let second = try write(##"{ "name": "Same", "colors": { "editor.background": "#000000" } }"##, to: "b/s.json")
        try store.importThemes(from: first)
        try store.importThemes(from: second)
        XCTAssertEqual(store.list().count, 1)
        XCTAssertEqual(store.list().first?.name, "Same", "no qualifier: there is no clash to resolve")
    }
}
