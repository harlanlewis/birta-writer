import AppKit
import BirtaWriterCore
import XCTest
@testable import BirtaWriter

/// Where notes live is ONE two-way choice: the folder the app derives inside
/// iCloud Drive, or a folder of your own that starts under Documents.
///
/// `NoteModelTests` holds the rule, where availability is an argument and all
/// eight states are reachable. This holds the WIRING, which that cannot see:
/// whether `Prefs` asks the rule before reading a stored path, whether the
/// gesture both screens make keeps the folder somebody named, and whether a
/// file that moves takes the choice with it.
///
/// Every case writes the test host's own defaults, so each restores what it
/// found. The arms that need the iCloud branch actually in force skip on a Mac
/// with iCloud Drive switched off, which is what a CI runner is; the arms
/// below them are written to hold on both, so a skipped machine still checks
/// the collapse from the other side.
@MainActor
final class NoteLocationChangeTests: XCTestCase {
    private var folder = URL(fileURLWithPath: "/tmp")

    /// Everything these cases can disturb, put back whatever they do.
    private struct Saved {
        let scratchpad: URL?
        let preferICloud: Bool
        let lastNotes: URL?
    }

    private func save() -> Saved {
        Saved(scratchpad: Prefs.hasExplicitScratchpadPath ? Prefs.scratchpadURL : nil,
              preferICloud: Prefs.storeInICloud,
              lastNotes: Prefs.lastNotesDirectory)
    }

    private func restore(_ saved: Saved) {
        Prefs.scratchpadURL = saved.scratchpad
        Prefs.storeInICloud = saved.preferICloud
        Prefs.lastNotesDirectory = saved.lastNotes
    }

