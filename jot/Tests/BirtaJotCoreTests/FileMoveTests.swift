import XCTest
@testable import BirtaJotCore

final class FileMoveTests: XCTestCase {
    private let from = URL(fileURLWithPath: "/Users/x/Documents/Birta Writer/Note.md")

    func testARenameInTheSameFolderShouldBeFollowed() {
        let to = URL(fileURLWithPath: "/Users/x/Documents/Birta Writer/Renamed.md")
        XCTAssertEqual(FileMove.classify(from: from, to: to), .followed(to))
    }

    func testAMoveToAnotherFolderShouldBeFollowed() {
        let to = URL(fileURLWithPath: "/Users/x/Desktop/Note.md")
        XCTAssertEqual(FileMove.classify(from: from, to: to), .followed(to))
    }

    func testAMoveToAnotherVolumeShouldBeFollowed() {
        let to = URL(fileURLWithPath: "/Volumes/Backup/Notes/Note.md")
        XCTAssertEqual(FileMove.classify(from: from, to: to), .followed(to))
    }

    /// The case the whole type exists for: Finder reports a delete as a move,
    /// so without this Jot follows the note into the Trash and the next write
    /// puts the buffer back into a file the user threw away.
    func testAMoveIntoTheHomeTrashShouldBeADelete() {
        XCTAssertEqual(FileMove.classify(from: from, to: URL(fileURLWithPath: "/Users/x/.Trash/Note.md")),
                       .deleted)
    }

    func testAMoveIntoAVolumesTrashShouldBeADelete() {
        XCTAssertEqual(FileMove.classify(from: from, to: URL(fileURLWithPath: "/Volumes/Backup/.Trashes/501/Note.md")),
                       .deleted)
    }

    /// A folder dragged to the Trash takes the note with it, and then the
    /// note's own last component names the folder rather than the trash. Only
    /// an ancestor says what happened, which is why the check is over every
    /// component and not over the parent.
    func testANoteInsideAFolderThrownAwayShouldBeADelete() {
        XCTAssertEqual(FileMove.classify(from: from,
                                         to: URL(fileURLWithPath: "/Users/x/.Trash/Birta Writer/Note.md")),
                       .deleted)
    }

    /// A folder a person named "Trash" is not the Trash, and a note filed in
    /// one is not thrown away. The leading dot is the whole difference.
    func testAFolderMerelyCalledTrashShouldBeFollowed() {
        let to = URL(fileURLWithPath: "/Users/x/Documents/Trash/Note.md")
        XCTAssertEqual(FileMove.classify(from: from, to: to), .followed(to))
        let trashes = URL(fileURLWithPath: "/Users/x/Documents/Trashes/Note.md")
        XCTAssertEqual(FileMove.classify(from: from, to: trashes), .followed(trashes))
    }

    /// A relative or dot-laden path has to be resolved before its components
    /// are read, or a delete spelled that way reads as an ordinary move.
    func testAPathSpelledWithDotsShouldBeStandardizedBeforeJudging() {
        let to = URL(fileURLWithPath: "/Users/x/Documents/../.Trash/Note.md")
        XCTAssertEqual(FileMove.classify(from: from, to: to), .deleted)
    }

    /// A file named `.Trash` is not a trash FOLDER, but treating it as a
    /// delete is the safe direction: the cost is a bar the user dismisses, and
    /// the cost of the other mistake is writing into the Trash.
    func testTheClassificationShouldNotDependOnWhereTheFileCameFrom() {
        let to = URL(fileURLWithPath: "/Users/x/.Trash/Note.md")
        let elsewhere = URL(fileURLWithPath: "/tmp/somewhere/Other.md")
        XCTAssertEqual(FileMove.classify(from: from, to: to),
                       FileMove.classify(from: elsewhere, to: to))
    }
}
