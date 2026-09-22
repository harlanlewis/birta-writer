import XCTest
@testable import BirtaWriter

/// A backlink's line reaches the page on every route the file can take
/// (MAR-486).
///
/// `OpenRouting.explorerDestination` lands a file one of three ways, and the
/// line a backlink asks for has a different carrier on each: a reload of the
/// clicked window carries it on the new page's `init`; a new tab's first
/// `init` carries it the same way; a window already showing the file gets no
/// fresh page at all and is sent `scrollToLine` outright. The routing does
/// not read the line, so nothing in `OpenRouting` can hold this, and the arm
/// that forgets it is not a compile error: the file still opens, where it was
/// left, which is exactly the defect this ticket named.
///
/// A source-text guard, for the reason `WindowLifetimeTests` gives at length:
/// a live check means building a `Coordinator`, which builds a `WKWebView`
/// and starts three WebKit helper processes this suite otherwise never
/// starts, and `WebHost.send` has no seam a test can watch. What is pinned
/// is which call each arm makes, and reading the arms costs nothing.
@MainActor
final class BacklinkRevealTests: XCTestCase {
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

    /// The lines from the first one containing `from` up to (not including)
    /// the first later one containing `to`.
    private func segment(_ lines: [String], from: String, to: String) -> [String] {
        guard let start = lines.firstIndex(where: { $0.contains(from) }) else {
            XCTFail("no line containing \(from)")
            return []
        }
        let end = lines[(start + 1)...].firstIndex(where: { $0.contains(to) }) ?? lines.endIndex
        return Array(lines[start..<end])
    }

    func testEveryRouteOfAnExplorerOpenShouldCarryTheLineToThePageThatShowsTheFile() {
        let open = body(of: "func openFromExplorer(", in: "WindowSet.swift")
        guard !open.isEmpty else { return }
        XCTAssertTrue(open.first?.contains("revealing line: Int?") == true,
                      "openFromExplorer no longer takes the line, so no route can carry it")

        // Route 2: a new tab of this window. The tab is made and asked
        // before it is shown, so its cold page's first init carries the line.
        let tab = segment(open, from: "let tabHere", to: "switch routed")
        XCTAssertTrue(tab.contains { $0.contains("reveal(line:") },
                      "the new-tab route drops the line: " + tab.joined(separator: "\n"))
        XCTAssertTrue(tab.contains { $0.contains("makeWindow(") },
                      "the new-tab closure no longer makes the tab; this guard is watching the wrong lines")

        // Route 3: the file is already open in a window, which is fronted.
        // No page is coming, so the one that has the file is sent the line.
        let existing = segment(open, from: "case let .existing", to: "case .tabHere")
        XCTAssertTrue(existing.contains { $0.contains("reveal(line:") },
                      "the fronted-window route drops the line: " + existing.joined(separator: "\n"))
        XCTAssertTrue(existing.contains { $0.contains("show()") },
                      "the fronted-window route no longer fronts; this guard is watching the wrong arm")

        // Route 1: this window reloads onto the file. The line goes with the
        // reload rather than through `reveal`, which would reach the page
        // being replaced.
        let replace = segment(open, from: "case .replaceHere", to: "        }")
        XCTAssertTrue(replace.contains { $0.contains("replaceFile(with:") && $0.contains("revealing: line") },
                      "the replace route drops the line: " + replace.joined(separator: "\n"))
    }

    func testRevealShouldSendToAWarmPageAndHoldForAColdOne() {
        let reveal = body(of: "func reveal(line: Int)", in: "Coordinator.swift")
        guard !reveal.isEmpty else { return }
        XCTAssertTrue(reveal.contains { $0.contains("host.send(.scrollToLine(line: line))") },
                      "a warm page is never told the line: " + reveal.joined(separator: "\n"))
        XCTAssertTrue(reveal.contains { $0.contains("pendingRevealLine = line") },
                      "a page not yet up loses the line, so a new tab opens where the note was left")
        XCTAssertTrue(reveal.contains { $0.contains(".warm") },
                      "the two are not told apart by the page's state; a send to a loading page is lost")
    }

    func testAHeldLineShouldRideTheNextInitAndBeSpentByIt() {
        let lines = source("Coordinator.swift")
        guard !lines.isEmpty else { return }
        guard let send = lines.firstIndex(where: { $0.contains("host.send(.initDoc(") }) else {
            XCTFail("Coordinator no longer sends initDoc; this guard needs rewriting")
            return
        }
        // The call and its continuation lines, up to the closing paren.
        let call = Array(lines[send...].prefix { !$0.contains("state = .warm") })
        XCTAssertTrue(call.contains { $0.contains("scrollToLine:") },
                      "the held line never reaches init: " + call.joined(separator: "\n"))
        // Spent, not merely read: a line that survived its init would land
        // the next remount of this window on it too.
        let before = Array(lines[max(0, send - 8)..<send])
        XCTAssertTrue(before.contains { $0.contains("pendingRevealLine = nil") },
                      "the held line is not cleared beside the init that carried it")

        // And the reload route holds its line BEFORE the page is rebuilt, so
        // the init that page sends finds it there.
        let inPlace = body(of: "func openInPlace(", in: "Coordinator.swift")
        guard !inPlace.isEmpty else { return }
        let held = inPlace.firstIndex { $0.contains("pendingRevealLine = line") }
        let load = inPlace.firstIndex { $0.contains("loadPage()") }
        XCTAssertNotNil(held, "openInPlace does not hold the line it was handed")
        XCTAssertNotNil(load, "openInPlace no longer reloads; this guard needs rewriting")
        if let held, let load {
            XCTAssertLessThan(held, load, "the line is held after the reload it is meant for")
        }
    }
}
