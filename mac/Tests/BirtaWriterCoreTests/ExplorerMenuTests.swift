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

    func testAFolderShouldOfferANoteInsideItAndNoTrash() {
        XCTAssertEqual(actions(.folder), [.newNoteInside, nil, .revealInFinder, .copyPath])
        XCTAssertEqual(ExplorerMenu.items(for: .folder, name: "Drafts").first?.title, "New Note in “Drafts”")
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
}
