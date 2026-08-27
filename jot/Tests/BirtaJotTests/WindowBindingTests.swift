import XCTest
@testable import BirtaJot

/// WHICH file a window is on, and the rule that it is decided once.
///
/// `Coordinator.boundURL` used to default to `Prefs.activeURL` and be
/// re-derived from it on every page load. With one window that is
/// indistinguishable from correct, because there is only ever one answer. With
/// several it is the sharpest hazard in the file: `Prefs.activeURL` resolves
/// ONE file for the whole app, so a window reloading for any reason at all, a
/// settings change or a content-process death, would quietly snap onto
/// whichever file another window had bound last.
///
/// A source-text guard, which is the shape this suite already uses for launch
/// facts it cannot drive (`NotesMoveOfferLaunchTests` reads `App.swift` the
/// same way). Driving the real thing needs a mounted page and a second
/// WKWebView, and that check belongs to `jot/scripts/measure.sh`, which opens
/// two windows and reads both files back off the disk. What this holds is the
/// property that makes that check possible: the global is read in exactly one
/// named place, so a re-read added later is a red rather than a rebind nobody
/// sees.
@MainActor
final class WindowBindingTests: XCTestCase {
    /// The one function allowed to take a window's binding from app-wide
    /// settings, and the two gestures that call it are named in its own
    /// header.
    private let sanctioned = "rebindFromSettings"

    /// Reading the app's single active-file answer, in any spelling.
    private let globalReads = ["Prefs.activeURL", "Prefs.activeSlot", "Prefs.storedActiveURL"]

    private func coordinatorSource() throws -> [String] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaJotTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // jot
            .appendingPathComponent("Sources/BirtaJot/Coordinator.swift")
        guard let source = try? String(contentsOf: url, encoding: .utf8) else {
            // Not a skip. A guard that cannot find its subject has stopped
            // guarding, and that has to be a red rather than a silent pass.
            XCTFail("could not read \(url.path); if Coordinator.swift moved, this guard must follow it")
            return []
        }
        return source.components(separatedBy: "\n")
    }

    /// Prose mentions the global constantly and must not count as a read.
    private func isComment(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).hasPrefix("//")
    }

    func testTheActiveFileGlobalShouldBeReadInExactlyOnePlace() throws {
        let lines = try coordinatorSource()
        try XCTSkipIf(lines.isEmpty)

        guard let start = lines.firstIndex(where: { $0.contains("func \(sanctioned)(") }) else {
            return XCTFail("Coordinator has no \(sanctioned); this guard needs rewriting")
        }
        // A member's body ends at the first close brace back at member
        // indentation, which is where every function in this file sits.
        guard let end = lines[(start + 1)...].firstIndex(where: { $0 == "    }" }) else {
            return XCTFail("could not find the end of \(sanctioned)")
        }

        let reads = lines.indices.filter { index in
            !isComment(lines[index]) && globalReads.contains { lines[index].contains($0) }
        }

        XCTAssertFalse(reads.isEmpty,
                       "no read of the active-file global was found at all; either the spellings in "
                        + "globalReads are stale or this guard is watching nothing")
        for index in reads {
            XCTAssertTrue((start...end).contains(index),
                          "Coordinator.swift:\(index + 1) re-derives the binding from app-wide "
                            + "settings, outside \(sanctioned): "
                            + lines[index].trimmingCharacters(in: .whitespaces))
        }
    }

    /// The binding has to be handed in, or every window is the same window.
    /// A default value on the parameter would put the global back with none of
    /// the call sites changing, which is the version of this regression that
    /// no other check would see.
    func testAWindowShouldBeToldWhichFileItIsOnRatherThanAskingTheApp() throws {
        let lines = try coordinatorSource()
        try XCTSkipIf(lines.isEmpty)

        guard let initLine = lines.first(where: { $0.contains("init(boundTo") }) else {
            return XCTFail("Coordinator no longer takes its file at init; every window would be the same window")
        }
        XCTAssertFalse(initLine.contains("="),
                       "the bound file must be required, not defaulted: " + initLine)
    }
}
