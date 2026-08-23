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

    /// The rows a chord matches, which must be exactly one.
    ///
    /// Asked of `JotMenu.rows`, the whole table, rather than of the keyed
    /// subset the page is told about: a chord bound twice is the thing being
    /// ruled out, and a filter over the subset would miss a second binding
    /// that the subset happens not to carry.
    ///
    /// The WHOLE modifier mask has to match, not the two flags the tour can
    /// spell. `Cmd+F` and `Cmd+Alt+F` are different chords that AppKit tells
    /// apart, so a predicate reading only Command and Shift counts the second
    /// as a duplicate binding of the first and fails on a table that is
    /// correct. The tour's vocabulary is `Cmd+X` and `Cmd+Shift+X`, so the mask
    /// it names is exactly one of these two.
    private func rowsBinding(_ chord: (shift: Bool, key: String)) -> [JotMenu.Row] {
        let named: NSEvent.ModifierFlags = chord.shift ? [.command, .shift] : [.command]
        return JotMenu.rows.filter { row in
            row.modifiers == named && row.key.lowercased() == chord.key
        }
    }

    func testEveryChordTheTourNamesShouldBeBoundInTheMenu() {
        let chords = chordsNamedInTheTour()
        // The instrument has to have reached something. A regex that stopped
        // matching would otherwise report a tour with no false claims in it.
        XCTAssertGreaterThanOrEqual(chords.count, 3, "the tour should still be naming chords")

        for chord in chords {
            let spelling = "Cmd+\(chord.shift ? "Shift+" : "")\(chord.key)"
            let rows = rowsBinding(chord)
            // EXACTLY one, not at least one. As the table grows, "something
            // binds this" gets easier to satisfy by accident, and a chord
            // bound twice is one whose behaviour depends on menu order rather
            // than on what the tour says it does.
            XCTAssertEqual(rows.count, 1,
                           "the tour names \(spelling); JotMenu.rows binds it \(rows.count) times"
                            + (rows.isEmpty ? "" : " (\(rows.map(\.title).joined(separator: ", ")))"))
        }
    }

    /// The chord the tour spends its central gesture on, tied to the command
    /// it claims that chord runs.
    ///
    /// The test above only asks whether something binds a chord, which stops
    /// the tour naming a dead key and does not stop it naming a live one that
    /// does something else. That distinction is not hypothetical as the menu
    /// grows: move Toggle Task Done to another chord while any new row takes
    /// Cmd+Shift+D and the tour goes on telling somebody to press it to tick a
    /// box, with every other check here green.
    ///
    /// One pair rather than a table of them, because this is the only chord in
    /// the tour whose sentence names an outcome the menu row also names. The
    /// others send the reader to a surface (Settings, a new note, find) that
    /// the row title already is.
    func testTheChordTheTourTicksABoxWithShouldBeTheTaskCommand() {
        XCTAssertTrue(FirstRunNote.markdown.contains("Cmd+Shift+D"),
                      "the tour should still teach a chord for ticking a box")
        let rows = rowsBinding((shift: true, key: "d"))
        XCTAssertEqual(rows.map(\.title), ["Toggle Task Done"])
    }

    /// And that the match above can fail. A predicate that says yes to
    /// everything would pass the test above on any prose at all.
    func testAChordNothingBindsShouldNotMatch() {
        let bound = JotMenu.rows.contains { row in
            row.modifiers.contains(.command)
                && row.modifiers.contains(.shift) == false
                && row.key.lowercased() == "q"
        }
        XCTAssertFalse(bound, "Cmd+Q is AppKit's, not a row in this table")
    }
}
