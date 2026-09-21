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

    /// What the writer landed, which is the only honest answer to "what does
    /// the file hold now" for a caller whose write happens after `submit`
    /// returns (`Coordinator.takeWriterBaseline`).
    func testCoalescingWriterReportsTheBytesAndStampItLanded() throws {
        let target = dir.appendingPathComponent("landed.md")
        let w = CoalescingWriter(onError: { _ in })
        XCTAssertNil(w.lastLanded(for: target), "nothing has been written yet")
        w.submit("landed text", to: target)
        w.drain()
        let landed = try XCTUnwrap(w.lastLanded(for: target))
        XCTAssertEqual(landed.content, "landed text")
        XCTAssertEqual(landed.stamp, DiskStamp.of(target))
        XCTAssertNil(w.lastLanded(for: dir.appendingPathComponent("other.md")),
                     "the answer is about one file")
    }

    /// The stamp a write reports is the file it PUBLISHED, not whatever is at
    /// the path once it has published it.
    ///
    /// The two are the same except in one window, and that window is the whole
    /// point: another program replacing the file between our rename and a stat
    /// of the path hands back its file as ours, the baseline then matches the
    /// disk, and the next write goes over bytes nobody has read. Same-size
    /// bytes, because a length check is what a stat-afterwards design reaches
    /// for and it does not catch this.
    ///
    /// Driven through `afterPublishForTests`, since the window is inside the
    /// write and a check standing outside it cannot tell the two designs
    /// apart.
    func testAWriteReportsTheFileItPublishedRatherThanThePathAfterwards() throws {
        let target = dir.appendingPathComponent("published.md")
        let ours = "ours!!-0001"
        let theirs = "theirs-0002"
        XCTAssertEqual(ours.utf8.count, theirs.utf8.count)
        try AtomicFile.writeString("before", to: target)
        var replaced = false
        AtomicFile.afterPublishForTests = {
            guard !replaced else { return }
            replaced = true
            try? AtomicFile.writeString(theirs, to: target)
        }
        defer { AtomicFile.afterPublishForTests = nil }
        let result = try AtomicFile.writeStringReporting(ours, to: target)
        XCTAssertTrue(replaced, "the window was entered; without that this test asserts nothing")
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), theirs,
                       "their write is the one on disk now")
        let stamp = try XCTUnwrap(result.stamp)
        XCTAssertNotEqual(stamp, DiskStamp.of(target),
                          "reporting the path's stamp would call their file ours")
        XCTAssertEqual(stamp.size, ours.utf8.count)
    }

    /// Undisturbed, the two ways of asking agree, which is what lets a stamp
    /// from a write be compared with a stamp from a path at all.
    func testAnUndisturbedWriteReportsTheStampThePathHas() throws {
        let target = dir.appendingPathComponent("agree.md")
        let result = try AtomicFile.writeStringReporting("some text", to: target)
        XCTAssertEqual(result.stamp, DiskStamp.of(target))
        XCTAssertTrue(result.wrote)
        // The skip path describes the file that already held the bytes.
        let again = try AtomicFile.writeStringReporting("some text", to: target)
        XCTAssertFalse(again.wrote)
        XCTAssertEqual(again.stamp, DiskStamp.of(target))
    }

    /// `isIdle` is a fact about NOW: false while a write is on the queue, true
    /// once it has landed.
    ///
    /// It is what a caller asks when it must not block and still wants the
    /// answer where there is nothing to wait for, and the "once it has landed"
    /// half is the load-bearing one. A predicate that stayed false after the
    /// write finished would be a latch, and a caller declining on a latch
    /// declines for ever: that is the shape of the defect this writer's two
    /// callers (`Coordinator.reconcileWithDisk`, `noteChangedOnDisk`) exist
    /// around.
    func testIsIdleShouldBeFalseWhileAWriteIsInFlightAndTrueOnceItHasLanded() throws {
        let target = dir.appendingPathComponent("idle.md")
        let writer = CoalescingWriter(onError: { _ in })
        XCTAssertTrue(writer.isIdle, "nothing has been submitted yet")
        let inside = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        AtomicFile.afterPublishForTests = {
            inside.signal()
            release.wait()
        }
        defer { AtomicFile.afterPublishForTests = nil }
        writer.submit("some text", to: target)
        // The write is held inside `AtomicFile`, so this is not a race with
        // it: the queue cannot go idle until the semaphore below is signalled.
        XCTAssertEqual(inside.wait(timeout: .now() + 5), .success,
                       "the write never reached the seam; nothing was held and this asserts nothing")
        XCTAssertFalse(writer.isIdle, "a write is on the queue")
        release.signal()
        writer.drain()
        XCTAssertTrue(writer.isIdle, "the write landed, so there is nothing left to wait for")
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "some text")
    }

    /// A write that threw leaves the previous answer standing. Reporting the
    /// submission instead would have a caller comparing against bytes no file
    /// holds, and the file's real contents would then read as somebody else's
    /// change.
    func testCoalescingWriterDoesNotReportAWriteThatFailed() throws {
        let target = dir.appendingPathComponent("landed.md")
        var errors: [Error] = []
        let w = CoalescingWriter(onError: { errors.append($0) })
        w.submit("first", to: target)
        w.drain()
        let before = try XCTUnwrap(w.lastLanded(for: target))
        // Nothing can be written over a directory, so this submission throws.
        let blocked = dir.appendingPathComponent("isdir2")
        try FileManager.default.createDirectory(at: blocked, withIntermediateDirectories: true)
        w.submit("second", to: blocked)
        w.drain()
        XCTAssertEqual(errors.count, 1)
        XCTAssertEqual(w.lastLanded(for: target)?.content, before.content)
        XCTAssertNil(w.lastLanded(for: blocked), "a write that threw landed nothing")
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
