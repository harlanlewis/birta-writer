import XCTest
@testable import BirtaWriterCore

/// The explorer's context menu, per kind of row.
final class ExplorerMenuTests: XCTestCase {
    private func actions(_ kind: ExplorerMenu.EntryKind) -> [ExplorerMenu.Action?] {
        ExplorerMenu.items(for: kind, name: "Drafts").map(\.action)
    }

    func testADocumentShouldOfferANewTabThenWhereItIsThenTheTrash() {
        XCTAssertEqual(actions(.document),
                       [.openInNewTab, nil, .revealInFinder, .copyPath, nil, .moveToTrash])
    }

    func testAFolderShouldOfferANoteInsideItAWindowOverItThenWhereItIsThenTheTrash() {
        XCTAssertEqual(actions(.folder),
                       [.newNoteInside, .openInNewWindow, nil, .revealInFinder, .copyPath, nil, .moveToTrash])
        XCTAssertEqual(ExplorerMenu.items(for: .folder, name: "Drafts").first?.title, "New Note in “Drafts”")
    }

    func testEveryKindShouldEndOnTheTrashBehindASeparator() {
        for kind in ExplorerMenu.EntryKind.allCases {
            XCTAssertEqual(actions(kind).suffix(2), [nil, .moveToTrash], "\(kind)")
        }
    }

    func testAFileTheEditorDoesNotOpenShouldOfferNoTab() {
        XCTAssertEqual(actions(.other), [.revealInFinder, .copyPath, nil, .moveToTrash])
    }

    func testEveryRowShouldEitherActOrSeparate() {
        var rows = 0
        for kind in ExplorerMenu.EntryKind.allCases {
            let items = ExplorerMenu.items(for: kind, name: "x")
            XCTAssertFalse(items.isEmpty, "\(kind) offers nothing")
            for item in items {
                rows += 1
                XCTAssertEqual(item.action == nil, item.title.isEmpty, "\(kind): \(item)")
            }
        }
        XCTAssertGreaterThan(rows, 10, "the sweep reached every kind's rows")
    }

    func testTheTrashConfirmationShouldNameTheFileAndLeadWithTheDestructiveButton() {
        let words = ExplorerMenu.trashConfirmation(name: "Notes.md")
        XCTAssertTrue(words.message.contains("“Notes.md”"))
        XCTAssertEqual(words.confirm, "Move to Trash")
        XCTAssertEqual(words.cancel, "Cancel")
        XCTAssertFalse(words.detail.isEmpty)
    }

    func testAFolderConfirmationShouldSayHowMuchGoesWithIt() {
        func message(_ items: Int, capped: Bool = false) -> String {
            ExplorerMenu.trashConfirmation(name: "Daily", contents: .folder(items: items, capped: capped)).message
        }
        XCTAssertEqual(message(0), "Move “Daily” to the Trash?")
        XCTAssertEqual(message(1), "Move “Daily” and the 1 item in it to the Trash?")
        XCTAssertEqual(message(14), "Move “Daily” and the 14 items in it to the Trash?")
        XCTAssertEqual(message(10_000, capped: true), "Move “Daily” and more than 10,000 items in it to the Trash?")
        XCTAssertEqual(ExplorerMenu.trashConfirmation(name: "Daily", contents: .file).message,
                       ExplorerMenu.trashConfirmation(name: "Daily").message)
    }
}
