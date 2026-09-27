import AppKit
import BirtaWriterCore
import XCTest
@testable import BirtaWriter

/// The exits that end a `bwr --wait`, wired to the gestures that are them.
///
/// `ControlSocket.Waits` is the rule and `ControlSocketTests` holds it. What
/// this holds is that the app's gestures reach the rule: a quit answers
/// every wait, a second wait supersedes the first through the same funnel,
/// and the three closes each answer AFTER the bytes their close decided on
/// have landed. The quit is driven live, on a `WindowSet` with no windows,
/// because that is the one exit reachable without a `Coordinator`; the
/// closes need a WKWebView and are held as source text, for the reason
/// `WindowLifetimeTests` gives, with `mac/scripts/check-cli.sh`'s app arm as
/// the live instrument.
@MainActor
final class ShellWaitTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    private func answering() -> (set: WindowSet, answers: () -> [ControlSocket.Waits.Answer]) {
        let set = WindowSet()
        var answers: [ControlSocket.Waits.Answer] = []
        set.answerShell = { answers.append($0) }
        return (set, { answers })
    }

    // MARK: live

    func testAQuitShouldAnswerEveryWaitingShellBeforeItAgrees() {
        let (set, answers) = answering()
        set.shellWaits(1, on: "/g/COMMIT_EDITMSG")
        set.shellWaits(2, on: "/n/other.md")
        var agreed: Bool?
        var answeredWhenAgreed = 0
        set.prepareToTerminate { proceed in
            agreed = proceed
            answeredWhenAgreed = answers().count
        }
        XCTAssertEqual(agreed, true)
        XCTAssertEqual(answeredWhenAgreed, 2, "the shells must hear before AppKit is told the quit may go")
        XCTAssertEqual(Set(answers().map(\.connection)), [1, 2])
        XCTAssertTrue(answers().allSatisfy { $0.reply == .quit })
        XCTAssertTrue(set.waits.isEmpty)
    }

    func testASecondWaitOnTheSameFileShouldAnswerTheFirstThroughTheSameFunnel() {
        let (set, answers) = answering()
        set.shellWaits(1, on: "/g/COMMIT_EDITMSG")
        set.shellWaits(2, on: "/g/COMMIT_EDITMSG")
        XCTAssertEqual(answers(), [.init(connection: 1, reply: .superseded)])
        XCTAssertTrue(set.waits.isWaiting(on: "/g/COMMIT_EDITMSG"))
    }

    func testAShellThatWentAwayShouldNotBeAnsweredByTheQuit() {
        let (set, answers) = answering()
        set.shellWaits(1, on: "/g/COMMIT_EDITMSG")
        set.shellWentAway(1)
        set.prepareToTerminate { _ in }
        XCTAssertTrue(answers().isEmpty)
    }

    /// Without a listener installed nothing answers, and the registry still
    /// forgets: a wait must not linger past its exit because nobody heard.
    func testAnExitWithNoListenerShouldStillEndTheWait() {
        let set = WindowSet()
        set.shellWaits(1, on: "/g/COMMIT_EDITMSG")
        set.prepareToTerminate { _ in }
        XCTAssertTrue(set.waits.isEmpty)
    }

    // MARK: the wiring, as text

    private func source(_ file: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Sources/\(file)")
        return try XCTUnwrap(try? String(contentsOf: url, encoding: .utf8),
                             "could not read \(url.path); if it moved, this guard must follow it")
    }

    /// One function's body, by brace depth from its signature.
    private func body(of signature: String, in text: String) throws -> String {
        let lines = text.components(separatedBy: "\n")
        let start = try XCTUnwrap(lines.firstIndex { $0.contains(signature) },
                                  "\(signature) is gone or renamed, and this guard names it")
        var depth = 0
        var body: [String] = []
        for index in start..<lines.count {
            let line = lines[index]
            body.append(line)
            depth += line.filter { $0 == "{" }.count - line.filter { $0 == "}" }.count
            if depth <= 0, index > start { break }
        }
        return body.joined(separator: "\n")
    }

    /// Each close answers the shell only inside the completion that follows
    /// the window's own flush-and-decide, never before it: that completion is
    /// what `prepareToClose` and `settleForWaitingShell` run once the write
    /// has been waited for.
    func testEveryCloseShouldAnswerTheShellAfterTheWriteHasLanded() throws {
        let text = try source("BirtaWriter/WindowSet.swift")
        for (signature, settle) in [("func close(_ coordinator: Coordinator)", "prepareToClose {"),
                                    ("func closeWindow(_ coordinator: Coordinator)", "prepareToClose {"),
                                    ("func closeLastWindow(_ coordinator: Coordinator)", "settleForWaitingShell {")] {
            let body = try body(of: signature, in: text)
            let settled = try XCTUnwrap(body.range(of: settle), "\(signature) no longer settles the buffer through \(settle)")
            let answered = try XCTUnwrap(body.range(of: "documentClosed("), "\(signature) no longer answers a waiting shell")
            XCTAssertTrue(answered.lowerBound > settled.lowerBound,
                          "\(signature) answers the shell before the write it waits on has landed")
            XCTAssertTrue(body.contains("writeFailures"),
                          "\(signature) does not read the failure count the answer is decided from")
        }
    }

    func testTheLastWindowsCloseShouldSettleOnlyAFileAShellWaitsOn() throws {
        let text = try source("BirtaWriter/WindowSet.swift")
        let body = try body(of: "func closeLastWindow(_ coordinator: Coordinator)", in: text)
        XCTAssertTrue(body.contains("waits.isWaiting(on:"), "every other last window must hide as it always did")
        XCTAssertTrue(body.contains("dismissAll()"))
        XCTAssertTrue(body.contains("answer != .cancel"), "Cancel on the sheet must leave the window up")
    }

    func testTheQuitShouldAnswerFromTheOnePlaceEveryWindowHasAgreed() throws {
        let text = try source("BirtaWriter/WindowSet.swift")
        let body = try body(of: "func prepareToTerminate(", in: text)
        XCTAssertTrue(body.contains("waits.quitting()"))
    }

    /// The other half of admitting `COMMIT_EDITMSG`: the app's allowlist
    /// widens by the file a shell waits on, and by nothing else.
    func testOpenDocumentShouldAdmitAFileAShellWaitsOn() throws {
        let text = try source("BirtaWriter/WindowSet.swift")
        let body = try body(of: "func openDocument(at url: URL)", in: text)
        XCTAssertTrue(body.contains("DocumentTypes.accepts(target) || waits.isWaiting(on: target.path)"))
    }

    /// The settle is a slice of a close and must stay one: the decision the
    /// close makes, and the mark that would skip the next quit's last-chance
    /// write taken back, since this window is not going.
    func testSettlingForAShellShouldDecideLikeACloseAndTakeTheQuitMarkBack() throws {
        let text = try source("BirtaWriter/Coordinator.swift")
        let body = try body(of: "func settleForWaitingShell(", in: text)
        XCTAssertTrue(body.contains("flushThen(persisting: false)"))
        XCTAssertTrue(body.contains("decideFinalWrite {"))
        XCTAssertTrue(body.contains("quitDecided = false"))
    }

    /// Both programs derive the socket's path from the one function, so a
    /// rename at either end fails to compile rather than leaving two sockets.
    func testBothEndsShouldSpellTheSocketFromTheOneDefinition() throws {
        for file in ["BirtaWriter/App.swift", "BirtaWriterCli/main.swift"] {
            let text = try source(file)
            XCTAssertTrue(text.contains("ControlSocket.url(support:"), file)
            XCTAssertTrue(text.contains("ControlSocket.supportDirectory(environment:"), file)
            XCTAssertFalse(text.contains("control.sock"), "\(file) spells the socket's name rather than asking ControlSocket")
        }
        let app = try source("BirtaWriter/App.swift")
        XCTAssertTrue(try body(of: "func applicationDidFinishLaunching(", in: app).contains("listenForWaitingShells()"))
        XCTAssertTrue(try body(of: "func applicationWillTerminate(", in: app).contains("controlListener?.stop()"))
    }
}
