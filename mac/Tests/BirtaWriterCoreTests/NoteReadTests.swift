import XCTest
@testable import BirtaWriterCore

/// Reading the note, and the distinction the type exists for: a file that is
/// NOT THERE against a file that is there and cannot be read.
///
/// The old reader was `(try? String(contentsOf:)) ?? ""`, which answers the
/// same empty string to both. Every case below that returns `.unreadable` is
/// one that reader got wrong, and each is written so it would fail against it.
final class NoteReadTests: XCTestCase {
    private var dir: URL!
    private var note: URL!

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("note-read-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        note = dir.appendingPathComponent("Birta Writer.md")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: the two cases that were always right

    func testAReadableFileShouldComeBackAsItsContents() throws {
        try "hello".write(to: note, atomically: true, encoding: .utf8)
        XCTAssertEqual(NoteRead.read(at: note), .contents("hello"))
    }

    /// An empty FILE is contents, not absence. The two are different states
    /// and only one of them is safe to write over.
    func testAnEmptyFileShouldBeEmptyContentsRatherThanAbsent() throws {
        try "".write(to: note, atomically: true, encoding: .utf8)
        XCTAssertEqual(NoteRead.read(at: note), .contents(""))
    }

    func testNothingAtThePathShouldBeAbsent() {
        XCTAssertEqual(NoteRead.read(at: note), .absent)
    }

    // MARK: the case the old reader got wrong

    /// THE bug. macOS evicts the note and leaves `.Birta Writer.md.icloud`
    /// beside it, so the note's own path stops existing while the note does
    /// not. The old reader answered "" here, the app mounted an empty buffer, and
    /// the next write put that buffer where the note had been.
    func testAnEvictedFileShouldBeUnreadableRatherThanAbsent() throws {
        let placeholder = dir.appendingPathComponent(".Birta Writer.md.icloud")
        try Data().write(to: placeholder)
        XCTAssertFalse(FileManager.default.fileExists(atPath: note.path),
                       "the note's own path must be gone, or this is not the evicted case")
        XCTAssertEqual(NoteRead.read(at: note), .unreadable(.notDownloaded))
    }

    /// Both facts are true of an evicted note at once: its path is absent, and
    /// the placeholder is present. Asking in the wrong order answers `.absent`
    /// for every evicted note, so the ORDER is the thing under test and this
    /// pins it.
    func testThePlaceholderShouldBeCheckedBeforePlainAbsence() throws {
        let placeholder = dir.appendingPathComponent(".Birta Writer.md.icloud")
        try Data().write(to: placeholder)
        let read = NoteRead.read(at: note)
        XCTAssertNotEqual(read, .absent)
        XCTAssertEqual(read, .unreadable(.notDownloaded))
    }

    /// A placeholder for a DIFFERENT note must not make this one unreadable.
    /// The name is derived from the file, and a version that merely looked for
    /// any `.icloud` in the directory would pass every test above and fail
    /// this one.
    func testAPlaceholderForAnotherNoteShouldNotCount() throws {
        try Data().write(to: dir.appendingPathComponent(".Something Else.md.icloud"))
        XCTAssertEqual(NoteRead.read(at: note), .absent)
    }

    func testAPathThatExistsButCannotBeReadShouldBeUnreadable() throws {
        // A DIRECTORY where the note should be: it exists, and reading it as
        // text fails. The same shape as a permission problem, without needing
        // to change permissions in a test.
        try FileManager.default.createDirectory(at: note, withIntermediateDirectories: true)
        XCTAssertEqual(NoteRead.read(at: note), .unreadable(.unreadableFile))
    }

    // MARK: what the user is told

    /// Only the unreadable cases say anything. A new note and a real one are
    /// both ordinary, and a message on either would be noise on every launch.
    func testOnlyTheUnreadableCasesShouldCarryAMessage() throws {
        XCTAssertNil(NoteRead.contents("x").message)
        XCTAssertNil(NoteRead.absent.message)
        var messages = Set<String>()
        for reason: NoteRead.UnreadableReason in [.notDownloaded, .unreadableFile] {
            let message = NoteRead.unreadable(reason).message
            XCTAssertNotNil(message, "\(reason)")
            messages.insert(message ?? "")
        }
        // Distinct, or one of the two reasons is not worth having.
        XCTAssertEqual(messages.count, 2)
        // "Nothing saves" carries both halves at once, and the second is the
        // one easily dropped: the note is safe, AND the panel is not taking
        // work. A message promising only the first invites someone to type
        // into a panel that is discarding it.
        for message in messages {
            XCTAssertTrue(message.contains("Nothing saves"), "does not say nothing saves: \(message)")
        }
        // Short enough for the surface that draws them. `StatusOverlay` is one
        // line, no wider than half the window, truncated in the MIDDLE, so an
        // overlong warning loses its own middle and reads as damage. Nothing
        // about writing the string says that, which is why it is asserted.
        for message in messages {
            XCTAssertLessThanOrEqual(message.count, NoteRead.messageLimit, message)
        }
    }

    func testThePlaceholderNameShouldFollowTheFilesOwnName() {
        XCTAssertEqual(NoteRead.placeholderName(for: "Birta Writer.md"),
                       ".Birta Writer.md.icloud")
        XCTAssertEqual(NoteRead.placeholderName(for: "a.md"), ".a.md.icloud")
    }
}
