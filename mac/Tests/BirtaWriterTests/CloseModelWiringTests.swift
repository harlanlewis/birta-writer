import XCTest

/// The close model's rules are `TabGroupPolicy`'s and `OpenSet`'s, and their
/// Core tests hold them. What this holds is that `WindowSet` asks them: a quit
/// that records whether it closed the windows, a launch that reads it, and a
/// close that leaves the quick note when it empties the set. Each of those is
/// a call whose absence every other test would pass, and the gestures need a
/// WKWebView, so they are held as source text, for the reason
/// `WindowLifetimeTests` gives.
final class CloseModelWiringTests: XCTestCase {
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

    func testTheQuitShouldRecordWhetherItClosedTheWindows() throws {
        let body = try body(of: "func prepareToTerminate(", in: try source("BirtaWriter/WindowSet.swift"))
        XCTAssertTrue(body.contains("OpenSet.quitClosesWindows("), "the quit no longer asks the rule")
        XCTAssertTrue(body.contains("Prefs.setQuitClosedWindows()"), "the quit no longer records the answer")
    }

    func testTheLaunchShouldReadWhatTheQuitRecordedAndHandItToThePlan() throws {
        let body = try body(of: "func openAtLaunch(", in: try source("BirtaWriter/WindowSet.swift"))
        let read = try XCTUnwrap(body.range(of: "Prefs.takeQuitClosedWindows()"), "the launch no longer reads the mark")
        let plan = try XCTUnwrap(body.range(of: "OpenSet.launchPlan("))
        XCTAssertTrue(read.lowerBound < plan.lowerBound, "the mark must be read before the plan is made")
        XCTAssertTrue(body.contains("restoresWindows: restores"), "the plan is no longer told what the mark said")
    }

    /// A tab later in the chain can be closed by another close made while an
    /// earlier tab's sheet is up. Its page is gone and never answers, so the
    /// chain has to pass over it, or it stalls before the quick note is left
    /// and the app has no window to summon.
    func testAClosingChainShouldPassOverATabAlreadyClosed() throws {
        let body = try body(of: "private func retire(", in: try source("BirtaWriter/WindowSet.swift"))
        let skip = try XCTUnwrap(body.range(of: "guard windows.contains(where: { $0 === tab }) else"),
                                 "the chain no longer checks the tab is still open before asking it")
        let ask = try XCTUnwrap(body.range(of: "tab.prepareToClose"))
        XCTAssertTrue(skip.lowerBound < ask.lowerBound, "the check must come before the tab is asked")
    }

    func testAnEmptiedSetShouldLeaveTheQuickNote() throws {
        let body = try body(of: "private func retire(", in: try source("BirtaWriter/WindowSet.swift"))
        XCTAssertTrue(body.contains("if windows.isEmpty { leaveQuickNote() }"),
                      "a close that empties the set must leave the quick note, or the app has no window")
    }

    /// A log out the person cancels at a Save sheet is a session that goes on,
    /// so the flag the log out set must not outlive the Cancel: left standing,
    /// every later quit in that session reads as the system's and keeps the
    /// windows, whatever Close windows when quitting says.
    func testACancelledQuitShouldForgetThatTheSessionWasEnding() throws {
        let body = try body(of: "func prepareToTerminate(", in: try source("BirtaWriter/WindowSet.swift"))
        let cancel = try XCTUnwrap(body.range(of: "guard proceed else {"), "the quit no longer has a Cancel branch")
        // The branch runs to the answer it gives; its own closures hold braces.
        let answer = try XCTUnwrap(body[cancel.upperBound...].range(of: "done(false)"),
                                   "the Cancel branch no longer answers false")
        let branch = body[cancel.upperBound..<answer.lowerBound]
        XCTAssertTrue(branch.contains("sessionIsEnding = false"),
                      "a Cancel must clear the session-ending flag, or a cancelled log out keeps every later quit's windows")
    }

    func testTheSessionEndingShouldBeObserved() throws {
        let body = try body(of: "    func start() {", in: try source("BirtaWriter/WindowSet.swift"))
        XCTAssertTrue(body.contains("NSWorkspace.willPowerOffNotification"),
                      "without it a log out reads as the person's own quit and closes the windows")
    }
}
