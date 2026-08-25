import AppKit
import XCTest
@testable import BirtaJot
@testable import BirtaJotCore

/// The launch offer: what a rename leaves behind, and what answering the
/// question actually does to the files.
///
/// The rename is reproduced rather than described. Notes are put in a folder
/// derived from a former product name, the folder derived from the name in
/// force now is the destination, and the launch path is driven with the two.
/// `StrandedNotesTests` covers the decision; this covers the arms, which are
/// where the notes are either carried or lost.
///
/// Asking whether the offer was CALLED would prove nothing here: the defect it
/// exists for is that no caller existed at all, so what is asserted is the
/// state of the disk afterwards. `testTheLaunchShouldReachThisAtAll` is the
/// other half, and pins the caller.
final class NotesMoveOfferLaunchTests: XCTestCase {
    private var root: URL!
    /// The folder a former product name derived, holding the writing.
    private var former: URL!
    /// The folder the name in force derives, which is what the app opens.
    private var derived: URL!
    private let noteBody = "The notes that were stranded.\n"

    /// One call to the sheet, with what it was asked about.
    private final class Answers {
        private(set) var asked: [(from: URL, to: URL, notes: Int)] = []
        private(set) var told: [[String]] = []
        private(set) var recorded: [URL] = []
        var answer = true

        func ask(_ from: URL, _ to: URL, _ plan: NotesMove.Plan) -> Bool {
            asked.append((from, to, plan.noteCount))
            return answer
        }
        func tell(_ lines: [String]) { told.append(lines) }
        func record(_ url: URL) { recorded.append(url) }
    }

    override func setUpWithError() throws {
        let fileManager = FileManager.default
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("launch-offer-\(UUID().uuidString)")
        former = root.appendingPathComponent("Birta Writer Jot", isDirectory: true)
        derived = ScratchpadLocation.iCloud.url(root: root).deletingLastPathComponent()
        try fileManager.createDirectory(
            at: former.appendingPathComponent(AttachmentStore.directoryName, isDirectory: true),
            withIntermediateDirectories: true)
        try fileManager.createDirectory(at: derived, withIntermediateDirectories: true)
        try noteBody.write(to: former.appendingPathComponent("Birta Writer Jot.md"),
                           atomically: true, encoding: .utf8)
        try Data([0x89, 0x50, 0x4E, 0x47]).write(
            to: former.appendingPathComponent(AttachmentStore.directoryName, isDirectory: true)
                .appendingPathComponent("shot.png"))
        // Nothing is put in the destination, and that is the reachable state
        // rather than a simplification. `offerAtLaunch` runs BEFORE the
        // Coordinator that makes the app's own note, so on the launch this
        // path exists for the derived name is free. A destination scratchpad
        // is its own case, and `testAScratchpadNameAlreadyTakenShouldNotBeClaimed`
        // is where it is put.
    }

