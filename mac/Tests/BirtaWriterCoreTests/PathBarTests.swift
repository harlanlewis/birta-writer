import XCTest
@testable import BirtaWriterCore

/// Where the path bar starts and what each segment says.
final class PathBarTests: XCTestCase {
    private let home = URL(fileURLWithPath: "/Users/ada")
    /// The file system's names, as `FileManager.displayName` would give them
    /// for the folders these cases cross; anything else is its last component.
    private func name(_ path: String) -> String {
        switch path {
        case "/": return "Macintosh HD"
        case "/Users/ada/Library/Mobile Documents/iCloud~md~obsidian": return "Obsidian"
        default: return (path as NSString).lastPathComponent
        }
    }

    private func segments(_ path: String) -> [PathSegment] {
        PathBar.segments(for: URL(fileURLWithPath: path), home: home, displayName: name)
    }

    func testAFileUnderHomeShouldStartAtTheHomeFolder() {
        let s = segments("/Users/ada/Notes/Today.md")
        XCTAssertEqual(s.map(\.name), ["ada", "Notes", "Today.md"])
        XCTAssertEqual(s.map(\.kind), [.home, .folder, .file])
        XCTAssertEqual(s.map(\.path), ["/Users/ada", "/Users/ada/Notes", "/Users/ada/Notes/Today.md"])
    }

    func testAFileInICloudDriveShouldStartAtICloudDriveAndHideTheContainer() {
        let s = segments("/Users/ada/Library/Mobile Documents/com~apple~CloudDocs/Drafts/a.md")
        XCTAssertEqual(s.map(\.name), ["iCloud Drive", "Drafts", "a.md"])
        XCTAssertEqual(s.first?.kind, .cloud)
        XCTAssertEqual(s.first?.path, "/Users/ada/Library/Mobile Documents/com~apple~CloudDocs")
    }

    func testAFileInAnAppContainerShouldNameTheAppAndFoldItsDocumentsFolder() {
        let s = segments("/Users/ada/Library/Mobile Documents/iCloud~md~obsidian/Documents/Harlan/Voice Notes/memo.md")
        XCTAssertEqual(s.map(\.name), ["iCloud Drive", "Obsidian", "Harlan", "Voice Notes", "memo.md"])
        XCTAssertEqual(s[1].path, "/Users/ada/Library/Mobile Documents/iCloud~md~obsidian/Documents")
    }

    func testAFileOutsideHomeShouldStartAtTheVolume() {
        let s = segments("/tmp/x.md")
        XCTAssertEqual(s.map(\.name), ["Macintosh HD", "tmp", "x.md"])
        XCTAssertEqual(s.first?.kind, .volume)
        XCTAssertEqual(s.first?.path, "/")
    }

    func testOnlyAPathTheBarDrewShouldBeRevealed() {
        let file = URL(fileURLWithPath: "/Users/ada/Notes/Today.md")
        XCTAssertTrue(PathBar.reveals("/Users/ada/Notes", for: file, home: home))
        XCTAssertTrue(PathBar.reveals("/Users/ada/Notes/Today.md", for: file, home: home))
        XCTAssertFalse(PathBar.reveals("/Users/ada/Secrets", for: file, home: home))
        XCTAssertFalse(PathBar.reveals("/Users", for: file, home: home), "above the root the bar starts at")
    }

    func testTheEllipsisMenuShouldListDeepestFirstAndDropPathsTheBarDidNotDraw() {
        let file = URL(fileURLWithPath: "/Users/ada/Notes/Drafts/Today.md")
        let rows = PathBar.menuRows([
            PathBarMenuEntry(name: "Notes", path: "/Users/ada/Notes"),
            PathBarMenuEntry(name: "Drafts", path: "/Users/ada/Notes/Drafts"),
            PathBarMenuEntry(name: "Elsewhere", path: "/etc"),
        ], for: file, home: home)
        XCTAssertEqual(rows.map(\.name), ["Drafts", "Notes"])
    }
}