    override func setUpWithError() throws {
        try super.setUpWithError()
        _ = NSApplication.shared
        folder = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("note-location-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
        try super.tearDownWithError()
    }

    private var chosenNote: URL { folder.appendingPathComponent("Theirs.md") }

    // MARK: the stored path belongs to one branch

    /// The stored path is read under the branch that owns it and not otherwise.
    ///
    /// Both arms of that guard are reached on any machine, because what is
    /// varied is whether a path is stored rather than what the Mac can do:
    /// with the switch off, a stored path is the answer and no stored path
    /// falls to the folder under Documents.
    func testTheOffBranchShouldReadItsStoredPathAndFallBackWithoutOne() {
        let saved = save()
        defer { restore(saved) }

        Prefs.storeInICloud = false
        Prefs.scratchpadURL = chosenNote
        XCTAssertEqual(Prefs.noteHome, .chosen)
        XCTAssertEqual(Prefs.scratchpadURL.path, chosenNote.path)

        Prefs.scratchpadURL = nil
        XCTAssertEqual(Prefs.noteHome, .documents)
        XCTAssertEqual(Prefs.scratchpadURL.path, Prefs.defaultScratchpadURL.path,
                       "with nothing named, the off branch is the folder under Documents")
    }

    /// The collapse itself: the same stored path, with the switch on, decides
    /// nothing.
    ///
    /// The shape this rules out: a stored path that outranks the switch
    /// outright, which leaves turning iCloud on with nothing to do but throw
    /// that path away.
    func testTheICloudBranchShouldIgnoreAStoredPathRatherThanBeOverruledByIt() throws {
        try XCTSkipUnless(Prefs.iCloudAvailable,
                          "the iCloud branch cannot be in force on a Mac with iCloud Drive off")
        let saved = save()
        defer { restore(saved) }

        Prefs.storeInICloud = true
        Prefs.scratchpadURL = chosenNote

        XCTAssertEqual(Prefs.noteHome, .iCloud)
        XCTAssertEqual(Prefs.scratchpadURL.path, Prefs.defaultScratchpadURL.path,
                       "the switch is on, so the note is the derived one")
        XCTAssertEqual(Prefs.storedActiveURL.path, Prefs.defaultScratchpadURL.path,
                       "the probe that asks whether a setting moved reads the same rule")
    }

    // MARK: the gesture both screens make

    /// Turning iCloud on KEEPS the folder somebody named.
    ///
    /// The one arm of this file that is machine independent, and the failure
    /// it exists for: a gesture that clears the path to keep the switch
    /// honest, which is what a ranking with the path on top forces. Putting a
    /// clear back into `NoteLocationChange.storeInICloud` is what it goes red
    /// on.
    func testTurningICloudOnShouldRememberTheFolderRatherThanDiscardIt() {
        let saved = save()
        defer { restore(saved) }

        Prefs.storeInICloud = false
        Prefs.scratchpadURL = chosenNote

        var applied = 0
        NoteLocationChange.storeInICloud(true, in: nil, redraw: {}, apply: { _ in applied += 1 })

        XCTAssertEqual(applied, 1, "the caller's reload has to run on every arm")
        XCTAssertTrue(Prefs.storeInICloud)
        XCTAssertTrue(Prefs.hasExplicitScratchpadPath,
                      "the folder they named was thrown away by trying iCloud")

        NoteLocationChange.storeInICloud(false, in: nil, redraw: {}, apply: { _ in applied += 1 })
        XCTAssertEqual(applied, 2)
        XCTAssertEqual(Prefs.noteHome, .chosen)
        XCTAssertEqual(Prefs.scratchpadURL.path, chosenNote.path,
                       "coming back off iCloud lands on the folder they named, not the default")
    }

    /// Naming a folder selects the branch that holds it, not just its value.
    ///
    /// The failure it exists for: the Location row is reachable with the
    /// switch still ON, on a Mac with iCloud Drive off in System Settings,
    /// where the switch decides nothing because there is no iCloud to store
    /// in. Leaving the preference saying iCloud there holds until somebody
    /// switches iCloud Drive on in System Settings, at which point the folder
    /// they named stops being in force and the notes go back to the derived
    /// one with nothing asked and nothing said.
    func testNamingAFolderShouldSelectTheBranchThatHoldsItAndNotOnlyItsValue() {
        let saved = save()
        defer { restore(saved) }

        Prefs.storeInICloud = true
        NoteLocationChange.use(chosenNote, in: nil, redraw: {}, apply: { _ in })

        XCTAssertFalse(Prefs.storeInICloud,
                       "the preference still says iCloud, so switching iCloud Drive on in "
                       + "System Settings would take this folder away silently")
        XCTAssertEqual(Prefs.noteHome, .chosen)
        XCTAssertEqual(Prefs.scratchpadURL.path, chosenNote.path)
    }

    /// A location change always goes through the offer, whichever way it moves.
    ///
    /// The offer is what brings the notes along, and the record it keeps is
    /// what a launch compares against; a route that changed the location
    /// without touching either is the failure `NotesMoveOffer` exists to stop.
    func testEveryLocationChangeShouldBringTheRecordUpToDate() {
        let saved = save()
        defer { restore(saved) }

        Prefs.storeInICloud = false
        Prefs.scratchpadURL = nil
        Prefs.lastNotesDirectory = folder

        NoteLocationChange.storeInICloud(true, in: nil, redraw: {}, apply: { _ in })
        XCTAssertEqual(Prefs.lastNotesDirectory?.path, Prefs.derivedNotesDirectory.path)
        XCTAssertNil(Prefs.strandedNotesDirectory,
                     "a folder the user just answered for is not raised again next launch")
    }

    /// Neither screen writes the location settings itself.
    ///
    /// `NoteLocationChange`'s header says a gesture written twice is two
    /// gestures that can come to disagree about what off means, and nothing
    /// else in the suite holds that. `SettingsFormTests` compares the two row
    /// LISTS, which is a different claim: two screens can draw the same rows
    /// in the same words and write different settings behind them, and no
    /// label or ordering check can see it.
    ///
    /// Read out of the sources, because what is ruled out is a second WRITER
    /// rather than a wrong value. Setting a preference and reading it back
    /// passes whichever file did the writing.
    func testNeitherScreenShouldWriteTheLocationSettingsItself() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Sources/BirtaWriter", isDirectory: true)
        for name in ["SettingsWindow", "WelcomeView"] {
            let file = sources.appendingPathComponent("\(name).swift")
            // Not a skip. A guard that cannot find its subject has stopped
            // guarding, and that has to be a red rather than a silent pass.
            guard let source = try? String(contentsOf: file, encoding: .utf8) else {
                return XCTFail("could not read \(file.path); if \(name).swift moved, "
                               + "this guard must follow it")
            }
            XCTAssertTrue(source.contains("NoteLocationChange."),
                          "\(name).swift no longer reaches the shared gesture at all, so this "
                          + "guard is passing on a file that stopped having the question in it")
            for write in ["Prefs.storeInICloud =", "Prefs.scratchpadURL ="] {
                XCTAssertFalse(source.contains(write),
                               "\(name).swift writes `\(write)` itself; the location gesture is "
                               + "`NoteLocationChange`'s, or the two screens can come to "
                               + "disagree about what off means")
            }
        }
    }