    /// The name the rename moved FROM: what the scratchpad was called in the
    /// folder the notes were left in.
    private let formerScratchpadName = "Birta Writer Jot.md"

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }

    /// The whole point: the notes and the images they use arrive in the folder
    /// the app is actually using, and the file it already had is untouched.
    func testMovingShouldCarryTheNotesAndTheirImagesIntoTheFolderInUse() throws {
        let answers = Answers()
        NotesMoveOffer.offerAtLaunch(stranded: former, destination: derived,
                                     formerScratchpadName: formerScratchpadName,
                                     derivedScratchpadName: ScratchpadLocation.fileName,
                                     ask: answers.ask, tell: answers.tell,
                                     record: answers.record)

        XCTAssertEqual(answers.asked.count, 1, "the move must be asked about, once")
        XCTAssertEqual(answers.asked.first?.from.path, former.path)
        XCTAssertEqual(answers.asked.first?.to.path, derived.path)
        XCTAssertEqual(answers.asked.first?.notes, 1)

        // The scratchpad arrives under the name the app derives NOW, which is
        // the name the panel opens. Landing it under its old name would put
        // the writing beside the empty note this launch is about to make, one
        // Cmd+O away and not on screen, which is the rescue failing on its
        // last step.
        let carried = derived.appendingPathComponent(ScratchpadLocation.fileName)
        XCTAssertEqual(try String(contentsOf: carried, encoding: .utf8), noteBody,
                       "the panel's file holds the writing, not an empty note")
        XCTAssertFalse(exists(derived.appendingPathComponent(formerScratchpadName)),
                       "and it is not also there under the name the rename left behind")
        XCTAssertTrue(exists(derived.appendingPathComponent(AttachmentStore.directoryName)
            .appendingPathComponent("shot.png")), "an image a note points at comes with it")
        XCTAssertFalse(exists(former.appendingPathComponent(formerScratchpadName)),
                       "a carried note is not left in both places")
        XCTAssertTrue(answers.told.isEmpty, "a move with nothing left behind says nothing")
        XCTAssertEqual(answers.recorded, [derived])
    }

    /// The rename is bounded by what is already there. A destination that
    /// already answers to the derived name keeps it: taking it would push a
    /// file aside to make room, and the scratchpad under its own name is the
    /// state this whole change improves on rather than one it may cost.
    func testAScratchpadNameAlreadyTakenShouldNotBeClaimed() throws {
        try "# Already here\n".write(
            to: derived.appendingPathComponent(ScratchpadLocation.fileName),
            atomically: true, encoding: .utf8)

        let answers = Answers()
        NotesMoveOffer.offerAtLaunch(stranded: former, destination: derived,
                                     formerScratchpadName: formerScratchpadName,
                                     derivedScratchpadName: ScratchpadLocation.fileName,
                                     ask: answers.ask, tell: answers.tell,
                                     record: answers.record)

        XCTAssertEqual(
            try String(contentsOf: derived.appendingPathComponent(ScratchpadLocation.fileName),
                       encoding: .utf8),
            "# Already here\n", "the file already in the destination is not written over")
        XCTAssertEqual(
            try String(contentsOf: derived.appendingPathComponent(formerScratchpadName),
                       encoding: .utf8),
            noteBody, "and the scratchpad still comes across, under its own name")
    }

    /// The other way the name can be spoken for: a second note travelling
    /// beside the scratchpad is already called it. Same answer, and it is the
    /// case an order-dependent implementation gets wrong, since this one sorts
    /// after the scratchpad.
    func testANoteTravellingUnderTheDerivedNameShouldKeepIt() throws {
        let travelling = "The note that was already called that.\n"
        try travelling.write(to: former.appendingPathComponent(ScratchpadLocation.fileName),
                             atomically: true, encoding: .utf8)

        let answers = Answers()
        NotesMoveOffer.offerAtLaunch(stranded: former, destination: derived,
                                     formerScratchpadName: formerScratchpadName,
                                     derivedScratchpadName: ScratchpadLocation.fileName,
                                     ask: answers.ask, tell: answers.tell,
                                     record: answers.record)

        XCTAssertEqual(
            try String(contentsOf: derived.appendingPathComponent(ScratchpadLocation.fileName),
                       encoding: .utf8),
            travelling, "the note that was already called that keeps the name")
        XCTAssertEqual(
            try String(contentsOf: derived.appendingPathComponent(formerScratchpadName),
                       encoding: .utf8),
            noteBody, "and neither note is written over by the other")
    }

    /// An install renamed before any launch recorded the scratchpad file has
    /// nothing to rename FROM. It must still carry the notes across, under
    /// their own names, exactly as it did before the file was recorded.
    func testAnUnrecordedScratchpadShouldStillCarryTheNotes() throws {
        let answers = Answers()
        NotesMoveOffer.offerAtLaunch(stranded: former, destination: derived,
                                     formerScratchpadName: nil,
                                     derivedScratchpadName: ScratchpadLocation.fileName,
                                     ask: answers.ask, tell: answers.tell,
                                     record: answers.record)

        XCTAssertEqual(
            try String(contentsOf: derived.appendingPathComponent(formerScratchpadName),
                       encoding: .utf8),
            noteBody, "the writing still comes across")
        XCTAssertFalse(exists(derived.appendingPathComponent(ScratchpadLocation.fileName)),
                       "and nothing is renamed onto a name nobody recorded")
    }

    /// Leave Them is a real answer, and the sheet named the folder, which is
    /// the whole thing the silent version failed to say. The record still
    /// moves on, or the same question comes back every launch.
    func testLeavingThemShouldMoveNothingAndStillRecord() {
        let answers = Answers()
        answers.answer = false
        NotesMoveOffer.offerAtLaunch(stranded: former, destination: derived,
                                     formerScratchpadName: nil,
                                     ask: answers.ask, tell: answers.tell,
                                     record: answers.record)

        XCTAssertEqual(answers.asked.count, 1)
        XCTAssertTrue(exists(former.appendingPathComponent("Birta Writer Jot.md")))
        XCTAssertFalse(exists(derived.appendingPathComponent("Birta Writer Jot.md")))
        XCTAssertEqual(answers.recorded, [derived])
    }

    /// The zero-byte orphans a rename also leaves. They carry nothing, so
    /// there is nothing to offer and nothing to say; the folder itself stays
    /// where the user can see it and delete it.
    func testAnEmptyFolderLeftByARenameShouldRaiseNothing() throws {
        let empty = root.appendingPathComponent("Birta Writer Jot Dev", isDirectory: true)
        try FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)

        let answers = Answers()
        NotesMoveOffer.offerAtLaunch(stranded: empty, destination: derived,
                                     formerScratchpadName: nil,
                                     ask: answers.ask, tell: answers.tell,
                                     record: answers.record)

        XCTAssertTrue(answers.asked.isEmpty, "an empty folder is clutter, not loss")
        XCTAssertTrue(exists(empty), "and it is the user's to delete, not ours")
        XCTAssertEqual(answers.recorded, [derived])
    }

    /// Every ordinary launch. Nothing moved, so nothing is asked, and the
    /// record is still brought up to date.
    func testALaunchWithNothingStrandedShouldRecordAndAskNothing() {
        let answers = Answers()
        NotesMoveOffer.offerAtLaunch(stranded: nil, destination: derived,
                                     formerScratchpadName: nil,
                                     ask: answers.ask, tell: answers.tell,
                                     record: answers.record)

        XCTAssertTrue(answers.asked.isEmpty)
        XCTAssertEqual(answers.recorded, [derived])
    }

    /// What did not come along is said out loud. Driven by taking the
    /// destination away, so the copy fails for a reason the code did not
    /// choose.
    func testANoteThatCouldNotBeCarriedShouldBeReported() throws {
        try FileManager.default.removeItem(at: derived)
        // A file where the destination folder has to go, so creating it fails.
        try Data().write(to: derived)

        let answers = Answers()
        NotesMoveOffer.offerAtLaunch(stranded: former, destination: derived,
                                     formerScratchpadName: nil,
                                     ask: answers.ask, tell: answers.tell,
                                     record: answers.record)

        XCTAssertEqual(answers.told.count, 1, "a note that stayed behind must be reported")
        // The note and the image it uses both stayed, and they are counted
        // apart: an image reported as a note sends the reader looking for
        // writing that is not missing.
        XCTAssertEqual(answers.told.first, [
            "One note could not be copied and is still where it was.",
            "One image could not be copied and is still where it was.",
        ])
        XCTAssertTrue(exists(former.appendingPathComponent("Birta Writer Jot.md")),
                      "and the original is exactly where it was")
    }

    // MARK: the sentence

    /// Both folders are named, because the question is where the writing went
    /// and a sentence that names neither cannot answer it.
    func testTheOfferShouldNameBothFoldersAndCountTheNotes() {
        let plan = NotesMove.plan(
            from: former, to: derived,
            entries: [former.appendingPathComponent("a.md"), former.appendingPathComponent("b.md")],
            occupied: { _ in false })
        let alert = NotesMoveOffer.launchAlert(from: former, to: derived, plan: plan)

        XCTAssertTrue(alert.informativeText.contains(former.path),
                      "the folder the notes are in: \(alert.informativeText)")
        XCTAssertTrue(alert.informativeText.contains(derived.path),
                      "and the one they would go to: \(alert.informativeText)")
        XCTAssertTrue(alert.informativeText.contains("2 notes are"), alert.informativeText)
        XCTAssertEqual(alert.buttons.map(\.title), ["Move 2 Notes", "Leave Them"])
    }

    /// One note is one note. A count of 1 spelled as a number reads as a bug
    /// in the sentence, and the button is what the person presses.
    func testASingleNoteShouldBeSpokenOfAsOne() {
        let plan = NotesMove.plan(from: former, to: derived,
                                  entries: [former.appendingPathComponent("a.md")],
                                  occupied: { _ in false })
        let alert = NotesMoveOffer.launchAlert(from: former, to: derived, plan: plan)

        XCTAssertTrue(alert.informativeText.contains("One note is"), alert.informativeText)
        XCTAssertEqual(alert.buttons.map(\.title), ["Move Note", "Leave Them"])
    }

    // MARK: the record the launch stands on

    /// `offerAtLaunch()` is called at launch with no arguments, so its
    /// defaults are the feature: every case above would pass just as happily
    /// with `Prefs.strandedNotesDirectory` hardwired to nil.
    ///
    /// Both directions are asserted, because recording is what closes the
    /// question. A record that never moved on would put the same sheet up
    /// every launch, which is its own way of being ignored.
    func testTheRecordShouldOpenTheQuestionAndCloseIt() {
        let original = Prefs.lastNotesDirectory
        let originalFile = Prefs.lastScratchpadFile
        defer {
            Prefs.lastNotesDirectory = original
            Prefs.lastScratchpadFile = originalFile
        }

        Prefs.lastNotesDirectory = former
        XCTAssertEqual(Prefs.strandedNotesDirectory?.standardizedFileURL.path,
                       former.standardizedFileURL.path,
                       "a recorded folder that is not the derived one is what a launch asks about")

        Prefs.recordNotesDerivation()
        XCTAssertEqual(Prefs.lastNotesDirectory?.path, Prefs.derivedNotesDirectory.path)
        XCTAssertNil(Prefs.strandedNotesDirectory)
    }

    /// The folder record says where the writing was left; this one says which
    /// file in it the panel was opening. A rename changes both, and without
    /// the second the carried scratchpad cannot be told from the notes beside
    /// it, so it lands under its old name and the panel opens an empty note.
    ///
    /// `offerAtLaunch()` takes this as a default argument, so the wiring is
    /// the feature here exactly as it is for the folder above.
    func testTheScratchpadFileShouldBeRecordedAndReadBackFromTheStrandedFolder() {
        let original = Prefs.lastNotesDirectory
        let originalFile = Prefs.lastScratchpadFile
        defer {
            Prefs.lastNotesDirectory = original
            Prefs.lastScratchpadFile = originalFile
        }

        Prefs.lastNotesDirectory = former
        Prefs.lastScratchpadFile = former.appendingPathComponent(formerScratchpadName)
        XCTAssertEqual(Prefs.strandedScratchpadName, formerScratchpadName,
                       "the name the panel was opening before the rename")

        // Recorded against a DIFFERENT folder than the stranded one: the two
        // records have come apart, and a name read out of the wrong folder
        // would rename a file on the strength of a stale record.
        Prefs.lastScratchpadFile = root
            .appendingPathComponent("Somewhere Else", isDirectory: true)
            .appendingPathComponent(formerScratchpadName)
        XCTAssertNil(Prefs.strandedScratchpadName,
                     "a record from another folder does not name this folder's scratchpad")

        Prefs.recordNotesDerivation()
        XCTAssertEqual(Prefs.lastScratchpadFile?.path, Prefs.defaultScratchpadURL.path,
                       "and recording brings the file record up with the folder's")
    }

    /// The derived folder is the one a rename can move, and it is not the one
    /// the user chose. A chosen path IN FORCE takes the question away
    /// entirely.
    ///
    /// In force is the whole of the second arm, and it is why the iCloud
    /// preference is written here rather than left at whatever the machine
    /// running this has. A stored path under the iCloud branch is a folder
    /// waiting rather than a folder in use, the notes are in the derived one,
    /// and a rename can still move it; reading the stored value alone would
    /// switch this check off for exactly those people.
    func testAFolderTheUserChoseAndIsUsingShouldNotBeTakenForADerivedOne() throws {
        let original = Prefs.lastNotesDirectory
        let chosen = Prefs.scratchpadURL
        let hadChosen = Prefs.hasExplicitScratchpadPath
        let preferred = Prefs.storeInICloud
        defer {
            Prefs.lastNotesDirectory = original
            Prefs.scratchpadURL = hadChosen ? chosen : nil
            Prefs.storeInICloud = preferred
        }

        Prefs.storeInICloud = false
        let derivedBefore = Prefs.derivedNotesDirectory
        Prefs.lastNotesDirectory = former
        Prefs.scratchpadURL = former.appendingPathComponent("theirs.md")

        XCTAssertEqual(Prefs.noteHome, .chosen, "the folder they named is the one in force")
        XCTAssertEqual(Prefs.derivedNotesDirectory.path, derivedBefore.path,
                       "a chosen path does not change what the app derives")
        XCTAssertNil(Prefs.strandedNotesDirectory,
                     "no rename can move a folder somebody named by hand")
    }

    /// The same stored path with the iCloud branch in force is a folder the
    /// user is NOT in, so the launch check has to go on watching the derived
    /// one.
    ///
    /// This is the arm that was lost when the guard asked whether a path was
    /// stored rather than whether it was in use, and it is the one MAR-413
    /// exists for: notes sitting in a folder under the old product spelling,
    /// with nothing on screen to say so.
    func testAPathStoredUnderTheICloudBranchShouldNotSilenceTheLaunchCheck() throws {
        try XCTSkipUnless(Prefs.iCloudAvailable,
                          "the iCloud branch cannot be in force on a Mac with iCloud Drive off")
        let original = Prefs.lastNotesDirectory
        let chosen = Prefs.scratchpadURL
        let hadChosen = Prefs.hasExplicitScratchpadPath
        let preferred = Prefs.storeInICloud
        defer {
            Prefs.lastNotesDirectory = original
            Prefs.scratchpadURL = hadChosen ? chosen : nil
            Prefs.storeInICloud = preferred
        }

        Prefs.storeInICloud = true
        Prefs.scratchpadURL = former.appendingPathComponent("theirs.md")
        Prefs.lastNotesDirectory = former

        XCTAssertEqual(Prefs.noteHome, .iCloud, "the switch decides, the stored path waits")
        XCTAssertEqual(Prefs.strandedNotesDirectory?.standardizedFileURL.path,
                       former.standardizedFileURL.path,
                       "a folder the user is not in must not take the question away")
    }

    // MARK: the caller

    /// The defect this file exists for was an absence: the machinery was
    /// there, correct and tested, and no path reached it. Everything above
    /// would pass just as happily with the launch call deleted, so the launch
    /// call is read here.
    ///
    /// The ORDER is asserted with it, because it is load-bearing rather than
    /// tidy: the offer has to be answered before anything is bound to a file,
    /// or a note carried into the folder can land on the path the panel is
    /// already editing.
    func testTheLaunchShouldReachThisAtAll() throws {
        let app = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaJotTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // jot
            .appendingPathComponent("Sources/BirtaJot/App.swift")
        guard let source = try? String(contentsOf: app, encoding: .utf8) else {
            // Not a skip. A guard that cannot find its subject has stopped
            // guarding, and that has to be a red rather than a silent pass.
            return XCTFail("could not read \(app.path); if App.swift moved, this guard must follow it")
        }
        guard let launch = source.range(of: "func applicationDidFinishLaunching") else {
            return XCTFail("App.swift no longer has applicationDidFinishLaunching; this guard needs rewriting")
        }
        let body = source[launch.upperBound...]
        guard let offer = body.range(of: "NotesMoveOffer.offerAtLaunch(") else {
            return XCTFail("nothing on the launch path offers to carry stranded notes; MAR-413 is back")
        }
        guard let coordinator = body.range(of: "coordinator = Coordinator(") else {
            return XCTFail("App.swift no longer builds the Coordinator in launch; this guard needs rewriting")
        }
        XCTAssertTrue(offer.lowerBound < coordinator.lowerBound,
                      "the offer must be answered before anything is bound to a file")
    }
}
