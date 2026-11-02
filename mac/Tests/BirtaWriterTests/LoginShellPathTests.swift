import XCTest
import BirtaWriterCore
@testable import BirtaWriter

/// The one part of finding somebody's `PATH` that is not pure: running their
/// shell, with every ask made while it runs sharing that one run, and every
/// ask answered on time whatever the shell does.
///
/// A FRESH instance in each case, never `shared`, so no case reads a run
/// another case started.
@MainActor
final class LoginShellPathTests: XCTestCase {
    /// A cap far above the app's, for the cases that are about the shell
    /// answering rather than about the cap. The app's is a policy about a
    /// startup file that hangs, and a check that inherited it would be
    /// asserting how busy the machine is.
    private static let patientCap: TimeInterval = 60

    /// A shell of the test's own, written to a temporary file.
    private func shell(_ body: String) throws -> URL {
        let script = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("birta-shell-\(UUID().uuidString).sh")
        try "#!/bin/sh\n\(body)\n".write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        addTeardownBlock { try? FileManager.default.removeItem(at: script) }
        return script
    }

    private func pgrep(_ pattern: String) throws -> String {
        let running = Process()
        running.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        running.arguments = ["-f", pattern]
        let pipe = Pipe()
        running.standardOutput = pipe
        try running.run()
        let found = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
        running.waitUntilExit()
        return String(data: found, encoding: .utf8) ?? ""
    }

    func testTheLoginShellShouldAnswerWithItsOwnPath() throws {
        let resolver = LoginShellPath(cap: Self.patientCap)
        let answered = expectation(description: "answered")
        var answer: String?
        resolver.ask { answer = $0; answered.fulfill() }
        wait(for: [answered], timeout: Self.patientCap + 10)

        let path = try XCTUnwrap(answer, "the login shell reported no PATH at all")
        let entries = path.split(separator: ":").map(String.init)
        XCTAssertTrue(entries.contains("/usr/bin"), path)
    }

    /// The answer arrives on the main queue, because the row that asked
    /// redraws from it directly.
    func testTheAnswerShouldArriveOnTheMainThread() {
        let resolver = LoginShellPath(cap: Self.patientCap)
        let answered = expectation(description: "answered")
        var onMain = false
        resolver.ask { _ in onMain = Thread.isMainThread; answered.fulfill() }
        wait(for: [answered], timeout: Self.patientCap + 10)
        XCTAssertTrue(onMain)
    }

    /// Asks made while a run is going share it: one shell, one answer for all.
    /// Counted by the shell itself, which appends a line per run.
    func testAsksMadeWhileOneRunsShouldShareItsAnswer() throws {
        let tally = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("birta-shell-runs-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: tally) }
        let script = try shell("""
            echo run >> '\(tally.path)'
            sleep 0.3
            printf '\(ShellPath.openMarker)/shared/bin\(ShellPath.closeMarker)'
            """)
        let resolver = LoginShellPath(shell: script.path, cap: Self.patientCap)
        let callers = 5
        let answered = expectation(description: "every ask is answered")
        answered.expectedFulfillmentCount = callers
        var answers: [String?] = []
        for _ in 0..<callers {
            resolver.ask { answers.append($0); answered.fulfill() }
        }
        wait(for: [answered], timeout: Self.patientCap + 10)

        XCTAssertEqual(answers, Array(repeating: "/shared/bin", count: callers))
        let runs = try String(contentsOf: tally, encoding: .utf8).split(separator: "\n").count
        XCTAssertEqual(runs, 1, "asks made during one run started more shells")
    }

    /// An ask after a run has finished starts a new one rather than reusing
    /// the old answer: the reason somebody came back may be that they just
    /// edited their shell's startup.
    func testAnAskAfterARunFinishedShouldRunTheShellAgain() throws {
        let tally = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("birta-shell-runs-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: tally) }
        let script = try shell("""
            echo run >> '\(tally.path)'
            printf '\(ShellPath.openMarker)'"$(wc -l < '\(tally.path)' | tr -d ' ')"'\(ShellPath.closeMarker)'
            """)
        let resolver = LoginShellPath(shell: script.path, cap: Self.patientCap)
        var answers: [String?] = []
        for _ in 0..<2 {
            let answered = expectation(description: "answered")
            resolver.ask { answers.append($0); answered.fulfill() }
            wait(for: [answered], timeout: Self.patientCap + 10)
        }
        XCTAssertEqual(answers, ["1", "2"])
    }

    /// A shell that never answers is ended, and the ask is answered with
    /// nothing rather than left waiting.
    func testAShellThatNeverAnswersShouldBeEndedAndTheAskAnswered() throws {
        let script = try shell("sleep 300")
        let resolver = LoginShellPath(shell: script.path, cap: 0.3)
        let answered = expectation(description: "answered")
        var answer: String? = "unanswered"
        resolver.ask { answer = $0; answered.fulfill() }
        wait(for: [answered], timeout: 10)
        XCTAssertNil(answer, "a shell that said nothing produced a PATH")

        // TERM, then a second's grace, then KILL. Read after all of that.
        Thread.sleep(forTimeInterval: 2)
        let found = try pgrep(script.path)
        XCTAssertTrue(found.isEmpty, "the shell is still running: \(found)")
    }

    /// A shell that starts something holding its output open never reaches
    /// EOF, whatever happens to the shell: a daemon an rc file launches moves
    /// to a process group of its own, out of reach of anything that ends the
    /// shell, and keeps the pipe. The ask is answered on time anyway, and the
    /// next ask starts a run of its own instead of joining that one.
    func testAPipeHeldOpenShouldNotStrandTheAskOrTheNextOne() throws {
        let marker = "birta-pipe-holder-\(UUID().uuidString)"
        let script = try shell("perl -e 'setpgrp(0, 0); sleep 30' \(marker) &\nsleep 300")
        addTeardownBlock { [weak self] in
            // The orphan holding the pipe is ours; end it by pid.
            guard let pids = try? self?.pgrep(marker) else { return }
            for pid in pids.split(separator: "\n").compactMap({ Int32($0) }) { kill(pid, SIGTERM) }
        }
        let resolver = LoginShellPath(shell: script.path, cap: 0.3)
        for round in 0..<2 {
            let answered = expectation(description: "round \(round) answered")
            var answer: String? = "unanswered"
            resolver.ask { answer = $0; answered.fulfill() }
            wait(for: [answered], timeout: 10)
            XCTAssertNil(answer, "round \(round)")
        }
        // The orphan really is holding the pipe, or this case tested nothing.
        XCTAssertFalse(try pgrep(marker).isEmpty, "nothing held the pipe open")
    }
}
