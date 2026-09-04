import XCTest
@testable import BirtaWriter

/// What the re-assertion of a summon's activation may and may not do.
///
/// `BirtaWriterCore.SummonActivation` holds the rule and its own tests hold
/// which Space change is a summon's to answer. This file is about the AppKit
/// half, and about the one way it can be quietly wrong: re-asserting by calling
/// `summonAll` instead of raising the windows.
///
/// Showing a window captures whatever application is frontmost, so that it can
/// be returned to on dismissal (`WindowSet.capturePreviousApp`). At the moment
/// a re-assertion runs, the frontmost application is the one the Space switch
/// has just put in front, which is exactly the application the reader is being
/// rescued from. A re-assertion routed through `show` would therefore record it
/// as the place to go back to, and the next dismissal would drop the reader
/// into it rather than into whatever they pressed the hotkey in. Both paths
/// look correct on screen and nothing else in the suite can tell them apart.
///
/// A source-text guard rather than a live one, for the reason
/// `WindowLifetimeTests` gives at length: building a `WindowSet` with windows
/// in it means building a `WKWebView` and the WebKit helper processes behind
/// it, which no test in this suite starts, and staging the Space switch that
/// makes this path run needs a second Space and a window server gesture that
/// no test has. The live instrument for the gesture itself is the app: go full
/// screen in another application, press the hotkey, and this app is the one in
/// front when the Space arrives.
@MainActor
final class SummonReassertTests: XCTestCase {
    private func source() -> [String] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Sources/BirtaWriter/WindowSet.swift")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            XCTFail("could not read \(url.path); if WindowSet.swift moved, this guard must follow it")
            return []
        }
        return text.components(separatedBy: "\n")
    }

    /// The body of a named function, comments dropped, so a rule stated in
    /// prose beside the code cannot satisfy a guard written about the code.
    private func body(of declaration: String) -> [String] {
        let lines = source()
        guard !lines.isEmpty else { return [] }
        guard let start = lines.firstIndex(where: { $0.contains(declaration) }) else {
            XCTFail("WindowSet has no \(declaration); this guard needs rewriting")
            return []
        }
        guard let end = lines[(start + 1)...].firstIndex(where: { $0 == "    }" }) else {
            XCTFail("could not find the end of \(declaration)")
            return []
        }
        return lines[start...end].filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
    }

    /// The re-assertion raises the windows and activates. It must not show
    /// them, because showing is what captures the application to return to.
    func testTheReassertionShouldNotShowItsWindows() {
        let statements = body(of: "func reassertSummon()")
        XCTAssertFalse(statements.isEmpty, "reassertSummon has no body to read")
        XCTAssertTrue(statements.contains { $0.contains(".raise()") },
                      "reassertSummon no longer raises its window")
        XCTAssertTrue(statements.contains { $0.contains("NSApp.activate") },
                      "reassertSummon no longer re-issues the activation")
        for banned in ["summonAll(", ".show()"] {
            XCTAssertFalse(
                statements.contains { $0.contains(banned) },
                "reassertSummon reaches \(banned), which captures the application "
                    + "the Space switch put in front as the one to return to")
        }
    }

    /// The hotkey is not the only route forward, so it is not the only one
    /// armed. New Note, a row of Open Recent and Open With from the Finder all
    /// activate the app, all can be taken from inside another application's
    /// full screen, and all reach `show` rather than `summonAll`. Arming in
    /// `summonAll` would fix the hotkey alone and leave every other route with
    /// the same defect and no test able to see it.
    func testEveryRouteForwardShouldArmTheReassertion() {
        let onShow = body(of: "func windowWillShow()")
        XCTAssertFalse(onShow.isEmpty, "windowWillShow has no body to read")
        XCTAssertTrue(onShow.contains { $0.contains("summonActivation.summoned(") },
                      "the show path no longer arms the re-assertion")
        XCTAssertTrue(
            body(of: "func adopt(").contains { $0.contains("onWillShow") && $0.contains("windowWillShow") },
            "adopt no longer routes a window's show through windowWillShow")
        XCTAssertFalse(
            body(of: "func summonAll()").contains { $0.contains("summonActivation.summoned(") },
            "summonAll arms the re-assertion itself, which covers the hotkey and no other route forward")
    }

    /// The arm is spent by dismissal before the guard that returns early, so a
    /// reader who dismissed is not pulled forward by their own next Space
    /// change.
    func testDismissalShouldDisarmBeforeItCanReturnEarly() {
        let statements = body(of: "func dismissAll()")
        XCTAssertFalse(statements.isEmpty, "dismissAll has no body to read")
        guard let disarm = statements.firstIndex(where: { $0.contains("summonActivation.disarm()") }) else {
            XCTFail("dismissAll no longer disarms the summon")
            return
        }
        guard let guardLine = statements.firstIndex(where: { $0.contains("guard isAnyVisible") }) else {
            XCTFail("dismissAll no longer returns early; this guard needs rewriting")
            return
        }
        XCTAssertLessThan(disarm, guardLine,
                          "dismissAll disarms only on the path that does not return early")
    }
}
