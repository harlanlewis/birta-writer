import XCTest
@testable import BirtaWriterCore

/// What a new note gets called.
///
/// The interesting half is not that `%Y-%m-%d` expands, which is `strftime`'s
/// job and not ours. It is everything between a date format and a FILENAME: a
/// format that produces a path separator, one that produces nothing, one that
/// produces a hidden file. Each of those reaches the disk, and the rule this
/// type keeps is that none of them can stop a note being made.
final class NoteNameTemplateTests: XCTestCase {
    /// Fixed, so an assertion about a spelling is not an assertion about today.
    private let noon = Date(timeIntervalSince1970: 1_787_227_200)  // 2026-08-20 12:00 UTC
    private let utc = TimeZone(identifier: "UTC")!

    private func expand(_ template: String) -> String {
        NoteNameTemplate.expand(template, at: noon, timeZone: utc)
    }

    func testTheDefaultTemplateShouldNameTheNoteByDay() {
        XCTAssertEqual(expand(NoteNameTemplate.default), "Note 2026-08-20.md")
    }

    func testEveryTokenThatTheHelpTextAdvertisesShouldActuallyExpand() {
        // The help text is a promise printed under the field, so it is checked
        // rather than trusted: a token listed there and not supported would be
        // a documented format that silently files notes under its own name.
        // Derived from the help string itself, so the two cannot drift.
        let advertised = NoteNameTemplate.helpText
            .split(whereSeparator: { !"%abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".contains($0) })
            .filter { $0.hasPrefix("%") }.map(String.init)
        XCTAssertEqual(advertised.count, 6, "the help text no longer lists six tokens: \(advertised)")
        for token in advertised {
            let produced = expand("N\(token).md")
            XCTAssertNotEqual(produced, "N\(token).md", "\(token) was printed literally rather than expanded")
            XCTAssertFalse(produced.isEmpty)
        }
    }

    func testKnownTokensShouldSpellTheFixedDate() {
        XCTAssertEqual(expand("%Y.md"), "2026.md")
        XCTAssertEqual(expand("%m.md"), "08.md")
        XCTAssertEqual(expand("%d.md"), "20.md")
        XCTAssertEqual(expand("%H-%M-%S.md"), "12-00-00.md")
    }

    func testATemplateProducingAPathSeparatorShouldNotProduceAPath() {
        // `%D` is a real strftime token and spells 08/20/26. A slash in a name
        // is a directory that does not exist, so a note named from it would
        // simply fail to be written.
        let name = expand("Note %D.md")
        XCTAssertFalse(name.contains("/"), "a path separator survived into a filename: \(name)")
        XCTAssertEqual(name, "Note 08-20-26.md")
        XCTAssertFalse(expand("a:b.md").contains(":"))
    }

    func testATemplateThatExpandsToNothingShouldFallBackRatherThanFail() {
        // The empty case, and the one that is empty only after sanitizing: a
        // note called `.md` is a hidden file, which is not what anybody typing
        // a template meant.
        XCTAssertEqual(expand(""), "Note 2026-08-20.md")
        XCTAssertEqual(expand("   "), "Note 2026-08-20.md")
        XCTAssertEqual(expand(".md"), "Note 2026-08-20.md")
        for template in ["", "   ", ".md", "/", ":"] {
            let name = expand(template)
            XCTAssertFalse(name.hasPrefix("."), "\(template) produced a hidden file: \(name)")
            XCTAssertTrue(name.hasSuffix(".md"))
        }
    }

    func testTheExtensionShouldBeAddedButNeverDoubled() {
        XCTAssertEqual(expand("Note"), "Note.md")
        XCTAssertEqual(expand("Note.md"), "Note.md")
        XCTAssertEqual(expand("Note.MD"), "Note.MD")
        XCTAssertEqual(expand("Note.txt"), "Note.txt.md")
    }

    func testPartsShouldSplitWhereTheCollisionNumbererExpectsIt() {
        // `Coordinator.unusedURL(in:stem:extension:)` appends a number to the
        // STEM, so a split that handed it the whole filename would produce
        // `Note 2026-08-20.md 2` rather than `Note 2026-08-20 2.md`.
        let parts = NoteNameTemplate.parts(NoteNameTemplate.default, at: noon, timeZone: utc)
        XCTAssertEqual(parts.stem, "Note 2026-08-20")
        XCTAssertEqual(parts.ext, "md")
    }

    func testTheTimeZoneShouldDecideWhichDayItIs() {
        // The instrument's own control: without it, every assertion above
        // would pass on a formatter that ignored the zone entirely.
        let auckland = TimeZone(identifier: "Pacific/Auckland")!
        XCTAssertEqual(NoteNameTemplate.expand("%Y-%m-%d.md", at: noon, timeZone: utc), "2026-08-20.md")
        XCTAssertEqual(NoteNameTemplate.expand("%Y-%m-%d.md", at: noon, timeZone: auckland), "2026-08-21.md")
    }
}
