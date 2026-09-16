import XCTest
@testable import BirtaWriterCore

/// The palette's list with no window: the modes, the order with nothing
/// typed, the ranking with something typed, groups, and recents.
final class PaletteModelTests: XCTestCase {
    private let bold = PaletteItem(id: "toggleBold", title: "Bold", detail: "⌘B", section: "Format", kind: .command)
    private let italic = PaletteItem(id: "toggleItalic", title: "Italic", detail: "⌘I", section: "Format", kind: .command)
    private let save = PaletteItem(id: "save", title: "Save a Copy As…", detail: "⇧⌘S", section: "File", kind: .command)
    private let notes = PaletteItem(id: "/n/notes.md", title: "notes.md", detail: "n", section: "Files", kind: .file)
    private let budget = PaletteItem(id: "/n/finance/budget.md", title: "budget.md", detail: "n/finance", section: "Files", kind: .file)
    private let window = PaletteItem(id: "w:/n/notes.md", title: "notes.md", section: "Windows", kind: .window)
    private let dock = PaletteItem(id: "showInDock", title: "Show in Dock", detail: "General", section: "Settings", kind: .setting)
    private lazy var styles = PaletteItem(id: "paragraphStyle", title: "Paragraph Style", section: "Format", kind: .group,
                                          children: [
                                              PaletteItem(id: "setHeading1", title: "Heading 1", section: "Format", kind: .command),
                                              PaletteItem(id: "setHeading2", title: "Heading 2", section: "Format", kind: .command),
                                          ])
    private lazy var all: [PaletteItem] = [bold, italic, save, styles, notes, budget, window, dock]

    private func titles(_ rows: [PaletteRow]) -> [String] { rows.map(\.title) }

    func testNothingTypedListsEverythingInOrderWithRecentsFirst() {
        let rows = PaletteModel.rank(all, query: "", mode: .all, recents: ["showInDock", "toggleItalic"])
        XCTAssertEqual(titles(rows).prefix(3).map { $0 }, ["Show in Dock", "Italic", "Bold"],
                       "the two picked lately lead, in the order picked; then the list as given")
        XCTAssertEqual(rows.count, all.count, "groups stay closed: one row, not their children")
        XCTAssertTrue(rows.allSatisfy { $0.matched.isEmpty })
    }

    func testFilesModeListsFilesAlone() {
        let rows = PaletteModel.rank(all, query: "", mode: .files, recents: [])
        XCTAssertEqual(titles(rows), ["notes.md", "budget.md"], "a window on notes.md is not a file to go to")
    }

    func testAQueryRanksTheBestMatchFirstAndDropsTheRest() {
        let rows = PaletteModel.rank(all, query: "bold", mode: .all, recents: [])
        XCTAssertEqual(titles(rows).first, "Bold")
        XCTAssertFalse(titles(rows).contains("Italic"))
        XCTAssertEqual(rows.first?.matched, [0..<4], "the letters drawn matched")
    }

    func testAQueryReachesIntoAGroupWithTheGroupsTitleInFront() {
        let rows = PaletteModel.rank(all, query: "head 2", mode: .all, recents: [])
        XCTAssertEqual(titles(rows).first, "Paragraph Style › Heading 2")
        XCTAssertEqual(rows.first?.item.id, "setHeading2", "the row IS the child, so picking it runs the child")
    }

    func testARecentPickOutranksAnEqualMatchAndNotABetterOne() {
        // Both rows match `b`: Bold on its first letter, Table Border on the
        // start of its second word, past a skipped word. The recent one is the
        // weaker match, and stays second.
        let border = PaletteItem(id: "tableBorder", title: "Table Border", section: "Format", kind: .command)
        let recent = PaletteModel.rank([bold, border], query: "b", mode: .all, recents: ["tableBorder"])
        XCTAssertEqual(titles(recent), ["Bold", "Table Border"], "a better match beats a recent weaker one")
        let tie = PaletteModel.rank([
            PaletteItem(id: "a", title: "Alpha", section: "S", kind: .command),
            PaletteItem(id: "b", title: "Alpine", section: "S", kind: .command),
        ], query: "alp", mode: .all, recents: ["b"])
        XCTAssertEqual(titles(tie).first, "Alpine", "recency decides between equals")
    }

    func testEqualMatchesKeepTheOrderTheListWasGivenIn() {
        let rows = PaletteModel.rank([
            PaletteItem(id: "z", title: "Zeta thing", section: "S", kind: .command),
            PaletteItem(id: "a", title: "Alpha thing", section: "S", kind: .command),
        ], query: "thing", mode: .all, recents: [])
        XCTAssertEqual(titles(rows), ["Zeta thing", "Alpha thing"], "the menu's order, not the alphabet's")
    }

    func testAFileMatchesOnItsFolderToo() {
        let rows = PaletteModel.rank(all, query: "finance", mode: .files, recents: [])
        XCTAssertEqual(titles(rows), ["budget.md"])
    }

    func testSectionsKeepTheOrderTheyFirstAppearIn() {
        let rows = PaletteModel.rank(all, query: "", mode: .all, recents: [])
        let sections = PaletteModel.sections(rows).map(\.section)
        XCTAssertEqual(sections, ["Format", "File", "Files", "Windows", "Settings"])
    }

    func testRecordingAPickMovesItToTheFrontAndCapsTheList() {
        var recents: [String] = []
        for index in 0..<(PaletteModel.recentsKept + 5) { recents = PaletteModel.recording("id\(index)", into: recents) }
        XCTAssertEqual(recents.count, PaletteModel.recentsKept)
        XCTAssertEqual(recents.first, "id\(PaletteModel.recentsKept + 4)")
        recents = PaletteModel.recording("id10", into: recents)
        XCTAssertEqual(recents.first, "id10")
        XCTAssertEqual(recents.filter { $0 == "id10" }.count, 1, "moved, not repeated")
    }
}
