import XCTest
@testable import BirtaJotCore

final class AttachmentStoreTests: XCTestCase {
    private var dir: URL!
    private var document: URL!
    private let store = AttachmentStore()
    /// A one-pixel PNG, so the bytes are a real image rather than a string.
    private let png = Data(base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==")!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("jot-attach-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        document = dir.appendingPathComponent("Scratchpad.md")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: saving

    func testSaveWritesBesideTheDocumentAndReturnsARelativeReference() throws {
        let reference = try store.save(png, mimeType: "image/png", besideDocument: document)

        XCTAssertTrue(reference.hasPrefix("Attachments/"), reference)
        XCTAssertTrue(reference.hasSuffix(".png"), reference)
        XCTAssertFalse(reference.contains(dir.path), "a reference must never carry an absolute path")
        let written = dir.appendingPathComponent(reference)
        XCTAssertEqual(try Data(contentsOf: written), png)
    }

    func testTheSameBytesTwiceWriteOneFile() throws {
        let first = try store.save(png, mimeType: "image/png", besideDocument: document)
        let second = try store.save(png, mimeType: "image/png", besideDocument: document)

        XCTAssertEqual(first, second)
        let files = try FileManager.default.contentsOfDirectory(
            atPath: AttachmentStore.directory(forDocument: document).path)
        XCTAssertEqual(files, [String(first.dropFirst("Attachments/".count))])
    }

    func testDifferentBytesGetDifferentNames() throws {
        let other = png + Data([0x00])
        let a = try store.save(png, mimeType: "image/png", besideDocument: document)
        let b = try store.save(other, mimeType: "image/png", besideDocument: document)

        XCTAssertNotEqual(a, b)
    }

    func testTheExtensionFollowsTheMimeTypeNotTheBytes() throws {
        let reference = try store.save(png, mimeType: "image/gif", besideDocument: document)

        XCTAssertTrue(reference.hasSuffix(".gif"), reference)
    }

    func testAMimeTypeWithParametersIsStillRecognised() throws {
        let reference = try store.save(png, mimeType: "image/png; charset=binary", besideDocument: document)

        XCTAssertTrue(reference.hasSuffix(".png"), reference)
    }

    func testAnUnsupportedTypeIsRefusedRatherThanGuessed() throws {
        XCTAssertThrowsError(try store.save(png, mimeType: "application/pdf", besideDocument: document)) {
            XCTAssertEqual($0 as? AttachmentStore.StoreError, .unsupportedType("application/pdf"))
        }
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: AttachmentStore.directory(forDocument: document).path),
            "a refused save must not even create the folder")
    }

    func testEmptyBytesAreRefused() throws {
        XCTAssertThrowsError(try store.save(Data(), mimeType: "image/png", besideDocument: document)) {
            XCTAssertEqual($0 as? AttachmentStore.StoreError, .empty)
        }
    }

    func testTheFolderFollowsTheDocument() throws {
        let elsewhere = dir.appendingPathComponent("sub/Note.md")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("sub"),
                                                withIntermediateDirectories: true)

        _ = try store.save(png, mimeType: "image/png", besideDocument: elsewhere)

        XCTAssertTrue(FileManager.default.fileExists(
            atPath: dir.appendingPathComponent("sub/Attachments").path))
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: dir.appendingPathComponent("Attachments").path))
    }
}
