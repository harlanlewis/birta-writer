import XCTest
import BirtaJotCore
@testable import BirtaJot

/// The one part of finding somebody's `PATH` that is not pure: running their
/// shell, once, with everything that asks for the answer waiting on that one
/// run rather than starting another.
///
/// A FRESH instance in each case, never `shared`. The shared one is resolved
/// by the first thing in the suite that asks it, so every case after that
/// would be measuring a value already sitting in a variable and would pass on
/// a resolver that could not resolve anything.
final class LoginShellPathTests: XCTestCase {
    /// A cap far above the app's, for the cases that are about the resolver
    /// working rather than about the cap.
    ///
    /// The app's four seconds is a policy about somebody waiting, and a check
    /// that inherited it would be asserting how busy the machine is: a loaded
    /// runner pushes a shell past four seconds and the resolver correctly
    /// gives up, which is the right behaviour reported as a failure. The one
    /// case below that IS about the cap sets its own, much shorter.
    private static let patientCap: TimeInterval = 60

    private func patient() -> LoginShellPath {
        LoginShellPath(waitCap: Self.patientCap)
    }

    func testAColdResolverShouldAnswerWithTheShellsOwnPath() throws {
        let path = try XCTUnwrap(patient().childPath(inherited: nil),
                                 "the login shell reported no PATH at all")
        let entries = path.split(separator: ":").map(String.init)
        XCTAssertTrue(entries.contains("/usr/bin"), path)
        XCTAssertTrue(entries.contains("/bin"), path)
    }

    /// Everything the app was launched with survives, whatever the shell says.
    func testTheInheritedEntriesShouldSurviveWhateverTheShellReports() throws {
        let path = try XCTUnwrap(patient().childPath(inherited: "/birta-test-bin"))
        XCTAssertTrue(path.split(separator: ":").contains("/birta-test-bin"), path)
    }

    /// A shell that never answers must not be left running.
    ///
    /// Giving up on the answer leaves the caller with a usable `PATH` and does
    /// nothing about the shell, which would otherwise hold a pipe for the rest
    /// of the session under a name nothing of ours reaps. Driven with a shell
    /// that hangs on purpose, and with a cap of its own so this costs a second
    /// rather than the app's four.
    func testAShellThatNeverAnswersShouldBeGivenUpOnAndEnded() throws {
        let script = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("birta-hanging-shell-\(UUID().uuidString).sh")
        try "#!/bin/sh\nsleep 300\n".write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755],
                                              ofItemAtPath: script.path)
        defer { try? FileManager.default.removeItem(at: script) }

        let resolver = LoginShellPath(shell: script.path, waitCap: 0.3)
        let began = Date()
        let path = resolver.childPath(inherited: "/usr/bin:/bin")
        let waited = Date().timeIntervalSince(began)

        XCTAssertEqual(path, "/usr/bin:/bin", "a shell that said nothing changed the PATH")
        XCTAssertLessThan(waited, 3, "the caller waited on a shell that was never going to answer")
        // It really did start, or the end of it below is about nothing.
        XCTAssertGreaterThan(waited, 0.2)

        // TERM, then a second's grace, then KILL. Read after all of that.
        Thread.sleep(forTimeInterval: 2)
        let running = Process()
        running.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        running.arguments = ["-f", script.path]
        let pipe = Pipe()
        running.standardOutput = pipe
        try running.run()
        let found = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
        running.waitUntilExit()
        XCTAssertTrue(found.isEmpty,
                      "the shell is still running: "
                          + (String(data: found, encoding: .utf8) ?? ""))
    }

    /// Several callers at once wait on one run and all get the same answer.
    ///
    /// The case this is here for is the SECOND caller: a wait built on counted
    /// permits hands the first arrival the only one there is, and the rest
    /// either sit out the whole cap or come back early with nothing resolved.
    /// Driven cold, from more threads than the resolver has runs to give.
    func testEveryCallerAtOnceShouldGetTheSameAnswerFromOneRun() {
        let resolver = patient()
        let callers = 8
        let answered = expectation(description: "every caller is answered")
        answered.expectedFulfillmentCount = callers
        let lock = NSLock()
        var answers: [String?] = []

        for _ in 0..<callers {
            DispatchQueue.global().async {
                let answer = resolver.childPath(inherited: nil)
                lock.lock()
                answers.append(answer)
                lock.unlock()
                answered.fulfill()
            }
        }
        wait(for: [answered], timeout: Self.patientCap + 10)

        XCTAssertEqual(answers.count, callers)
        XCTAssertEqual(Set(answers.map { $0 ?? "" }).count, 1,
                       "the callers disagree about the PATH: \(answers)")
        XCTAssertNotNil(answers.first ?? nil, "every caller got nothing")
    }
}