    // MARK: a file that moves takes the choice with it

    /// A Finder rename or a rename from the title popover, made while the
    /// derived note is what is bound.
    ///
    /// Writing the path alone would be a write nothing reads, because the
    /// stored path is the off branch's value: the next resolve would go on
    /// deriving and the renamed file would be abandoned. So the branch follows
    /// the file, and `scratchpadURL` is what proves it rather than the flag.
    func testMovingTheDerivedNoteShouldPointTheSettingAtWhereItWent() {
        let saved = save()
        defer { restore(saved) }

        Prefs.scratchpadURL = nil
        Prefs.storeInICloud = true
        let before = Prefs.scratchpadURL!
        let moved = folder.appendingPathComponent("Journal.md")

        // `.scratchpad` because that is what a window on the derived note is
        // bound THROUGH. It used to reach the same behaviour by falling
        // through the nil case, which was sound while one window meant "named
        // by no setting" and "on the default scratchpad" were the same state.
        Prefs.rebind(to: moved, slot: .scratchpad)

        XCTAssertEqual(Prefs.scratchpadURL.path, moved.path,
                       "the panel would open the derived note again next launch")
        XCTAssertFalse(Prefs.storeInICloud,
                       "a note carried out of the derived folder is a folder of one's own")
        XCTAssertEqual(Prefs.noteHome, .chosen)
    }

    /// The hazard multiple windows introduce, and the reason the write-back
    /// takes the window's slot rather than deriving one from the old path.
    ///
    /// A window can be on a file that no setting names: the slots are app-wide
    /// and only one window holds each, so a second window that opened a
    /// document keeps editing it after a third window claims `document`.
    /// Renaming from that window must write back nowhere. Deriving the slot
    /// from the path would find no match and, under the rule that used to be
    /// right, adopt the file as the scratchpad, moving a setting the person
    /// never touched onto a file they merely renamed.
    func testRenamingFromAWindowNoSettingNamesShouldMoveNoSetting() {
        let saved = save()
        // `save` does not cover the document slot, and these tests run against
        // the runner's own standard defaults, so leaving one set would reach
        // the person's real app and not merely the next test in this file.
        let savedDocument = Prefs.documentURL
        defer { restore(saved); Prefs.documentURL = savedDocument }

        Prefs.scratchpadURL = nil
        Prefs.storeInICloud = true
        Prefs.documentURL = folder.appendingPathComponent("Claimed.md")
        let scratchpadBefore = Prefs.scratchpadURL!

        // Renaming a file in a window bound through no slot at all.
        Prefs.rebind(to: folder.appendingPathComponent("Renamed.md"), slot: nil)

        XCTAssertEqual(Prefs.scratchpadURL.path, scratchpadBefore.path,
                       "renaming an unrelated file moved the scratchpad setting")
        XCTAssertTrue(Prefs.storeInICloud, "and took the notes out of iCloud with it")
        XCTAssertEqual(Prefs.documentURL?.lastPathComponent, "Claimed.md",
                       "the window that does hold a slot should keep it")
    }

    // MARK: the sentence that makes the folder an offer

    /// The Location row says a folder inside iCloud Drive still syncs.
    ///
    /// Without it the only way to reach that is to try it and hope, which is
    /// what the ticket behind this called working by accident rather than by
    /// offer. It is a sentence rather than a behaviour, so nothing else in the
    /// suite fails when it stops being drawn.
    func testTheLocationRowShouldSayThatAFolderInICloudDriveSyncs() throws {
        let controller = SettingsWindowController(flavour: .release, onHotkeyChange: { 0 },
                                                  onChange: { _ in }, onChangeEverywhere: {},
                                                  onShowWelcome: {}, onCheckForUpdates: {})
        defer { controller.window?.close() }
        controller.selectTabForTesting("general")

        let row = try XCTUnwrap(controller.rowForTesting(.location),
                                "the General pane no longer draws a Location row")
        let caption = try XCTUnwrap(row.caption, "the Location row has no sentence under it")
        XCTAssertTrue(caption.stringValue.contains("iCloud Drive"),
                      "the sentence under Location no longer names iCloud Drive: "
                      + "\"\(caption.stringValue)\"")
    }
}
