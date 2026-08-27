import XCTest
@testable import BirtaWriterCore

final class FileIdentityTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("mac-identity-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testTheSamePathIsTheSameFile() throws {
        let file = dir.appendingPathComponent("Scratchpad.md")
        try AtomicFile.writeString("x", to: file)

        XCTAssertTrue(FileIdentity.sameFile(file, file))
    }

    func testTwoDifferentFilesAreNotTheSameFile() throws {
        let a = dir.appendingPathComponent("a.md")
        let b = dir.appendingPathComponent("b.md")
        try AtomicFile.writeString("x", to: a)
        try AtomicFile.writeString("x", to: b)

        XCTAssertFalse(FileIdentity.sameFile(a, b), "same bytes is not same file")
    }

    func testASymlinkedPathIsTheSameFile() throws {
        let real = dir.appendingPathComponent("real.md")
        try AtomicFile.writeString("x", to: real)
        let link = dir.appendingPathComponent("link.md")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)

        XCTAssertTrue(FileIdentity.sameFile(real, link), "a symlink names its target")
    }

    func testAnUnnormalizedPathIsTheSameFile() throws {
        let file = dir.appendingPathComponent("Scratchpad.md")
        try AtomicFile.writeString("x", to: file)
        let roundabout = dir.appendingPathComponent("sub/../Scratchpad.md")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("sub"),
                                                withIntermediateDirectories: true)

        XCTAssertTrue(FileIdentity.sameFile(file, roundabout))
    }

    func testTwoNamesForAFileThatDoesNotExistCompareByResolvedPath() throws {
        let a = dir.appendingPathComponent("gone.md")
        let b = dir.appendingPathComponent("sub/../gone.md")

        XCTAssertTrue(FileIdentity.sameFile(a, b), "no file to identify: resolved paths decide")
        XCTAssertFalse(FileIdentity.sameFile(a, dir.appendingPathComponent("other.md")))
    }
}
