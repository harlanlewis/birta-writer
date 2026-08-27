import XCTest
@testable import BirtaWriterCore

/// What moves when the notes location changes, and what deliberately does not.
final class NotesMoveTests: XCTestCase {

    private let from = URL(fileURLWithPath: "/Users/me/Documents/Birta Writer", isDirectory: true)
    private let to = URL(fileURLWithPath: "/Users/me/iCloud/Birta Writer", isDirectory: true)

    private func file(_ name: String) -> URL { from.appendingPathComponent(name) }
    private func attachment(_ name: String) -> URL {
        from.appendingPathComponent("Attachments", isDirectory: true).appendingPathComponent(name)
    }
    private func empty(_: URL) -> Bool { false }

    // ── Scope ──────────────────────────────────────────────────

    func testNotesAreCarriedAndTheirNamesKeptWhenNothingIsInTheWay() {
        let plan = NotesMove.plan(from: from, to: to,
                                  entries: [file("a.md"), file("b.md")], occupied: empty)

        XCTAssertEqual(plan.items.count, 2)
        XCTAssertEqual(plan.items.map(\.destination.lastPathComponent), ["a.md", "b.md"])
        XCTAssertEqual(plan.noteCount, 2)
        XCTAssertTrue(plan.kept.isEmpty)
    }

    /// The notes directory is the scratchpad's PARENT, which the app does not own,
    /// so anything that is not a note stays and is reported.
    func testSomebodyElsesFilesAreLeftWhereTheyAreAndReported() {
        let plan = NotesMove.plan(
            from: from, to: to,
            entries: [file("a.md"), file("taxes.pdf"), file("script.sh")], occupied: empty)

        XCTAssertEqual(plan.items.map(\.source.lastPathComponent), ["a.md"])
        XCTAssertEqual(plan.kept, [.notOurs(file("script.sh")), .notOurs(file("taxes.pdf"))])
    }

    func testTheAttachmentsFolderIsNeverCarriedAsAnEntryOfItsOwn() {
        let plan = NotesMove.plan(
            from: from, to: to,
            entries: [file("a.md"), from.appendingPathComponent("Attachments", isDirectory: true)],
            occupied: empty)

        XCTAssertEqual(plan.items.count, 1)
        XCTAssertTrue(plan.kept.isEmpty, "the folder is handled as its contents, not left behind")
    }

    // ── Collisions ─────────────────────────────────────────────

    func testANoteWhoseNameIsTakenIsNumberedRatherThanOverwritten() {
        let occupied: (URL) -> Bool = { $0.lastPathComponent == "a.md" }

        let plan = NotesMove.plan(from: from, to: to, entries: [file("a.md")], occupied: occupied)

        XCTAssertEqual(plan.items.first?.destination.lastPathComponent, "a 2.md")
    }

    func testNumberingStepsPastEveryNameAlreadyThere() {
        let occupied: (URL) -> Bool = { ["a.md", "a 2.md", "a 3.md"].contains($0.lastPathComponent) }

        let plan = NotesMove.plan(from: from, to: to, entries: [file("a.md")], occupied: occupied)

        XCTAssertEqual(plan.items.first?.destination.lastPathComponent, "a 4.md")
    }

    /// Nothing in one plan may be numbered onto a name the same plan has
    /// already spoken for, or the second copy silently replaces the first.
    func testTwoItemsNeverLandOnOneName() {
        var seen: Set<String> = []
        let plan = NotesMove.plan(
            from: from, to: to,
            entries: [file("a.md"), file("a 2.md")],
            occupied: { $0.lastPathComponent == "a.md" })

        for item in plan.items {
            XCTAssertTrue(seen.insert(item.destination.path).inserted,
                          "two sources landed on \(item.destination.lastPathComponent)")
        }
        XCTAssertEqual(plan.items.count, 2)
    }

    // ── Attachments, which are the dangerous half ──────────────

