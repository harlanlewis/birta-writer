import XCTest
import BirtaJotCore
@testable import BirtaJot

/// What a run reports, driving real child processes.
///
/// The one this suite exists for is `text`. The page treats what arrives there
/// as the file's bytes and merges it into the note, so a report that puts the
/// child's console transcript in it replaces the user's note with the agent's
/// chatter. `AgentRunner` cannot answer what belongs there at all: it sees a
/// process and never the buffer, so the field stays nil here and
/// `Coordinator.finishAgentRun` is the only thing that fills it.
@MainActor
final class AgentRunnerTests: XCTestCase {
    /// A temporary folder holding `note.md`, cleaned up by the test.
    private func makeNote(_ contents: String) throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("agentrunner-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try contents.write(to: dir.appendingPathComponent("note.md"), atomically: true, encoding: .utf8)
        return dir
    }

    /// Runs one request to completion and returns every report it made.
    private func run(template: String, in directory: URL) -> [AgentRunStatus] {
        let runner = AgentRunner()
        var seen: [AgentRunStatus] = []
        let finished = expectation(description: "the run reports a terminal status")
        runner.run(requestId: "r1", line: "rewrite the body", template: template,
                   workingDirectory: directory) { status in
            seen.append(status)
            if status.status != "running" { finished.fulfill() }
        }
        wait(for: [finished], timeout: 30)
        return seen
    }

    func testARunThatPrintedAndRewroteTheFileShouldReportNoDocumentBytes() throws {
        let dir = try makeNote("# Note\n\nOriginal body.\n")
        defer { try? FileManager.default.removeItem(at: dir) }
        // Prints to both streams AND writes the file, which is the ordinary
        // shape of an agent run: the transcript and the document are two
        // different things and only one of them is the note.
        let reports = run(
            // `true {prompt}` swallows the composed request line, so the rest
            // of the script is not handed it as arguments.
            template: "true {prompt} ; printf 'Reading note.md\\n' ; printf 'thinking...\\n' >&2 ;"
                + " printf '# Note\\n\\nRewritten body.\\n' > note.md ;"
                + " printf 'Done! I rewrote the body.\\n'",
            in: dir)

        let final = try XCTUnwrap(reports.last)
        XCTAssertEqual(final.status, "done")
        XCTAssertNil(final.text, "a successful run must hand the page no document bytes of its own")
        // The instrument reached what it claims to have reached: the child did
        // print, and did write, so a nil `text` is a report that dropped the
        // transcript rather than a run that produced none.
        let onDisk = try String(contentsOf: dir.appendingPathComponent("note.md"), encoding: .utf8)
        XCTAssertEqual(onDisk, "# Note\n\nRewritten body.\n")
    }

    func testAFailedRunShouldReportItsLastLineAsTheMessageAndNoDocumentBytes() throws {
        let dir = try makeNote("# Note\n")
        defer { try? FileManager.default.removeItem(at: dir) }
        let reports = run(
            template: "true {prompt} ; printf 'no such command\\n' >&2 ; exit 3", in: dir)

        let final = try XCTUnwrap(reports.last)
        XCTAssertEqual(final.status, "failed")
        XCTAssertEqual(final.message, "no such command")
        XCTAssertNil(final.text, "a failure is a sentence, never a document")
    }

    func testTheFirstReportShouldBeRunningWithTheHarnessName() throws {
        let dir = try makeNote("# Note\n")
        defer { try? FileManager.default.removeItem(at: dir) }
        let reports = run(template: "true {prompt}", in: dir)

        XCTAssertEqual(reports.first?.status, "running")
        XCTAssertEqual(reports.first?.harness, "true")
        XCTAssertNil(reports.first?.text)
    }
}
