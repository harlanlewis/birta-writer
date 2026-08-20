import XCTest
@testable import BirtaJotCore

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
    /// so without this Jot follows the note into the Trash and the next write
    /// puts the buffer back into a file the user threw away.
    func testAMoveIntoTheHomeTrashShouldBeADelete() {
        XCTAssertEqual(FileMove.classify(movedTo: URL(fileURLWithPath: "/Users/x/.Trash/Note.md")),
                       .deleted)
    }

    func testAMoveIntoAVolumesTrashShouldBeADelete() {
        XCTAssertEqual(FileMove.classify(movedTo: URL(fileURLWithPath: "/Volumes/Backup/.Trashes/501/Note.md")),
                       .deleted)
    }

    /// A folder dragged to the Trash takes the note with it, and then the
    /// note's own last component names the folder rather than the trash. Only
    /// an ancestor says what happened, which is why the check is over every
    /// component and not over the parent.
    func testANoteInsideAFolderThrownAwayShouldBeADelete() {
        XCTAssertEqual(FileMove.classify(movedTo: URL(fileURLWithPath: "/Users/x/.Trash/Birta Writer/Note.md")),
                       .deleted)
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
        XCTAssertEqual(FileMove.classify(movedTo: to), .deleted)
    }

    /// Where it LANDED is the whole of the rule, so the same destination
    /// classifies the same way whatever it came from. Stated as a test
    /// because the alternative, deciding from the pair, is the shape a
    /// reader expects of something called a move.
    func testTheDestinationAloneShouldDecideIt() {
        XCTAssertEqual(FileMove.classify(movedTo: URL(fileURLWithPath: "/Users/x/.Trash/Note.md")),
                       .deleted)
        XCTAssertEqual(FileMove.classify(movedTo: URL(fileURLWithPath: "/tmp/elsewhere/Other.md")),
                       .followed(URL(fileURLWithPath: "/tmp/elsewhere/Other.md")))
    }
}
