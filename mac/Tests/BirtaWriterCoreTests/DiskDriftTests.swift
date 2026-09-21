import XCTest
@testable import BirtaWriterCore

/// The rule that decides what happens when the bound file has changed
/// underneath the app (MAR-469).
///
/// Two halves, and they fail differently. The decision is pure and is checked
/// against every combination of (stamp, disk bytes, buffer bytes) that can
/// occur; the stamp itself is a question for the file system, so it is checked
/// against real files in a temporary directory, because what `DiskStamp.of`
/// has to be right about is what macOS reports and not what this file
/// believes.
final class DiskDriftTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("disk-drift-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
        try super.tearDownWithError()
    }

    private func file(_ name: String, _ text: String) throws -> URL {
        let url = directory.appendingPathComponent(name)
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    private func stamp(_ device: Int = 1, _ inode: Int = 7,
                       _ seconds: TimeInterval = 1_000, _ size: Int = 3) -> DiskStamp {
        DiskStamp(device: device, inode: inode,
                  modified: Date(timeIntervalSince1970: seconds), size: size)
    }

    // ── The decision ──────────────────────────────────────────────────────

    /// A reader that says the test's expectation about whether the bytes were
    /// needed at all. The cheap path exists to keep a summon and a write off a
    /// whole-file read, so "did it read" is part of the behaviour rather than
    /// an implementation detail.
    private final class Reader {
        var reads = 0
        let answer: NoteRead
        init(_ answer: NoteRead) { self.answer = answer }
        func read() -> NoteRead { reads += 1; return answer }
    }

    func testAMatchingStampShouldBeInStepWithoutReadingTheFile() {
        let known = stamp()
        let reader = Reader(.contents("anything at all"))
        let verdict = DiskDrift.judge(baseline: DiskBaseline(stamp: known, content: "note"),
                                      current: known, read: reader.read, buffer: "note edited")
        XCTAssertEqual(verdict, .inStep(DiskBaseline(stamp: known, content: "note")))
        XCTAssertEqual(reader.reads, 0, "a stamp that matches settles it; the bytes are not needed")
    }

    func testAMovedStampOverTheSameBytesShouldBeInStepAtTheNewStamp() {
        let reader = Reader(.contents("note"))
        let now = stamp(1, 9, 2_000, 4)
        let verdict = DiskDrift.judge(baseline: DiskBaseline(stamp: stamp(), content: "note"),
                                      current: now, read: reader.read, buffer: "note")
        XCTAssertEqual(verdict, .inStep(DiskBaseline(stamp: now, content: "note")),
                       "the app's own atomic write publishes a new inode over identical bytes")
        XCTAssertEqual(reader.reads, 1)
    }

    func testAChangedFileUnderACleanBufferShouldRereadAtTheNewStamp() {
        let now = stamp(1, 9, 2_000, 7)
        let verdict = DiskDrift.judge(baseline: DiskBaseline(stamp: stamp(), content: "note"),
                                      current: now, read: { .contents("theirs") }, buffer: "note")
        XCTAssertEqual(verdict, .reread(DiskBaseline(stamp: now, content: "theirs")))
    }

    func testAChangedFileUnderAnEditedBufferShouldConflictCarryingWhatItSaw() {
        let now = stamp(1, 9, 2_000, 7)
        let verdict = DiskDrift.judge(baseline: DiskBaseline(stamp: stamp(), content: "note"),
                                      current: now, read: { .contents("theirs") }, buffer: "mine")
        XCTAssertEqual(verdict, .conflict(disk: "theirs", stamp: now),
                       "the answer is applied to the version that was shown, so it travels with it")
    }

    /// Dirty is asked of the BYTES. A buffer equal to what was last written is
    /// clean however many times the Edited flag has been raised and cleared,
    /// which is the distinction autosave makes impossible to read off a flag.
    func testABufferBackAtTheBaselineBytesShouldCountAsCleanRatherThanEdited() {
        let now = stamp(1, 9, 2_000, 7)
        let verdict = DiskDrift.judge(baseline: DiskBaseline(stamp: stamp(), content: "note"),
                                      current: now, read: { .contents("theirs") }, buffer: "note")
        XCTAssertEqual(verdict, .reread(DiskBaseline(stamp: now, content: "theirs")))
    }

    func testTwoChangesThatAgreeShouldBeInStepRatherThanAConflict() {
        let now = stamp(1, 9, 2_000, 5)
        let verdict = DiskDrift.judge(baseline: DiskBaseline(stamp: stamp(), content: "note"),
                                      current: now, read: { .contents("same") }, buffer: "same")
        XCTAssertEqual(verdict, .inStep(DiskBaseline(stamp: now, content: "same")),
                       "nothing is lost whichever wins, so there is nothing to ask about")
    }

    func testAnUnstampedBaselineShouldBeSettledByTheBytes() {
        let now = stamp()
        let verdict = DiskDrift.judge(baseline: DiskBaseline(stamp: nil, content: "note"),
                                      current: now, read: { .contents("note") }, buffer: "note")
        XCTAssertEqual(verdict, .inStep(DiskBaseline(stamp: now, content: "note")),
                       "a write not yet reported by the writer still has its bytes to go on")
    }

    /// The three shapes of "there is nothing here to compare against". Each is
    /// somebody else's question (`NoteRead`, `noteMissing`, a note never
    /// written), and answering any of them here would be a second rule.
    func testAFileThatIsNotThereOrNotReadableShouldBeNobodysConflict() {
        let reader = Reader(.contents("theirs"))
        XCTAssertEqual(DiskDrift.judge(baseline: DiskBaseline(stamp: stamp(), content: "note"),
                                       current: nil, read: reader.read, buffer: "mine"),
                       .unavailable)
        XCTAssertEqual(reader.reads, 0, "there is no file to read")
        XCTAssertEqual(DiskDrift.judge(baseline: DiskBaseline(stamp: stamp(), content: "note"),
                                       current: stamp(1, 9), read: { .absent }, buffer: "mine"),
                       .unavailable)
        XCTAssertEqual(DiskDrift.judge(baseline: DiskBaseline(stamp: stamp(), content: "note"),
                                       current: stamp(1, 9),
                                       read: { .unreadable(.notDownloaded) }, buffer: "mine"),
                       .unavailable)
    }

    /// Every combination the three inputs can take, so the cases above are a
    /// reading of the rule rather than a sample of it: a verdict that writes
    /// (`inStep`) is reachable only where nothing on disk would be lost.
    func testNoCombinationShouldWriteOverBytesTheBufferHasNotSeen() {
        let texts = ["base", "theirs", "mine"]
        var covered = 0
        for disk in texts {
            for buffer in texts {
                for matching in [true, false] {
                    let known = stamp()
                    let current = matching ? known : stamp(1, 9, 2_000, disk.utf8.count)
                    let verdict = DiskDrift.judge(
                        baseline: DiskBaseline(stamp: known, content: "base"),
                        current: current, read: { .contents(disk) }, buffer: buffer)
                    covered += 1
                    guard case .inStep = verdict else { continue }
                    XCTAssertTrue(matching || disk == "base" || disk == buffer,
                                  "in step with \(disk) on disk and \(buffer) in the buffer would "
                                  + "write over bytes nobody here has seen")
                }
            }
        }
        XCTAssertEqual(covered, 18, "every combination was judged")
    }

    // ── The stamp ─────────────────────────────────────────────────────────

    func testAFileShouldStampItsOwnIdentityAndLength() throws {
        let url = try file("note.md", "hello")
        let stamped = try XCTUnwrap(DiskStamp.of(url))
        XCTAssertEqual(stamped.size, 5)
        XCTAssertEqual(DiskStamp.of(url), stamped, "a stat with nothing in between reads the same")
    }

    func testAFileRewrittenInPlaceShouldStampDifferently() throws {
        let url = try file("note.md", "hello")
        let before = try XCTUnwrap(DiskStamp.of(url))
        try "hello there".write(to: url, atomically: false, encoding: .utf8)
        XCTAssertNotEqual(DiskStamp.of(url), before)
    }

    /// The case the whole mechanism turns on: an outside editor that replaces
    /// the file rather than rewriting it (which is what `AtomicFile` itself
    /// does, and what `git checkout` does) leaves the same path and the same
    /// length, so the stamp has to be about the FILE rather than the path.
    func testAFileReplacedByAnotherOfTheSameLengthShouldStampDifferently() throws {
        let url = try file("note.md", "hello")
        let before = try XCTUnwrap(DiskStamp.of(url))
        try AtomicFile.writeString("world", to: url)
        let after = try XCTUnwrap(DiskStamp.of(url))
        XCTAssertEqual(after.size, before.size)
        XCTAssertNotEqual(after.inode, before.inode)
        XCTAssertNotEqual(after, before)
    }

    func testAPathWithNoFileOrADirectoryShouldHaveNoStamp() throws {
        XCTAssertNil(DiskStamp.of(directory.appendingPathComponent("nothing.md")))
        XCTAssertNil(DiskStamp.of(directory), "a directory is not a file this app writes")
    }

    /// Symlinks are followed, because `AtomicFile.write` follows them: the
    /// stamp has to describe the file the write will land on, or a note
    /// reached through a link is a conflict on every single look.
    func testASymlinkShouldStampTheFileItPointsAt() throws {
        let url = try file("note.md", "hello")
        let link = directory.appendingPathComponent("link.md")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: url)
        XCTAssertEqual(DiskStamp.of(link), DiskStamp.of(url))
    }

    // ── The words ─────────────────────────────────────────────────────────

    func testTheQuestionShouldNameTheFileAndBothAnswers() {
        XCTAssertTrue(DiskDrift.title(document: "Note.md").contains("Note.md"))
        XCTAssertTrue(DiskDrift.detail.contains(DiskDrift.reloadTitle))
        XCTAssertTrue(DiskDrift.detail.contains(DiskDrift.keepTitle),
                      "both buttons are named in the sentence, because both lose something")
    }

    func testTheKeptBufferShouldBeNamedBesideTheFileRatherThanLikeIt() {
        XCTAssertEqual(DiskDrift.unsavedStem(for: "Note"), "Note (unsaved)")
    }
}
