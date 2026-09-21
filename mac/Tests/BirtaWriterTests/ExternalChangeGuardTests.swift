import XCTest
@testable import BirtaWriter

/// Every path that puts bytes at the bound file asks first whether anything
/// else changed it (MAR-469).
///
/// A guard over the SOURCE, for the reason `FlushWriteTests` reads the same
/// file: what this is about is a path that does not exist yet. The rule is one
/// call in `writeLatest`, and a second write path added beside it would be
/// correct in every test anybody would think to write, and would replace
/// another tool's file on a Tuesday. A dead one was already there when this
/// landed, three years of nobody calling it away from being that path.
///
/// It fails on a `writer.submit` outside `writeLatest`, and on a `writeLatest`
/// that has stopped reconciling. Neither is a rule about spelling: both are
/// the two halves of "the file is read before it is written", which nothing
/// else in the suite can see, since a Coordinator needs a window and a web
/// process to be driven at all (which is what
/// `mac/scripts/check-external-change.sh` does, and why it exists).
@MainActor
final class ExternalChangeGuardTests: XCTestCase {
    private func source() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Sources/BirtaWriter/Coordinator.swift")
        return try XCTUnwrap(try? String(contentsOf: url, encoding: .utf8),
                             "could not read \(url.path); if Coordinator.swift moved, this guard must follow it")
    }

    /// The body of the one function allowed to submit, by brace depth from its
    /// signature. Returned separately so the sweep below can say which side of
    /// it a submission is on.
    private func writeLatestBody(of text: String) throws -> (body: String, rest: String) {
        let lines = text.components(separatedBy: "\n")
        let start = try XCTUnwrap(lines.firstIndex { $0.contains("private func writeLatest(") },
                                  "writeLatest is what every write goes through; it is gone or renamed")
        var depth = 0
        var body: [String] = []
        var rest = lines[..<start].joined(separator: "\n")
        var index = start
        while index < lines.count {
            let line = lines[index]
            body.append(line)
            depth += line.filter { $0 == "{" }.count - line.filter { $0 == "}" }.count
            index += 1
            if depth <= 0, index > start { break }
        }
        rest += "\n" + lines[index...].joined(separator: "\n")
        return (body.joined(separator: "\n"), rest)
    }

    func testTheOnlyPlaceThatSubmitsToTheWriterShouldBeWriteLatest() throws {
        let text = try source()
        let split = try writeLatestBody(of: text)
        XCTAssertEqual(split.body.components(separatedBy: "writer.submit(").count - 1, 1,
                       "writeLatest submits exactly once")
        XCTAssertFalse(split.rest.contains("writer.submit("),
                       "a second write path would write the buffer over a file nobody re-read")
    }

    func testWriteLatestShouldReconcileBeforeItSubmits() throws {
        let body = try writeLatestBody(of: source()).body
        let reconcile = try XCTUnwrap(body.range(of: "reconcileWithDisk("),
                                      "the write no longer asks whether the file changed")
        let submit = try XCTUnwrap(body.range(of: "writer.submit("))
        XCTAssertTrue(reconcile.lowerBound < submit.lowerBound,
                      "asking after the bytes have gone is asking about a file we just replaced")
        XCTAssertTrue(body.contains("guard reconcileWithDisk("),
                      "the answer decides whether the write happens; an unread one decides nothing")
    }

    /// The other side of the same rule: a summon is where a stale panel is
    /// corrected and the only place there is a window to put the question on.
    func testTheSummonShouldReconcileToo() throws {
        let text = try source()
        let show = try XCTUnwrap(text.range(of: "\n    func show() {"))
        let after = text[show.upperBound...]
        let end = try XCTUnwrap(after.range(of: "\n    }\n"))
        XCTAssertTrue(after[..<end.lowerBound].contains("reconcileWithDisk("),
                      "a summon that does not look is how a file edited elsewhere stays invisible")
    }
}
