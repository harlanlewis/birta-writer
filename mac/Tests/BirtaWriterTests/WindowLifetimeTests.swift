import XCTest
@testable import BirtaWriter

/// How long a window lives, which became a question the day one could close.
///
/// `WindowSet.adopt` hands each window closures that reach back to the app, and
/// two of them have to say WHICH window: closing one, and noting that one took
/// the keyboard. The coordinator OWNS those closures, so a closure that captures
/// the coordinator strongly is a cycle and the window never deallocates.
///
/// That cost nothing while a window lived exactly as long as the app. It costs a
/// whole WKWebView per closed window now, which is the one resource multiple
/// windows multiply: measured at roughly 79 MB and a WebKit content process for
/// the second window, so a session that opens and closes a few notes would leak
/// more than the app's entire idle footprint.
///
/// A source-text guard rather than a live check, and the reason is worth stating
/// so nobody replaces it with the "better" version by accident. Proving a
/// deallocation means building a real `Coordinator`, which builds a `WKWebView`,
/// which starts three WebKit helper processes that are not children of this
/// process and are cleaned up by `mac/scripts/reap.sh` rather than by anything
/// XCTest does. No test in this suite starts WebKit today, and making the unit
/// suite the first thing that does, for one assertion, is a poor trade against
/// reading nine lines of source.
@MainActor
final class WindowLifetimeTests: XCTestCase {
    private func adoptBody() -> [String] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Sources/BirtaWriter/WindowSet.swift")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            XCTFail("could not read \(url.path); if WindowSet.swift moved, this guard must follow it")
            return []
        }
        let lines = text.components(separatedBy: "\n")
        guard let start = lines.firstIndex(where: { $0.contains("func adopt(") }) else {
            XCTFail("WindowSet has no adopt; this guard needs rewriting")
            return []
        }
        guard let end = lines[(start + 1)...].firstIndex(where: { $0 == "    }" }) else {
            XCTFail("could not find the end of adopt")
            return []
        }
        return Array(lines[start...end])
    }

    /// Every hook `adopt` installs that names the window must hold it weakly.
    ///
    /// Derived from the body rather than from a list of the two hooks that do
    /// it today, so a third joins by being written.
    func testAHookThatNamesItsWindowShouldNotKeepItAlive() {
        let body = adoptBody()
        guard !body.isEmpty else { return }

        // Each `coordinator.onSomething = { ... }` and the closure that follows.
        var assignments: [(line: Int, text: String)] = []
        var current: (line: Int, text: String)?
        for (offset, line) in body.enumerated() {
            if line.contains("coordinator.") && line.contains("= {") {
                if let held = current { assignments.append(held) }
                current = (offset, line)
            } else if current != nil, line.trimmingCharacters(in: .whitespaces) == "}" {
                assignments.append(current!)
                current = nil
            } else if var held = current {
                held.text += "\n" + line
                current = held
            }
        }
        if let held = current { assignments.append(held) }

        XCTAssertFalse(assignments.isEmpty, "no hooks were found in adopt; this guard is watching nothing")

        var naming = 0
        for hook in assignments {
            // The assignment's own left-hand side always says `coordinator`;
            // what matters is whether the closure BODY reaches for it.
            let body = hook.text.drop { $0 != "{" }
            guard body.contains("coordinator") else { continue }
            naming += 1
            XCTAssertTrue(hook.text.contains("weak coordinator"),
                          "WindowSet.swift, the hook at adopt+\(hook.line) names its window and would "
                            + "keep it alive; the coordinator owns this closure, so the capture must be "
                            + "weak: " + hook.text.trimmingCharacters(in: .whitespacesAndNewlines))
        }

        // Without this the sweep passes when the parser stopped recognising a
        // closure body, which is the same green as an adopt with no such hook.
        XCTAssertGreaterThanOrEqual(naming, 2,
                                    "closing a window and noting which one took the keyboard both name "
                                     + "their window; finding fewer than two means the parser missed them")
    }
}
