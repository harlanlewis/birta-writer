import XCTest
@testable import BirtaWriter

/// How a command issued from the Settings window reaches the pages.
///
/// The Appearance pane's typography rows run the toolbar's own commands in
/// every window (`WindowSet.runEditorCommandEverywhere`), and there are two
/// ways to send one. `Coordinator.runEditorCommand` summons first, which is
/// what makes a menu key equivalent work from a window that is not the
/// panel; `runEditorCommandInPlace` does not, and that is the one this path
/// needs. Sent the summoning way, stepping the font size brought every panel
/// to the front and left the reader looking at their text with the Settings
/// window, and the button they had just pressed, behind it.
///
/// A source-text guard, for the reason `WindowLifetimeTests` gives at length:
/// a live check means building a `Coordinator`, which builds a `WKWebView`
/// and starts three WebKit helper processes this suite otherwise never
/// starts. What is being pinned is which of two calls one line makes, and
/// reading that line costs nothing.
@MainActor
final class EditorCommandDeliveryTests: XCTestCase {
    private func source(_ file: String) -> [String] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Sources/BirtaWriter/\(file)")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            XCTFail("could not read \(url.path); if \(file) moved, this guard must follow it")
            return []
        }
        return text.components(separatedBy: "\n")
    }

    /// The lines of the function whose declaration matches `declaration`, up
    /// to its closing brace at the declaration's own indentation.
    private func body(of declaration: String, in file: String) -> [String] {
        let lines = source(file)
        guard !lines.isEmpty else { return [] }
        guard let start = lines.firstIndex(where: { $0.contains(declaration) }) else {
            XCTFail("\(file) has no \(declaration); this guard needs rewriting")
            return []
        }
        let indent = String(lines[start].prefix { $0 == " " })
        guard let end = lines[(start + 1)...].firstIndex(where: { $0 == indent + "}" }) else {
            XCTFail("could not find the end of \(declaration) in \(file)")
            return []
        }
        return Array(lines[start...end])
    }

    func testTheSettingsPanesCommandsShouldReachEveryPageWithoutSummoningIt() {
        let everywhere = body(of: "func runEditorCommandEverywhere(", in: "WindowSet.swift")
        guard !everywhere.isEmpty else { return }
        XCTAssertTrue(everywhere.contains { $0.contains("runEditorCommandInPlace(") },
                      "WindowSet.runEditorCommandEverywhere is the Settings window's path into the "
                        + "pages and must not summon them: " + everywhere.joined(separator: "\n"))

        // And the call it makes has to be the one that does not summon, which
        // is a claim about the other file. Asserted rather than assumed,
        // because the name alone would go on reading as the quiet one long
        // after somebody added a `show()` to it.
        let inPlace = body(of: "func runEditorCommandInPlace(", in: "Coordinator.swift")
        guard !inPlace.isEmpty else { return }
        XCTAssertFalse(inPlace.contains { $0.contains("show()") },
                       "Coordinator.runEditorCommandInPlace summons; the whole of what it is for is "
                         + "that it does not: " + inPlace.joined(separator: "\n"))
        XCTAssertTrue(inPlace.contains { $0.contains("host.send(") },
                      "it has to actually deliver the command, or this guard is watching a no-op")

        // The summoning form still exists and still summons: it is what a menu
        // key equivalent pressed in the Settings or About window needs, so a
        // green here must not mean the two were collapsed into one.
        let summoning = body(of: "func runEditorCommand(", in: "Coordinator.swift")
        guard !summoning.isEmpty else { return }
        XCTAssertTrue(summoning.contains { $0.contains("show()") },
                      "Coordinator.runEditorCommand no longer summons, so a command fired by its key "
                        + "equivalent from another window reaches a panel nobody can see")
    }
}
