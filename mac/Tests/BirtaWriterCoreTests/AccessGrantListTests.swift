import XCTest
@testable import BirtaWriterCore

/// The store channel's list of grants, with no sandbox: which paths a grant
/// reaches, what recording one does to the rest, and that the stored form
/// comes back as it went in.
final class AccessGrantListTests: XCTestCase {
    private func grant(_ path: String, _ byte: UInt8 = 1) -> AccessGrantList.Grant {
        .init(path: path, bookmark: Data([byte]))
    }

    func testAFolderGrantShouldCoverWhatIsInsideItAndNothingBesideIt() {
        let list = AccessGrantList().recording(grant("/notes"))
        XCTAssertTrue(list.covers("/notes"))
        XCTAssertTrue(list.covers("/notes/a.md"))
        XCTAssertTrue(list.covers("/notes/deep/b.md"))
        XCTAssertFalse(list.covers("/notes-old/a.md"), "a shared prefix is not a folder")
        XCTAssertFalse(list.covers("/"))
        XCTAssertFalse(AccessGrantList().covers("/notes"))
    }

    func testRecordingTheSamePathShouldReplaceRatherThanDuplicate() {
        let list = AccessGrantList().recording(grant("/a.md", 1)).recording(grant("/a.md", 2))
        XCTAssertEqual(list.grants, [grant("/a.md", 2)])
    }

    func testAFolderGrantShouldAbsorbTheGrantsItNowCovers() {
        let list = AccessGrantList()
            .recording(grant("/notes/a.md"))
            .recording(grant("/elsewhere/b.md"))
            .recording(grant("/notes"))
        XCTAssertEqual(list.grants.map(\.path), ["/notes", "/elsewhere/b.md"])
    }

    func testTheMostRecentShouldComeFirstAndTheOldestGoPastCapacity() {
        var list = AccessGrantList()
        for n in 0...AccessGrantList.capacity { list = list.recording(grant("/f\(n).md")) }
        XCTAssertEqual(list.grants.count, AccessGrantList.capacity)
        XCTAssertEqual(list.grants.first?.path, "/f\(AccessGrantList.capacity).md")
        XCTAssertFalse(list.covers("/f0.md"), "the oldest grant should be the one dropped")
    }

    func testRenewingShouldSwapTheBookmarkInPlace() {
        let list = AccessGrantList().recording(grant("/a.md")).recording(grant("/b.md"))
            .renewing("/a.md", bookmark: Data([9]))
        XCTAssertEqual(list.grants.map(\.path), ["/b.md", "/a.md"], "renewing is not a new grant")
        XCTAssertEqual(list.grants.last?.bookmark, Data([9]))
    }

    func testRemovingShouldDropOnlyThatPath() {
        let list = AccessGrantList().recording(grant("/a.md")).recording(grant("/b.md")).removing("/a.md")
        XCTAssertEqual(list.grants.map(\.path), ["/b.md"])
    }

    /// A folder reached through a link is the same folder, so its grant has
    /// to cover the same files.
    func testPathsShouldBeComparedResolvedAndWithoutATrailingSlash() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("real"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createSymbolicLink(at: dir.appendingPathComponent("link"),
                                                   withDestinationURL: dir.appendingPathComponent("real"))
        let list = AccessGrantList().recording(grant(dir.appendingPathComponent("link").path + "/"))
        XCTAssertTrue(list.covers(dir.appendingPathComponent("real/a.md").path))
    }

    func testTheStoredFormShouldRoundTripAndAnUnreadableOneShouldBeEmpty() {
        let list = AccessGrantList().recording(grant("/a.md")).recording(grant("/notes", 7))
        XCTAssertEqual(AccessGrantList.decoded(list.encoded()), list)
        XCTAssertEqual(AccessGrantList.decoded(nil), AccessGrantList())
        XCTAssertEqual(AccessGrantList.decoded(Data("not a plist".utf8)), AccessGrantList())
    }
}