    func testAttachmentsTravelIntoTheDestinationsOwnAttachmentsFolder() {
        let plan = NotesMove.plan(from: from, to: to, entries: [file("a.md")],
                                  attachments: [attachment("ab12.png")], occupied: empty)

        let moved = plan.items.first { !$0.renameable }
        XCTAssertEqual(moved?.destination.path,
                       to.appendingPathComponent("Attachments").appendingPathComponent("ab12.png").path)
        // Carried because the notes need them, not counted as notes.
        XCTAssertEqual(plan.noteCount, 1)
    }

    /// The one that would ship unnoticed: numbering a colliding attachment
    /// leaves every note that references it pointing at nothing, in files that
    /// still open fine.
    func testACollidingAttachmentIsNeverRenamed() {
        let plan = NotesMove.plan(
            from: from, to: to, entries: [],
            attachments: [attachment("ab12.png")],
            occupied: { $0.lastPathComponent == "ab12.png" },
            identical: { _, _ in false })

        XCTAssertTrue(plan.items.isEmpty)
        XCTAssertEqual(plan.kept, [.attachmentNameTaken(attachment("ab12.png"))])
    }

    /// `AttachmentStore` names by content hash, so a name that is taken almost
    /// always means the same bytes are already there. Nothing to do, and
    /// nothing worth telling anyone about.
    func testAnAttachmentAlreadyThereByTheSameBytesIsSkippedQuietly() {
        let plan = NotesMove.plan(
            from: from, to: to, entries: [],
            attachments: [attachment("ab12.png")],
            occupied: { $0.lastPathComponent == "ab12.png" },
            identical: { _, _ in true })

        XCTAssertTrue(plan.items.isEmpty)
        XCTAssertTrue(plan.kept.isEmpty)
    }

    func testEveryAttachmentItemIsMarkedUnrenameable() {
        let plan = NotesMove.plan(from: from, to: to, entries: [file("a.md")],
                                  attachments: [attachment("x.png"), attachment("y.png")],
                                  occupied: empty)

        let attachments = plan.items.filter { $0.source.path.contains("/Attachments/") }
        XCTAssertEqual(attachments.count, 2)
        XCTAssertTrue(attachments.allSatisfy { !$0.renameable })
        XCTAssertTrue(plan.items.filter { $0.renameable }.allSatisfy { $0.source.pathExtension == "md" })
    }

    // ── The exemption ──────────────────────────────────────────

    /// A rename in place changes the file's name, not where the notes live, so
    /// there is nothing to offer to move. The title popover already renames
    /// without asking.
    func testTheSameDirectoryIsNotAMoveAtAll() {
        let plan = NotesMove.plan(from: from, to: from,
                                  entries: [file("a.md")], attachments: [attachment("x.png")],
                                  occupied: empty)

        XCTAssertTrue(plan.isEmpty)
        XCTAssertTrue(plan.kept.isEmpty)
    }

    func testAPathThatOnlyLooksDifferentIsStillTheSameDirectory() {
        let scenic = URL(fileURLWithPath: "/Users/me/Documents/Birta Writer/./", isDirectory: true)

        let plan = NotesMove.plan(from: from, to: scenic, entries: [file("a.md")], occupied: empty)

        XCTAssertTrue(plan.isEmpty)
    }

    // ── The offer's own precondition ───────────────────────────

    func testAnEmptyFolderProducesNothingToOffer() {
        let plan = NotesMove.plan(from: from, to: to, entries: [], occupied: empty)

        XCTAssertTrue(plan.isEmpty)
        XCTAssertEqual(plan.noteCount, 0)
    }

    func testAFolderOfOnlyForeignFilesOffersNoMove() {
        let plan = NotesMove.plan(from: from, to: to,
                                  entries: [file("taxes.pdf")], occupied: empty)

        XCTAssertTrue(plan.isEmpty, "nothing of ours to carry, so no sheet")
        XCTAssertEqual(plan.kept.count, 1)
    }
}

