import XCTest
import AppKit
@testable import BirtaJot
@testable import BirtaJotCore

/// The tour tells somebody which keys to press, and this is what stops it
/// telling them a key nothing binds.
///
/// A document cannot go red on its own, which is the whole problem: rebind
/// Toggle Task Done or drop it from the menu and the note keeps saying
/// Cmd+Shift+D, in the one place where the reader has no reason to doubt it
/// and no way to check. So the chords are read back OUT of the prose and
/// matched against the table the menu is actually built from.
///
/// It reads `FirstRunNote.markdown` rather than a list kept here, so a chord
/// added to the tour is covered by the fact of being written, and the count
/// assertion below is what stops a parse that quietly stopped finding any.
final class FirstRunNoteShortcutsTests: XCTestCase {

    /// Every `Cmd+…` the tour names, as (shift, key).
    private func chordsNamedInTheTour() -> [(shift: Bool, key: String)] {
        let text = FirstRunNote.markdown
        var found: [(shift: Bool, key: String)] = []
        // `Cmd+X` or `Cmd+Shift+X`, where X is one character: the whole
        // vocabulary the tour uses, and deliberately not a general chord
        // parser, which would be a second thing to get right.
        let pattern = try! NSRegularExpression(pattern: "Cmd\\+(Shift\\+)?(.)")
        let range = NSRange(text.startIndex..., in: text)
        for match in pattern.matches(in: text, range: range) {
            guard let keyRange = Range(match.range(at: 2), in: text) else { continue }
            let shift = match.range(at: 1).location != NSNotFound
            found.append((shift: shift, key: String(text[keyRange]).lowercased()))
        }
        return found
    }

    func testEveryChordTheTourNamesShouldBeBoundInTheMenu() {
        let chords = chordsNamedInTheTour()
        // The instrument has to have reached something. A regex that stopped
        // matching would otherwise report a tour with no false claims in it.
        XCTAssertGreaterThanOrEqual(chords.count, 3, "the tour should still be naming chords")

        for chord in chords {
            let bound = JotMenu.shortcuts.contains { row in
                row.modifiers.contains(.command)
                    && row.modifiers.contains(.shift) == chord.shift
                    && row.key.lowercased() == chord.key
            }
            let spelling = "Cmd+\(chord.shift ? "Shift+" : "")\(chord.key)"
            XCTAssertTrue(bound, "the tour names \(spelling), which JotMenu.shortcuts does not bind")
        }
    }

    /// And that the match above can fail. A predicate that says yes to
    /// everything would pass the test above on any prose at all.
    func testAChordNothingBindsShouldNotMatch() {
        let bound = JotMenu.shortcuts.contains { row in
            row.modifiers.contains(.command)
                && row.modifiers.contains(.shift) == false
                && row.key.lowercased() == "q"
        }
        XCTAssertFalse(bound, "Cmd+Q is AppKit's, not a row in this table")
    }
}
