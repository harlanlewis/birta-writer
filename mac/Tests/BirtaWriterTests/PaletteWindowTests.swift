import AppKit
import XCTest
@testable import BirtaWriter
import BirtaWriterCore

/// The command palette, built and read back without being shown (MAR-458).
///
/// Two halves. The catalog: what the app's own tables become as palette rows,
/// asked of the real `AppMenu` and `SettingsForm` so a row the menu bar
/// offers is a row the palette offers, under the same title, with the same
/// chord. The window: what typing, arrowing and picking do to the list, with
/// the panel never ordered front, which is the idiom the rest of this target
/// uses for windows.
@MainActor
final class PaletteWindowTests: XCTestCase {
    private var savedRecents: [String] = []
    private var picked: [PaletteAction] = []

    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
        // The recents a pick records are a preference, saved here and put back
        // after, as `BindingWalkTests` does for the bindings.
        savedRecents = Prefs.paletteRecents
        Prefs.paletteRecents = []
        picked = []
    }

    override func tearDown() {
        Prefs.paletteRecents = savedRecents
        super.tearDown()
    }

    // MARK: the catalog off the real tables

    /// The gate a window on a loose file with content answers: the explorer
    /// rows are dimmed there, everything else is live (`AppDelegate.allows`).
    private static let looseFileGate: (Selector) -> Bool = {
        $0 != #selector(AppDelegate.menuToggleExplorer) && $0 != #selector(AppDelegate.menuToggleHiddenFiles)
    }

    private func realCatalog() -> PaletteCatalog {
        var context = PaletteSources.Context(front: nil, allows: Self.looseFileGate)
        context.recents = [URL(fileURLWithPath: "/tmp/palette-tests/recent.md")]
        return PaletteSources.catalog(context)
    }

    private func flattened(_ items: [PaletteItem]) -> [PaletteItem] {
        items.flatMap { $0.kind == .group ? flattened($0.children) : [$0] }
    }

    func testEveryMenuRowShouldBeAPaletteRowUnderItsMenuWithItsChord() {
        let catalog = realCatalog()
        let rows = flattened(catalog.items)
        let bold = rows.first { $0.title == "Bold" }
        XCTAssertEqual(bold?.detail, "⌘B", "the chord the menu binds, in the symbols the menu draws")
        XCTAssertEqual(bold?.section, "Format")
        XCTAssertEqual(bold?.kind, .command)
        // Every row a menu offers and that runs something, less the two that
        // open the palette itself and the two that only a rooted window can
        // run.
        //
        // Matched by IDENTITY rather than by title, which is the difference
        // between asking whether a row reached the palette and asking what it
        // is called there. A toggle row is deliberately called something else
        // here (`title(of:)`), so a title-matched version of this reports
        // every one of them as missing, and would have to be taught each
        // retitling rule to stop; the id says nothing about the words and
        // answers the question this check is actually about.
        let runnable = AppMenu.rows.filter {
            switch $0.action {
            case .app, .command, .link: return true
            case .submenu, .recents, .themes: return false
            }
        }.filter { !["Command Palette…", "Go to File…", "Show Files", "Show Hidden Files"].contains($0.title) }
        XCTAssertGreaterThan(runnable.count, 20, "the menu table came back nearly empty, so nothing below is checked")
        let wanted = Set(runnable.map { "menu:" + $0.itemIdentifier.rawValue })
        let listed = Set(rows.filter { $0.id.hasPrefix("menu:") }.map(\.id))
        XCTAssertTrue(wanted.isSubset(of: listed),
                      "menu rows missing from the palette: \(wanted.subtracting(listed).sorted())")
        let titles = Set(rows.filter { $0.id.hasPrefix("menu:") }.map(\.title))
        XCTAssertFalse(titles.contains("Command Palette…"), "a palette that offers to open itself")
        XCTAssertFalse(titles.contains("Hide Files"), "an explorer row in a window with no explorer")
    }

    func testARowTheMenuBarWouldDimShouldNotBeOffered() {
        // The gate is the app's, handed in; what the catalog owns is asking it
        // for every row that has a selector, the editor commands included.
        var asked = Set<Selector>()
        let context = PaletteSources.Context(front: nil, allows: { selector in
            asked.insert(selector)
            return selector != #selector(AppDelegate.menuSaveAs) && selector != #selector(AppDelegate.menuRunEditorCommand(_:))
        })
        let titles = flattened(PaletteSources.catalog(context).items).map(\.title)
        XCTAssertFalse(titles.contains("Save a Copy As…"), "dimmed for a window with nothing to save")
        XCTAssertFalse(titles.contains("Bold"), "every editor command shares one selector, refused as one")
        XCTAssertTrue(titles.contains("New Note"))
        XCTAssertTrue(asked.contains(#selector(AppDelegate.menuNewNote)), "the gate was asked, not assumed")
        // With everything allowed the explorer rows come back: nothing in the
        // catalog itself decides they need a root.
        let open = PaletteSources.Context(front: nil, allows: { _ in true })
        XCTAssertTrue(flattened(PaletteSources.catalog(open).items).map(\.title).contains("Hide Files"))
    }

    func testASubmenuShouldBeAGroupHoldingItsRowsAndPickingAChildRunsTheChild() {
        let catalog = realCatalog()
        let find = catalog.items.first { $0.title == "Find" && $0.section == "Edit" }
        XCTAssertEqual(find?.kind, .group)
        XCTAssertEqual(find?.children.first?.title, "Find…")
        guard let child = find?.children.first, case let .menu(row)? = catalog.action(for: child.id) else {
            return XCTFail("the child row's action is the menu row it came from")
        }
        XCTAssertEqual(row.action.commandId, "openFind")
    }

    func testAGatedRowShouldNotBeOfferedWhileItsGateIsOff() {
        var off = PaletteSources.Context(front: nil, allows: Self.looseFileGate)
        off.menuState = MenuState(proofreadOptions: ["proofreading": false])
        let withGateOff = flattened(PaletteSources.catalog(off).items).map(\.title)
        XCTAssertFalse(withGateOff.contains("Check Spelling"), "withdrawn as the menu withdraws it")
        XCTAssertFalse(withGateOff.contains("Stop Checking Spelling"), "withdrawn under either name")
        XCTAssertTrue(withGateOff.contains("Turn On Proofreading"),
                      "the gate itself stays reachable, under what picking it does")
        // Every proofreading option ships ON and an absent key is on
        // (`MenuState.isOn`), so with the gate back the check is running and
        // the row is what stops it.
        let withGateOn = flattened(realCatalog().items).map(\.title)
        XCTAssertTrue(withGateOn.contains("Stop Checking Spelling"))
    }

    func testARowThatRenamesItselfShouldBeOfferedUnderWhatPickingItDoes() {
        var shown = PaletteSources.Context(front: nil, allows: Self.looseFileGate)
        shown.menuState = MenuState(tocShown: true)
        XCTAssertTrue(flattened(PaletteSources.catalog(shown).items).map(\.title).contains("Hide Table of Contents"))
        XCTAssertTrue(flattened(realCatalog().items).map(\.title).contains("Show Table of Contents"),
                      "hidden by default in this context")
    }

    /// A row the MENU says with a checkmark has no checkmark here, so it says
    /// what picking it does instead.
    ///
    /// Both states, because one alone is satisfied by a row whose title never
    /// moves: a build that ignored the state entirely would pass whichever
    /// half happened to match the default.
    func testACheckmarkRowShouldBeOfferedUnderWhatPickingItDoes() {
        var on = PaletteSources.Context(front: nil, allows: Self.looseFileGate)
        on.menuState = MenuState(lineNumbers: true)
        let whenOn = flattened(PaletteSources.catalog(on).items).map(\.title)
        XCTAssertTrue(whenOn.contains("Hide Line Numbers"), "the gutter is up, so the row takes it away")
        XCTAssertFalse(whenOn.contains("Show Line Numbers"))

        let whenOff = flattened(realCatalog().items).map(\.title)
        XCTAssertTrue(whenOff.contains("Show Line Numbers"), "off by default in this context")
        XCTAssertFalse(whenOff.contains("Hide Line Numbers"))

        // And a row whose own name is what it does keeps it, rather than being
        // wrapped in a verb: the three checks are imperatives already. Both
        // states again, and the OFF one has to be asked for, because every
        // proofreading option ships on (`MenuState.isOn`).
        XCTAssertTrue(whenOff.contains("Stop Checking Spelling"), "running by default")
        var quiet = PaletteSources.Context(front: nil, allows: Self.looseFileGate)
        quiet.menuState = MenuState(proofreadOptions: ["spellCheck": false, "passive": false])
        let whenQuiet = flattened(PaletteSources.catalog(quiet).items).map(\.title)
        XCTAssertTrue(whenQuiet.contains("Check Spelling"), "not \"Turn On Check Spelling\"")

        // A style category names the thing it FLAGS, so the palette supplies
        // the verb rather than appearing to turn the thing itself on.
        XCTAssertTrue(whenQuiet.contains("Check for Passive voice"), "not \"Turn On Passive voice\"")
        XCTAssertTrue(whenOff.contains("Stop Checking for Passive voice"))
        XCTAssertFalse(whenOff.contains("Passive voice"), "the bare label says nothing about the check")
    }

    /// A settings row says which pane it is in AND that it is a setting.
    ///
    /// Matched on a query there is no section heading over the row, so
    /// "General › Show in Dock" reads as a command called General. Asked of
    /// the ROWS the model returns for a query rather than of the catalog,
    /// because the crumb is the model's to build and the catalog holds only
    /// the nesting it is built from.
    func testASettingsRowShouldBeFoundUnderSettingsAndItsPane() {
        let rows = PaletteModel.rank(realCatalog().items, query: "show in dock", mode: .all, recents: [])
        XCTAssertEqual(rows.first?.title, "Settings › General › Show in Dock",
                       rows.prefix(3).map(\.title).description)
    }

    func testSettingsShouldBeOneGroupPerPaneNamedAsTheWindowNamesThem() {
        let catalog = realCatalog()
        let groups = catalog.items.filter { $0.section == PaletteSources.settingsSection }
        XCTAssertEqual(groups.map(\.title), ["General", "Markdown", "Appearance", "AI Agent", "Advanced"])
        XCTAssertEqual(groups.map(\.title), SettingsWindowController.paneTitles,
                       "the groups say what the window's toolbar says, in its order")
        XCTAssertEqual(PaletteSources.settingsPanes.count, SettingsWindowController.paneNames.count,
                       "a pane with no form under it, or a form with no pane to open")
        let every = Set(groups.flatMap(\.children).map(\.title))
        XCTAssertEqual(every, Set(SettingsForm.allRows.map(\.rawValue)), "every Settings row, each once")
        guard let dock = groups.flatMap(\.children).first(where: { $0.title == SettingsRow.showInDock.rawValue }),
              case let .setting(pane, row)? = catalog.action(for: dock.id) else {
            return XCTFail("a Settings row's action opens its pane")
        }
        XCTAssertEqual(pane, "general")
        XCTAssertEqual(row, .showInDock)
    }

    func testPageCommandsShouldJoinOnlyWhereNoMenuRowNamesTheCommand() {
        var context = PaletteSources.Context(front: nil, allows: Self.looseFileGate)
        context.pageCommands = [
            PaletteCommand(id: "toggleBold", title: "Bold", section: "Format"),
            PaletteCommand(id: "editFrontmatterFromPage", title: "Edit Frontmatter (page)", section: "Editor"),
        ]
        let rows = flattened(PaletteSources.catalog(context).items)
        XCTAssertEqual(rows.filter { $0.title == "Bold" }.count, 1, "the menu's Bold, once, with its chord")
        let page = rows.first { $0.id == "command:editFrontmatterFromPage" }
        XCTAssertEqual(page?.section, "Editor")
        guard case let .pageCommand(id)? = PaletteSources.catalog(context).action(for: page?.id ?? "") else {
            return XCTFail("a page command runs through the page")
        }
        XCTAssertEqual(id, "editFrontmatterFromPage")
    }

    func testFilesShouldComeFromTheRootIndexInARootedWindowWithTheFolderAsDetail() {
        var context = PaletteSources.Context(front: nil, allows: Self.looseFileGate)
        context.root = URL(fileURLWithPath: "/tmp/palette-tests/root", isDirectory: true)
        context.rootIndex = FileIndex(paths: ["a.md", "sub/deep/b.md"], truncated: true)
        context.recents = [URL(fileURLWithPath: "/elsewhere/c.md")]
        let catalog = PaletteSources.catalog(context)
        let files = catalog.items.filter { $0.kind == .file }
        XCTAssertEqual(files.map(\.title), ["a.md", "b.md", "c.md"], "the root's files first, then a recent outside it")
        XCTAssertEqual(files.map(\.detail), [nil, "sub/deep", "elsewhere"])
        XCTAssertTrue(catalog.filesTruncated)
        XCTAssertNil(catalog.items.first { $0.title == "Open Recent" }, "recents are file rows, listed once")
        guard case let .file(url)? = catalog.action(for: files[1].id) else { return XCTFail("a file row opens the file") }
        XCTAssertEqual(url.path, "/tmp/palette-tests/root/sub/deep/b.md")
    }

    func testFilesShouldBeTheNotesFolderThenTheRecentsElsewhere() {
        var context = PaletteSources.Context(front: nil, allows: Self.looseFileGate)
        context.notesFolder = URL(fileURLWithPath: "/tmp/palette-tests/notes", isDirectory: true)
        context.notesIndex = FileIndex(paths: ["today.md"], truncated: false)
        context.recents = [URL(fileURLWithPath: "/tmp/palette-tests/notes/today.md"),
                           URL(fileURLWithPath: "/elsewhere/c.md")]
        let files = PaletteSources.catalog(context).items.filter { $0.kind == .file }
        XCTAssertEqual(files.map(\.title), ["today.md", "c.md"], "a recent already in the folder is not listed twice")
    }

    func testWithNoIndexYetTheFileSectionShouldHoldOnlyTheRecents() {
        var context = PaletteSources.Context(front: nil, allows: Self.looseFileGate)
        context.root = URL(fileURLWithPath: "/tmp/palette-tests/root", isDirectory: true)
        context.rootIndex = nil
        context.recents = [URL(fileURLWithPath: "/elsewhere/c.md")]
        XCTAssertEqual(PaletteSources.catalog(context).items.filter { $0.kind == .file }.map(\.title), ["c.md"],
                       "nothing from a folder that has not been walked yet, rather than a wrong list")
    }

    // MARK: the window

    private func fixture() -> PaletteCatalog {
        var catalog = PaletteCatalog()
        let bold = AppMenu.rows.first { $0.title == "Bold" }!
        catalog.add(PaletteItem(id: "menu:bold", title: "Bold", detail: "⌘B", section: "Format", kind: .command),
                    does: .menu(bold))
        catalog.add(PaletteItem(id: "menu:italic", title: "Italic", detail: "⌘I", section: "Format", kind: .command),
                    does: .menu(AppMenu.rows.first { $0.title == "Italic" }!))
        catalog.add(PaletteItem(id: "file:/n/a.md", title: "a.md", section: "Files", kind: .file),
                    does: .file(URL(fileURLWithPath: "/n/a.md")))
        catalog.add(PaletteItem(id: "settings:general", title: "General", section: "Settings", kind: .group, children: [
            PaletteItem(id: "setting:dock", title: "Show in Dock", section: "Settings", kind: .setting),
        ]), does: nil)
        catalog.register(.setting(pane: "general", row: .showInDock), for: "setting:dock")
        return catalog
    }

    private func palette() -> PaletteWindowController {
        let catalog = fixture()
        return PaletteWindowController(catalog: { catalog }, onPick: { [weak self] in self?.picked.append($0) })
    }

    func testNothingTypedShouldListEverySectionUnderAHeadingWithTheFirstRowSelected() {
        let palette = palette()
        palette.prepare(mode: .all)
        XCTAssertEqual(palette.headers, ["Format", "Files", "Settings"])
        XCTAssertEqual(palette.rows.map(\.title), ["Bold", "Italic", "a.md", "General"])
        XCTAssertEqual(palette.selectedRow?.title, "Bold")
        XCTAssertFalse(palette.isOpen, "prepared, never shown")
    }

    func testTypingShouldRankTheBestMatchFirstAndDropTheHeadings() {
        let palette = palette()
        palette.prepare(mode: .all)
        palette.setQuery("ital")
        XCTAssertEqual(palette.headers, [])
        XCTAssertEqual(palette.rows.map(\.title), ["Italic"])
        XCTAssertEqual(palette.rows.first?.item.detail, "⌘I")
        XCTAssertEqual(palette.selectedRow?.title, "Italic")
    }

    func testFilesModeShouldListFilesAloneAndTheChordShouldSwitchIt() {
        let palette = palette()
        palette.prepare(mode: .files)
        XCTAssertEqual(palette.rows.map(\.title), ["a.md"])
        palette.switchMode(.all)
        XCTAssertEqual(palette.rows.count, 4)
    }

    func testArrowsShouldSkipHeadingsAndStopAtTheEnds() {
        let palette = palette()
        palette.prepare(mode: .all)
        palette.moveSelection(by: 1)
        XCTAssertEqual(palette.selectedRow?.title, "Italic")
        palette.moveSelection(by: 1)
        XCTAssertEqual(palette.selectedRow?.title, "a.md", "past the Files heading, not onto it")
        palette.moveSelection(by: 1)
        palette.moveSelection(by: 1)
        XCTAssertEqual(palette.selectedRow?.title, "General", "the end holds")
        palette.selectFirst()
        XCTAssertEqual(palette.selectedRow?.title, "Bold")
        palette.moveSelection(by: -1)
        XCTAssertEqual(palette.selectedRow?.title, "Bold", "the start holds")
    }

    func testPickingAGroupShouldOpenALevelAndBackspaceOnAnEmptyFieldShouldGoBackUp() {
        let palette = palette()
        palette.prepare(mode: .all)
        palette.selectLast()
        palette.pickSelected()
        XCTAssertEqual(palette.levelTitles, ["General"])
        XCTAssertEqual(palette.rows.map(\.title), ["Show in Dock"])
        XCTAssertTrue(picked.isEmpty, "opening a level runs nothing")
        XCTAssertTrue(palette.goUp())
        XCTAssertEqual(palette.levelTitles, [])
        XCTAssertFalse(palette.goUp(), "the top has nothing above it")
    }

    func testAQueryShouldReachIntoAGroupAndPickingTheChildRunsIt() {
        let palette = palette()
        palette.prepare(mode: .all)
        palette.setQuery("dock")
        XCTAssertEqual(palette.rows.map(\.title), ["General › Show in Dock"])
        palette.pickSelected()
        guard case let .setting(pane, row)? = picked.first else { return XCTFail("the child's action ran") }
        XCTAssertEqual(pane, "general")
        XCTAssertEqual(row, .showInDock)
        XCTAssertEqual(Prefs.paletteRecents, ["setting:dock"], "the pick is remembered by the child's id")
    }

    func testARecentPickShouldLeadItsSectionNextTime() {
        let palette = palette()
        palette.prepare(mode: .all)
        palette.moveSelection(by: 1)
        palette.pickSelected()
        guard case .menu? = picked.first else { return XCTFail("Italic runs as its menu row") }
        palette.prepare(mode: .all)
        XCTAssertEqual(palette.rows.first?.title, "Italic")
    }

    func testTheFooterHintsShouldSitInTheMiddleOfTheirBandNotAgainstTheRule() throws {
        let palette = palette()
        palette.prepare(mode: .all)
        let air = try XCTUnwrap(palette.footerAirForMeasurement)
        XCTAssertGreaterThan(air.above, 3, "the hints are against the rule: \(air)")
        // The rule box is a few points tall around its one-point line, so
        // the two halves differ by that much and no more.
        XCTAssertEqual(air.above, air.below, accuracy: 3, "the air is not shared evenly above and below: \(air)")
    }

    func testNoMatchShouldSayNoMatchAndSelectNothing() {
        let palette = palette()
        palette.prepare(mode: .all)
        palette.setQuery("zzzz")
        XCTAssertEqual(palette.rows, [])
        XCTAssertEqual(palette.displayed, [.empty("No matches")])
        XCTAssertNil(palette.selectedRow)
        palette.pickSelected()
        XCTAssertTrue(picked.isEmpty)
    }

    func testAChordShouldSplitIntoOneCapPerModifierAndOneForTheKey() {
        XCTAssertEqual(PaletteCellView.keyCaps("⇧⌘K"), ["⇧", "⌘", "K"])
        XCTAssertEqual(PaletteCellView.keyCaps("⌘/"), ["⌘", "/"])
        XCTAssertEqual(PaletteCellView.keyCaps("⌃J"), ["⌃", "J"])
        XCTAssertEqual(PaletteCellView.keyCaps("F5"), ["F5"], "a key of several characters stays one cap")
    }

    /// The palette's own width, which is what a row is laid out at.
    private static let rowWidth = PaletteWindowController.width

    /// One cell, filled and laid out at that width.
    ///
    /// The width is a CONSTRAINT rather than a frame, which is the difference
    /// between asking the layout a question and letting it answer a different
    /// one: a cell whose width is only a frame is free to grow to whatever its
    /// contents want, and every share measured against it then comes back
    /// correct on a row a foot wide. A table gives its cell a real width, and
    /// so does this.
    private func laidOutCell(title: String, detail: String?) -> PaletteCellView {
        let cell = PaletteCellView()
        cell.show(PaletteRow(item: PaletteItem(id: title, title: title, detail: detail,
                                               section: "Files", kind: .file),
                             title: title, matched: [0..<1], score: 1))
        cell.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            cell.widthAnchor.constraint(equalToConstant: Self.rowWidth),
            cell.heightAnchor.constraint(equalToConstant: 32),
        ])
        cell.layoutSubtreeIfNeeded()
        return cell
    }

    func testALongFolderShouldTruncateRatherThanEraseTheFileName() {
        let deep = "Work (shared)/Notable/03-People/Team Members/exited/Anna Santiago/2025-08 MYR"
        let boxes = laidOutCell(title: "Anna Santiago Worklog.md", detail: deep)
            .labelBoxesForMeasurement()
        // The name is what the query matched, so it is the half that keeps
        // its width: the path has a ceiling and gives way first. The failure
        // this is here for is a title compressed to nothing, which draws a
        // row with a folder on it and no file name at all.
        XCTAssertGreaterThan(boxes.title.width, 200,
                             "the folder squeezed the file name: \(boxes)")
        // The ceiling is on the box Auto Layout governs, which is a text
        // field's alignment rect; the frame read back here is a point or two
        // wider on each side of it, and the slack is that and nothing more.
        XCTAssertLessThanOrEqual(boxes.detail.width, Self.rowWidth * PaletteCellView.detailShare + 6,
                                 "the folder took more than its share: \(boxes)")
        XCTAssertGreaterThan(boxes.detail.width, 0, "the folder is not drawn at all: \(boxes)")
    }

    func testALongNameShouldNotEraseTheFolderEither() {
        // The mirror of the case above, and the reason the path holds a floor
        // as well as a ceiling: with the name winning every squeeze and
        // nothing under the path, a long enough name is the same defect
        // wearing the other label.
        let long = "Agentic Platform — Support and Monitoring User Journeys and Runbooks.md"
        let boxes = laidOutCell(title: long, detail: "Work (shared)/Notable/02-Projects")
            .labelBoxesForMeasurement()
        XCTAssertGreaterThan(boxes.detail.width, 100, "the name squeezed the folder away: \(boxes)")
        XCTAssertGreaterThan(boxes.title.width, 200, "and the name still has most of the row: \(boxes)")
    }

    func testALongNameShouldStayOnOneLineAndSayItWasCut() {
        let long = "Agentic Platform — Support and Monitoring User Journeys and Runbooks.md"
        // With a folder beside it, which is the case this is about: the name
        // is then in a box narrower than it needs, and what a box narrower
        // than the string does to it is the whole question.
        let cell = laidOutCell(title: long, detail: "Work (shared)/Notable/02-Projects/Agentic Platform")
        let drawn = cell.titleDrawnHeightForMeasurement()
        let boxes = cell.labelBoxesForMeasurement()
        // A row is one line tall, so a title that wrapped would have its
        // second line drawn outside the row and its tail cut away with
        // nothing on screen to say so. Measured against the font's own line
        // rather than a number written here.
        XCTAssertLessThanOrEqual(drawn, PaletteCellView.titleLineHeight + 1,
                                 "the title wrapped: \(drawn) in one line of \(PaletteCellView.titleLineHeight)")
        // The arm that says the check above can fail at all, and that this
        // case really is a name in too small a box: the same string in the
        // same box under the default style, which is what a field lays an
        // attributed value out under when the value carries none, comes back
        // taller than one line.
        let plain = NSAttributedString(string: long, attributes: [.font: NSFont.systemFont(ofSize: 13)])
        let box = CGSize(width: boxes.title.width, height: CGFloat.greatestFiniteMagnitude)
        let wrapped = plain.boundingRect(with: box,
                                         options: [.usesLineFragmentOrigin, .usesFontLeading]).height
        XCTAssertGreaterThan(wrapped, PaletteCellView.titleLineHeight + 1,
                             "the name fits its box, so nothing here is about wrapping: \(boxes)")
    }

    func testTheTitleShouldCarryTheStyleThatTruncatesIt() {
        // The field's own `lineBreakMode` is inert for an attributed value,
        // so the style has to ride the string. Nothing about the drawing says
        // which of the two was read, which is why this asks the string.
        let drawn = PaletteCellView.emphasised("A very long name indeed.md", at: [0..<1])
        let style = drawn.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
        XCTAssertEqual(style?.lineBreakMode, .byTruncatingTail)
    }

    func testTheMatchedLettersShouldBeDrawnHeavier() {
        let drawn = PaletteCellView.emphasised("Italic", at: [0..<4])
        var bold = 0
        drawn.enumerateAttribute(.font, in: NSRange(location: 0, length: drawn.length)) { value, range, _ in
            if let font = value as? NSFont, font.fontDescriptor.symbolicTraits.contains(.bold) { bold += range.length }
        }
        XCTAssertEqual(bold, 4)
    }
}
