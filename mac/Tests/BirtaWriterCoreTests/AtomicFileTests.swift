import XCTest
@testable import BirtaWriterCore

final class AtomicFileTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("mac-tests-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testWriteCreatesDirectoryFileAndLeavesNoTemp() throws {
        let target = dir.appendingPathComponent("nested/Scratchpad.md")
        try AtomicFile.writeString("# hi\n", to: target)
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "# hi\n")
        let siblings = try FileManager.default.contentsOfDirectory(atPath: target.deletingLastPathComponent().path)
        XCTAssertEqual(siblings, ["Scratchpad.md"], "no temp file may survive a successful write")
        let attrs = try FileManager.default.attributesOfItem(atPath: target.path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testReplaceIsAllOrNothing() throws {
        let target = dir.appendingPathComponent("Scratchpad.md")
        try AtomicFile.writeString("old", to: target)
        // A large payload, so a non-atomic writer would expose a prefix.
        let big = String(repeating: "x", count: 4 << 20)
        let group = DispatchGroup()
        var seen = Set<Int>()
        let lock = NSLock()
        group.enter()
        DispatchQueue.global().async {
            for _ in 0..<200 {
                if let s = try? String(contentsOf: target, encoding: .utf8) {
                    lock.lock(); seen.insert(s.count); lock.unlock()
                }
            }
            group.leave()
        }
        try AtomicFile.writeString(big, to: target)
        group.wait()
        // The reader saw only whole files: 3 bytes or 4 MiB, nothing between.
        XCTAssertTrue(seen.isSubset(of: [3, big.count]), "partial file observed: \(seen)")
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8).count, big.count)
    }

    func testCoalescingWriterKeepsOnlyTheNewest() throws {
        let target = dir.appendingPathComponent("Scratchpad.md")
        var errors: [Error] = []
        let w = CoalescingWriter(onError: { errors.append($0) })
        for i in 0..<500 { w.submit("v\(i)", to: target) }
        w.drain()
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "v499")
        XCTAssertTrue(errors.isEmpty)
        // Far fewer writes than submissions: the point of coalescing.
        XCTAssertLessThan(w.writeCount, 500)
        XCTAssertGreaterThan(w.writeCount, 0)
    }

    // -- Writing a file the user already had -----------------------------
    //
    // Rename-over-target replaces rather than updates, so an existing file
    // would otherwise come back with a new inode, this process's mode, and, if
    // it was a symlink, as a regular file. These pin the three rules that make
    // it behave like an edit. Each asserts the file system's own facts (mode,
    // inode, mtime, link-ness) rather than only the bytes, because the bytes
    // were never the thing at risk.

    /// The target's inode, mode and mtime, as one reading.
    private func identity(_ url: URL) throws -> (inode: UInt64, mode: Int, mtime: Date) {
        let a = try FileManager.default.attributesOfItem(atPath: url.path)
        return (
            (a[.systemFileNumber] as! NSNumber).uint64Value,
            (a[.posixPermissions] as! NSNumber).intValue,
            a[.modificationDate] as! Date
        )
    }

    func testCreatingAFileStillUsesThePrivateDefault() throws {
        let target = dir.appendingPathComponent("new.md")
        XCTAssertTrue(try AtomicFile.writeString("hello\n", to: target))
        let attrs = try FileManager.default.attributesOfItem(atPath: target.path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600,
                       "a file this app creates is private by default")
    }

    func testAnExistingFileKeepsItsMode() throws {
        let target = dir.appendingPathComponent("theirs.md")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try "one\n".write(to: target, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: target.path)

        XCTAssertTrue(try AtomicFile.writeString("two\n", to: target))

        XCTAssertEqual(try identity(target).mode, 0o644,
                       "a file the user already had must not be tightened to 0600 by an edit")
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "two\n")
    }

    func testAnExistingFileKeepsAnUnusualMode() throws {
        // 0644 is also what a fresh file would get from a default umask, so it
        // cannot distinguish "preserved" from "happened to match". 0755 can.
        let target = dir.appendingPathComponent("exec.md")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try "one\n".write(to: target, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: target.path)
        try AtomicFile.writeString("two\n", to: target)
        XCTAssertEqual(try identity(target).mode, 0o755)
    }

    func testWritingIdenticalContentTouchesNothing() throws {
        let target = dir.appendingPathComponent("same.md")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try AtomicFile.writeString("unchanged\n", to: target)
        let before = try identity(target)

        // A dismiss with no edit: the same bytes, submitted again.
        Thread.sleep(forTimeInterval: 0.02) // so a rewrite would move mtime
        XCTAssertFalse(try AtomicFile.writeString("unchanged\n", to: target),
                       "an unchanged document reports that it wrote nothing")

        let after = try identity(target)
        XCTAssertEqual(after.inode, before.inode, "an unchanged document must not be replaced")
        XCTAssertEqual(after.mtime, before.mtime, "an unchanged document must not be touched")
        XCTAssertEqual(after.mode, before.mode)
    }

    func testAContentChangeOfTheSameLengthIsStillWritten() throws {
        // The skip checks size first. A same-length edit is the case that would
        // survive a size-only comparison, so it is the one worth pinning.
        let target = dir.appendingPathComponent("samelength.md")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try AtomicFile.writeString("aaaa\n", to: target)
        XCTAssertTrue(try AtomicFile.writeString("bbbb\n", to: target))
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "bbbb\n")
    }

    func testWritingThroughASymlinkKeepsTheLink() throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let real = dir.appendingPathComponent("real.md")
        let link = dir.appendingPathComponent("link.md")
        try "one\n".write(to: real, atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: real.path)

        try AtomicFile.writeString("two\n", to: link)

        // attributesOfItem follows the link, so ask the link itself.
        let isStillLink = (try? FileManager.default.destinationOfSymbolicLink(atPath: link.path)) != nil
        XCTAssertTrue(isStillLink, "the link must survive as a link, not be replaced by a regular file")
        XCTAssertEqual(try String(contentsOf: real, encoding: .utf8), "two\n",
                       "the bytes must land on the file the link points at")
        XCTAssertEqual(try identity(real).mode, 0o644,
                       "the target's mode is preserved through the link too")
        // Deliberately NOT asserted: that the target keeps its inode. Replacing
        // by rename is what makes the write atomic, and a new inode is the price
        // of that; it is why an edit still breaks a hard link. Only the
        // unchanged-content skip above leaves an inode alone, and it does so by
        // not writing at all. An earlier draft of this test asserted inode
        // preservation here and failed, which is the assertion being wrong
        // rather than the code.
    }

    func testCoalescingWriterDoesNotCountAWriteItSkipped() throws {
        let target = dir.appendingPathComponent("skip.md")
        var errors: [Error] = []
        let w = CoalescingWriter(onError: { errors.append($0) })
        w.submit("same", to: target)
        w.drain()
        let afterFirst = w.writeCount
        XCTAssertEqual(afterFirst, 1)
        for _ in 0..<20 { w.submit("same", to: target) }
        w.drain()
        XCTAssertEqual(w.writeCount, afterFirst, "resubmitting identical content writes nothing")
        XCTAssertTrue(errors.isEmpty)
    }

    func testCoalescingWriterReportsErrors() {
        var errors: [Error] = []
        let w = CoalescingWriter(onError: { errors.append($0) })
        // A directory where a file is required: the write fails, the error surfaces.
        try? FileManager.default.createDirectory(at: dir.appendingPathComponent("isdir"), withIntermediateDirectories: true)
        w.submit("x", to: dir.appendingPathComponent("isdir"))
        w.drain()
        XCTAssertEqual(errors.count, 1)
    }
}