/// The doing half, against a real temp directory: copy, verify, remove.
final class NotesMovePerformTests: XCTestCase {

    private var root: URL!
    private var from: URL!
    private var to: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("notesmove-\(UUID().uuidString)", isDirectory: true)
        from = root.appendingPathComponent("old", isDirectory: true)
        to = root.appendingPathComponent("new", isDirectory: true)
        try FileManager.default.createDirectory(at: from, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    @discardableResult
    private func write(_ text: String, _ name: String) throws -> URL {
        let url = from.appendingPathComponent(name)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    private func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }

    func testAMovedNoteArrivesWholeAndLeavesNothingBehind() throws {
        let source = try write("# Plan\n", "a.md")
        let plan = NotesMove.plan(from: from, to: to, entries: [source], occupied: { _ in false })

        let report = NotesMove.perform(plan)

        XCTAssertEqual(report.moved, 1)
        XCTAssertTrue(report.failed.isEmpty)
        XCTAssertFalse(exists(source), "the original should be gone once the copy verified")
        let landed = to.appendingPathComponent("a.md")
        XCTAssertEqual(try String(contentsOf: landed, encoding: .utf8), "# Plan\n")
    }

    func testAttachmentsTravelSoTheirReferencesStillResolve() throws {
        let note = try write("![](Attachments/x.png)\n", "a.md")
        let image = try write("PNGBYTES", "Attachments/x.png")
        let plan = NotesMove.plan(from: from, to: to, entries: [note],
                                  attachments: [image], occupied: { _ in false })

        let report = NotesMove.perform(plan)

        XCTAssertEqual(report.moved, 2)
        // The reference in the note is relative, so this is the assertion that
        // says the note still works, not just that a file arrived.
        XCTAssertTrue(exists(to.appendingPathComponent("Attachments/x.png")))
    }

    /// The whole reason this copies rather than moves. A destination that
    /// cannot be written must leave the original exactly where it was.
    func testAFailedMoveLeavesTheOriginalAloneAndSaysSo() throws {
        let source = try write("# Plan\n", "a.md")
        // A FILE where the destination directory needs to be: createDirectory
        // fails, and so must everything after it.
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try "blocked".write(to: to, atomically: true, encoding: .utf8)
        let plan = NotesMove.plan(from: from, to: to, entries: [source], occupied: { _ in false })

        let report = NotesMove.perform(plan)

        XCTAssertEqual(report.moved, 0)
        XCTAssertEqual(report.failed, [source])
        XCTAssertTrue(exists(source), "a failed move must never take the original with it")
        XCTAssertEqual(try String(contentsOf: source, encoding: .utf8), "# Plan\n")
    }

    func testOneFailureDoesNotStopTheRest() throws {
        let good = try write("# A\n", "a.md")
        let bad = try write("# B\n", "b.md")
        // b.md's destination is occupied by a DIRECTORY, so its copy throws.
        try FileManager.default.createDirectory(
            at: to.appendingPathComponent("b.md"), withIntermediateDirectories: true)
        let plan = NotesMove.plan(from: from, to: to, entries: [good, bad], occupied: { _ in false })

        let report = NotesMove.perform(plan)

        XCTAssertEqual(report.moved, 1)
        XCTAssertEqual(report.failed, [bad])
        XCTAssertFalse(exists(good))
        XCTAssertTrue(exists(bad))
    }

    func testWhatWasLeftBehindIsCarriedThroughToTheReport() throws {
        let note = try write("# A\n", "a.md")
        let foreign = try write("not ours", "taxes.pdf")
        let plan = NotesMove.plan(from: from, to: to, entries: [note, foreign], occupied: { _ in false })

        let report = NotesMove.perform(plan)

        XCTAssertEqual(report.kept, [.notOurs(foreign)])
        XCTAssertTrue(exists(foreign), "a file that is not ours is never touched")
    }
}
