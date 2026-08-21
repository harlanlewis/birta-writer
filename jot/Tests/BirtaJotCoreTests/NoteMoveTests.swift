import XCTest
@testable import BirtaJotCore

/// What a move of Jot's notes would do, decided with no disk in the room.
///
/// The plan is the half worth testing hardest, because it is the half the
/// offer SHOWS: the button names a count, and a count that came from anywhere
/// other than the work about to be done is a number that can be wrong.
final class NoteMoveTests: XCTestCase {
    private let source = URL(fileURLWithPath: "/old/notes")
    private let destination = URL(fileURLWithPath: "/new/notes")

    private func url(_ path: String) -> URL { URL(fileURLWithPath: path) }

    /// Nothing at the destination, so nothing is numbered.
    private let nothingThere: (URL) -> Bool = { _ in false }

    func testEveryTopLevelMarkdownFileShouldTravel() {
        let plan = NoteMove.plan(
            source: source, destination: destination,
            entries: [url("/old/notes/a.md"), url("/old/notes/b.md")],
            attachments: [], exists: nothingThere)

        XCTAssertEqual(plan.noteCount, 2)
        XCTAssertEqual(plan.items.map(\.destination.path),
                       ["/new/notes/a.md", "/new/notes/b.md"])
        XCTAssertEqual(plan.leftBehind, [])
    }

    /// The folder is shared, so a file Jot did not put there stays put.
    func testAFileThatIsNotANoteShouldBeLeftBehindAndNamed() {
        let stranger = url("/old/notes/taxes.pdf")
        let plan = NoteMove.plan(
            source: source, destination: destination,
            entries: [url("/old/notes/a.md"), stranger, url("/old/notes/.DS_Store")],
            attachments: [], exists: nothingThere)

        XCTAssertEqual(plan.noteCount, 1, "only the note travels")
        XCTAssertEqual(plan.leftBehind.map(\.lastPathComponent), [".DS_Store", "taxes.pdf"],
                       "everything that stays is named, so the caller can say so")
    }

    /// A note by the same name at the destination is a DIFFERENT note.
    /// Overwriting it would be the loss this whole feature exists to prevent.
    func testANoteWhoseNameIsTakenShouldBeNumberedRatherThanOverwrite() {
        let plan = NoteMove.plan(
            source: source, destination: destination,
            entries: [url("/old/notes/Jot.md")],
            attachments: [],
            exists: { $0.path == "/new/notes/Jot.md" })

        XCTAssertEqual(plan.items.first?.destination.path, "/new/notes/Jot 2.md")
    }

    /// The numbering keeps counting past a run of taken names.
    func testNumberingShouldSkipEveryNameAlreadyTaken() {
        let taken: Set<String> = ["/new/notes/Jot.md", "/new/notes/Jot 2.md", "/new/notes/Jot 3.md"]
        let plan = NoteMove.plan(
            source: source, destination: destination,
            entries: [url("/old/notes/Jot.md")],
            attachments: [],
            exists: { taken.contains($0.path) })

        XCTAssertEqual(plan.items.first?.destination.path, "/new/notes/Jot 4.md")
    }

    /// Two notes that would land on one name must not both get it.
    ///
    /// `exists` cannot see a file the plan is about to create, so without the
    /// plan claiming its own names this returns the same destination twice and
    /// the second copy silently overwrites the first.
    func testTwoNotesLandingOnOneNameShouldNotBothGetIt() {
        // Both source folders are flattened into one destination in the real
        // gesture only when names collide; here the destination already holds
        // `Jot.md`, so the first becomes `Jot 2.md` and the second must not.
        let plan = NoteMove.plan(
            source: source, destination: destination,
            entries: [url("/old/notes/Jot.md"), url("/old/a/Jot.md")],
            attachments: [],
            exists: { $0.path == "/new/notes/Jot.md" })

        let landings = plan.items.map(\.destination.path)
        XCTAssertEqual(Set(landings).count, landings.count,
                       "two notes must not be planned onto one path")
        XCTAssertEqual(landings, ["/new/notes/Jot 2.md", "/new/notes/Jot 3.md"])
    }

    /// THE ONE THAT MATTERS. Attachments merge into the destination's own
    /// `Attachments` folder and are never numbered.
    ///
    /// Notes reference images relatively, as `Attachments/<name>.png`. Landing
    /// the folder as `Attachments 2` because one was already there would break
    /// every image in every note that just moved, in files that still open.
    func testAttachmentsShouldMergeIntoTheDestinationFolderRatherThanBeNumbered() {
        let plan = NoteMove.plan(
            source: source, destination: destination,
            entries: [],
            attachments: [url("/old/notes/Attachments/abc123.png")],
            // The destination already HAS an Attachments folder.
            exists: { $0.path == "/new/notes/Attachments" })

        XCTAssertEqual(plan.items.map(\.destination.path),
                       ["/new/notes/Attachments/abc123.png"],
                       "the file lands in the existing folder, keeping its relative reference intact")
        XCTAssertTrue(plan.items.allSatisfy(\.isAttachment))
    }

    /// A colliding attachment name is the same bytes, so it is skipped.
    /// `AttachmentStore` names a file after a hash of its content.
    func testAnAttachmentAlreadyAtTheDestinationShouldBeSkippedAndReported() {
        let already = url("/old/notes/Attachments/abc123.png")
        let plan = NoteMove.plan(
            source: source, destination: destination,
            entries: [],
            attachments: [already, url("/old/notes/Attachments/def456.png")],
            exists: { $0.path == "/new/notes/Attachments/abc123.png" })

        XCTAssertEqual(plan.items.map(\.destination.lastPathComponent), ["def456.png"])
        XCTAssertEqual(plan.duplicateAttachments, [already],
                       "a skipped attachment is accounted for rather than silently dropped")
    }

    /// The count on the button is notes, not files. Attachments travel with
    /// the writing rather than being a second thing to decide about.
    func testTheCountShouldBeNotesAndNotAttachments() {
        let plan = NoteMove.plan(
            source: source, destination: destination,
            entries: [url("/old/notes/a.md")],
            attachments: [url("/old/notes/Attachments/x.png"),
                          url("/old/notes/Attachments/y.png")],
            exists: nothingThere)

        XCTAssertEqual(plan.noteCount, 1)
        XCTAssertEqual(plan.items.count, 3, "everything travels")
    }

    /// No notes means no dialog. An offer with nothing behind it is noise.
    func testAFolderWithNoNotesShouldProduceNothingToOffer() {
        let plan = NoteMove.plan(
            source: source, destination: destination,
            entries: [url("/old/notes/taxes.pdf")],
            attachments: [], exists: nothingThere)

        XCTAssertTrue(plan.isEmpty)
        XCTAssertEqual(plan.noteCount, 0)
    }

    /// Case: `.MD` is a markdown file too.
    func testAnUppercaseExtensionShouldStillBeANote() {
        let plan = NoteMove.plan(
            source: source, destination: destination,
            entries: [url("/old/notes/A.MD")],
            attachments: [], exists: nothingThere)

        XCTAssertEqual(plan.noteCount, 1)
        XCTAssertEqual(plan.leftBehind, [])
    }
}
