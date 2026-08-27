import XCTest
@testable import BirtaWriterCore

/// Whether a launch has opened a notes folder that is not the one the last
/// launch wrote to.
///
/// The rename is driven through the derivation rather than described: the OLD
/// folder is the spelling a former product name produced, and the NEW one is
/// asked of `ScratchpadLocation` here and now, so the two are related exactly
/// as a rename relates them. `ScratchpadLocationTests` is what holds the
/// folder to the product-name constant, which is what makes a rename move it
/// at all.
final class StrandedNotesTests: XCTestCase {
    private var root: URL!
    /// The folder the derivation produces today.
    private var derived: URL!
    /// The folder a former product name would have produced. A literal stands
    /// in for the spelling, because a name that is gone is spelled nowhere the
    /// code can be asked for it, which is the whole reason the comparison
    /// needs something recorded.
    private var former: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("stranded-notes-\(UUID().uuidString)")
        derived = ScratchpadLocation.iCloud.url(root: root).deletingLastPathComponent()
        former = root.appendingPathComponent("Birta Writer Legacy", isDirectory: true)
        try FileManager.default.createDirectory(at: former, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: derived, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    /// The defect itself: the derivation moved, nobody touched a setting, and
    /// the folder that was in force a launch ago is still on disk.
    func testAFolderTheDerivationHasLeftBehindShouldBeOffered() {
        XCTAssertNotEqual(former.path, derived.path,
                          "the two spellings must differ, or nothing here is being asked")
        XCTAssertEqual(
            StrandedNotes.directory(recorded: former, derived: derived,
                                    usesChosenPath: false, exists: exists),
            former)
    }

    /// The ordinary launch, which is every launch but one.
    func testTheFolderTheLastLaunchUsedShouldBeOfferedNowhere() {
        XCTAssertNil(StrandedNotes.directory(recorded: derived, derived: derived,
                                             usesChosenPath: false, exists: exists))
    }

    /// One directory, two spellings. A record is a string a launch wrote and a
    /// later launch reads back, so the two sides can be spelled differently
    /// and mean the same folder; comparing the spellings would then read as a
    /// move every launch and put the sheet up over a folder nothing had left.
    ///
    /// Spelled with a `..` rather than a trailing slash, which is the shape
    /// that discriminates: `URL.path` drops a trailing slash on its own, so a
    /// test using one passes whether the comparison standardizes or not.
    func testTheSameFolderSpeltTwoWaysShouldNotReadAsAMove() {
        let roundabout = former.appendingPathComponent("..")
            .appendingPathComponent(derived.lastPathComponent)
        XCTAssertNotEqual(roundabout.path, derived.path, "the two spellings must differ")
        XCTAssertNil(StrandedNotes.directory(recorded: roundabout, derived: derived,
                                             usesChosenPath: false, exists: exists))
    }

    /// The price of a recorded fact over a list of former spellings, stated as
    /// a test so it cannot be mistaken for an oversight: the launch that first
    /// records one has nothing to compare against and asks nothing.
    ///
    /// Everything is said to be on disk, so the answer cannot come from a
    /// fabricated folder happening not to exist.
    func testALaunchWithNothingRecordedShouldAskNothing() {
        XCTAssertNil(StrandedNotes.directory(recorded: nil, derived: derived,
                                             usesChosenPath: false, exists: { _ in true }))
    }

    /// A folder somebody named by hand is derived from nothing, so no rename
    /// can move it. The derived folders are not where their notes are, and
    /// offering to carry notes into one would move files out of a folder the
    /// app is not using and into another folder it is not using either.
    ///
    /// The question is whether such a folder is IN FORCE. A path stored while
    /// the iCloud branch is in force is a folder waiting rather than a folder
    /// in use, and `Prefs` is what tells the two apart.
    func testAChosenPathInForceShouldTakeTheQuestionAway() {
        XCTAssertNil(StrandedNotes.directory(recorded: former, derived: derived,
                                             usesChosenPath: true, exists: exists))
    }

    /// The record outlives the folder it names: somebody moved or deleted it
    /// in Finder, which is an answer of its own.
    func testAFolderThatIsNoLongerThereShouldBeOfferedNowhere() throws {
        try FileManager.default.removeItem(at: former)
        XCTAssertNil(StrandedNotes.directory(recorded: former, derived: derived,
                                             usesChosenPath: false, exists: exists))
    }

    /// Each guard on its own says nothing about whether the others are still
    /// there, so the arms are enumerated and each is required to reach a
    /// verdict of its own. A run where every case answered nil would satisfy
    /// four of the assertions above and is the shape this rules out.
    func testEveryArmShouldBeReachedAndOnlyOneShouldOffer() {
        var offered: [URL?] = []
        for recorded in [former, derived, nil] as [URL?] {
            for chosen in [false, true] {
                for present in [true, false] {
                    offered.append(StrandedNotes.directory(
                        recorded: recorded, derived: derived,
                        usesChosenPath: chosen, exists: { _ in present }))
                }
            }
        }
        XCTAssertEqual(offered.count, 12, "every combination should have been asked")
        XCTAssertEqual(offered.compactMap { $0 }, [former],
                       "exactly one combination is a folder left behind")
    }
}
