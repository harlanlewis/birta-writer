import XCTest
@testable import BirtaJotCore

final class AtomicFileTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("jot-tests-\(UUID().uuidString)")
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
