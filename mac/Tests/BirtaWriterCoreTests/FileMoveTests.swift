import XCTest
@testable import BirtaWriterCore

final class FileMoveTests: XCTestCase {
    func testARenameInTheSameFolderShouldBeFollowed() {
        let to = URL(fileURLWithPath: "/Users/x/Documents/Birta Writer/Renamed.md")
        XCTAssertEqual(FileMove.classify(movedTo: to), .followed(to))
    }

    func testAMoveToAnotherFolderShouldBeFollowed() {
        let to = URL(fileURLWithPath: "/Users/x/Desktop/Note.md")
        XCTAssertEqual(FileMove.classify(movedTo: to), .followed(to))
    }

    func testAMoveToAnotherVolumeShouldBeFollowed() {
        let to = URL(fileURLWithPath: "/Volumes/Backup/Notes/Note.md")
        XCTAssertEqual(FileMove.classify(movedTo: to), .followed(to))
    }

    /// The case the whole type exists for: Finder reports a delete as a move,
    /// so without this the app follows the note into the Trash and the next write
    /// puts the buffer back into a file the user threw away.
    func testAMoveIntoTheHomeTrashShouldBeADelete() {
        let to = URL(fileURLWithPath: "/Users/x/.Trash/Note.md")
        XCTAssertEqual(FileMove.classify(movedTo: to), .deleted(trashedTo: to))
    }

    func testAMoveIntoAVolumesTrashShouldBeADelete() {
        let to = URL(fileURLWithPath: "/Volumes/Backup/.Trashes/501/Note.md")
        XCTAssertEqual(FileMove.classify(movedTo: to), .deleted(trashedTo: to))
    }

    /// A folder dragged to the Trash takes the note with it, and then the
    /// note's own last component names the folder rather than the trash. Only
    /// an ancestor says what happened, which is why the check is over every
    /// component and not over the parent.
    func testANoteInsideAFolderThrownAwayShouldBeADelete() {
        let to = URL(fileURLWithPath: "/Users/x/.Trash/Birta Writer/Note.md")
        XCTAssertEqual(FileMove.classify(movedTo: to), .deleted(trashedTo: to))
    }

    /// A folder a person named "Trash" is not the Trash, and a note filed in
    /// one is not thrown away. The leading dot is the whole difference.
    func testAFolderMerelyCalledTrashShouldBeFollowed() {
        let to = URL(fileURLWithPath: "/Users/x/Documents/Trash/Note.md")
        XCTAssertEqual(FileMove.classify(movedTo: to), .followed(to))
        let trashes = URL(fileURLWithPath: "/Users/x/Documents/Trashes/Note.md")
        XCTAssertEqual(FileMove.classify(movedTo: trashes), .followed(trashes))
    }

    /// A relative or dot-laden path has to be resolved before its components
    /// are read, or a delete spelled that way reads as an ordinary move.
    func testAPathSpelledWithDotsShouldBeStandardizedBeforeJudging() {
        let to = URL(fileURLWithPath: "/Users/x/Documents/../.Trash/Note.md")
        XCTAssertEqual(FileMove.classify(movedTo: to), .deleted(trashedTo: to))
    }

    /// A trash component at ANY depth decides it, which is the rule the
    /// per-volume form and a dragged folder both need. Enumerated rather than
    /// sampled: a check written against `.Trash` alone passes on an
    /// implementation that only looks at the parent directory.
    func testATrashComponentAtAnyDepthShouldDecideIt() {
        let deletions = [
            "/Users/x/.Trash/Note.md",
            "/Users/x/.Trash/a/b/c/Note.md",
            "/Volumes/Backup/.Trashes/501/Note.md",
            "/Volumes/Backup/.Trashes/501/a/b/Note.md",
        ]
        for path in deletions {
            let to = URL(fileURLWithPath: path)
            XCTAssertEqual(FileMove.classify(movedTo: to), .deleted(trashedTo: to), path)
        }
        XCTAssertEqual(deletions.count, 4)
    }
}
