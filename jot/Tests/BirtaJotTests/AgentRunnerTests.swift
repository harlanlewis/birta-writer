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

    /// Runs one probe to completion and returns what it found.
    private func probe(template: String, childPath: (() -> String?)? = nil) -> AgentProbeResult? {
        let runner = AgentRunner()
        if let childPath { runner.childPath = childPath }
        var result: AgentProbeResult?
        let finished = expectation(description: "the probe reports")
        runner.probe(template: template) {
            result = $0
            finished.fulfill()
        }
        wait(for: [finished], timeout: 30)
        return result
    }

    func testASuccessfulProbeShouldHandBackWhatTheToolPrinted() throws {
        let result = try XCTUnwrap(probe(
            template: "true {prompt} ; printf 'Hello!\\n' ; printf 'on stderr\\n' >&2"))

        XCTAssertTrue(result.succeeded)
        XCTAssertNil(result.failure)
        // Both streams, interleaved: the person reading this wants everything
        // the tool said, and several of these CLIs answer on stderr.
        XCTAssertTrue(result.transcript.contains("Hello!"), result.transcript)
        XCTAssertTrue(result.transcript.contains("on stderr"), result.transcript)
    }

    func testAProbeShouldReachTheToolWithTheHelloPrompt() throws {
        // The prompt is what makes this a test of the whole path rather than
        // of the binary existing, so the tool has to actually receive it.
        let result = try XCTUnwrap(probe(template: "printf '%s' {prompt}"))

        XCTAssertTrue(result.succeeded)
        XCTAssertEqual(result.transcript, AgentRequest.probePrompt)
    }

    func testAFailingProbeShouldKeepTheToolsOwnErrorAndSayItFailed() throws {
        let result = try XCTUnwrap(probe(
            template: "true {prompt} ; printf 'not logged in\\n' >&2 ; exit 4"))

        XCTAssertFalse(result.succeeded)
        XCTAssertNotNil(result.failure)
        XCTAssertTrue(result.transcript.contains("not logged in"), result.transcript)
    }

    /// A command that is not installed, which is the whole reason the button
    /// exists. `/bin/sh` reports it rather than refusing to start, so this
    /// arrives as a nonzero exit with the shell's own sentence.
    func testAProbeOfACommandThatIsNotInstalledShouldFailWithSomethingToRead() throws {
        let result = try XCTUnwrap(probe(template: "birta-no-such-agent-xyz {prompt}"))

        XCTAssertFalse(result.succeeded)
        let said = result.transcript + (result.failure ?? "")
        XCTAssertFalse(said.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                       "a failure with nothing to read is the sheet saying nothing")
    }

    /// The probe must not write where the notes are. It runs in a folder of
    /// its own, and that folder is gone afterwards.
    func testAProbeShouldRunInAFolderOfItsOwnAndLeaveNothingBehind() throws {
        let result = try XCTUnwrap(probe(
            template: "true {prompt} ; printf 'x' > wrote.txt ; pwd"))

        XCTAssertTrue(result.succeeded)
        let directory = result.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertFalse(directory.isEmpty, "the probe reported no working directory")
        // The instrument reached something: the child really did write there,
        // so an absent directory below is the cleanup rather than a child that
        // never ran.
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory),
                       "the probe left \(directory) on disk")
    }

    /// A tool that asks a question sees EOF rather than a terminal, so it
    /// gives up instead of hanging with nothing on screen saying why.
    ///
    /// Driven rather than asserted about the property: `read` blocks forever
    /// on an inherited stdin and returns at once on `/dev/null`, so a probe
    /// that came back at all is the answer.
    func testAToolThatWaitsForInputShouldSeeNothingRatherThanHang() throws {
        let result = try XCTUnwrap(probe(
            template: "true {prompt} ; read line ; printf 'read returned\\n'"))

        XCTAssertTrue(result.transcript.contains("read returned"), result.transcript)
    }

    // MARK: the PATH a child runs with

    /// The defect this is here for: an app opened from the Finder inherits
    /// `launchd`'s four system directories, every agent CLI installs somewhere
    /// else, and the Test button therefore calls a tool somebody uses daily
    /// not installed.
    ///
    /// Injected rather than read off this machine. Comparing the child's
    /// `PATH` against what the resolver would have said is two readings of one
    /// machine, and they agree with each other whether or not anything was
    /// ever applied.
    func testAChildShouldRunWithThePathTheRunnerWasGiven() throws {
        let result = try XCTUnwrap(probe(template: "true {prompt} ; printenv PATH",
                                         childPath: { "/birta-test-bin:/usr/bin:/bin" }))

        XCTAssertTrue(result.succeeded, result.transcript)
        XCTAssertEqual(result.transcript.trimmingCharacters(in: .whitespacesAndNewlines),
                       "/birta-test-bin:/usr/bin:/bin")
    }

    /// The rest of the environment is the app's own. A child given only a
    /// `PATH` loses `HOME`, and `HOME` is where every one of these tools keeps
    /// the credentials that decide whether it can answer at all.
    func testAChildShouldKeepTheRestOfTheEnvironment() throws {
        let result = try XCTUnwrap(probe(template: "true {prompt} ; printenv HOME",
                                         childPath: { "/usr/bin:/bin" }))

        XCTAssertEqual(result.transcript.trimmingCharacters(in: .whitespacesAndNewlines),
                       ProcessInfo.processInfo.environment["HOME"])
    }

    /// A resolver with no answer leaves the environment as it found it, rather
    /// than handing a child an empty `PATH` and taking away what it had.
    func testAResolverWithNoAnswerShouldLeaveTheInheritedPathAlone() throws {
        let result = try XCTUnwrap(probe(template: "true {prompt} ; printenv PATH",
                                         childPath: { nil }))

        XCTAssertEqual(result.transcript.trimmingCharacters(in: .whitespacesAndNewlines),
                       ProcessInfo.processInfo.environment["PATH"])
    }

    /// And a runner nobody handed a resolver to still has one, or every check
    /// above is about a seam that is empty in the app.
    ///
    /// `LoginShellPathTests` is what asks whether the resolver can resolve;
    /// this asks only whether a plain `AgentRunner` is wired to it.
    func testARunnerNobodyConfiguredShouldStillHaveAResolver() throws {
        let path = try XCTUnwrap(AgentRunner().childPath(),
                                 "a plain AgentRunner gives its children no PATH of their own")
        XCTAssertTrue(path.split(separator: ":").contains("/usr/bin"), path)
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
