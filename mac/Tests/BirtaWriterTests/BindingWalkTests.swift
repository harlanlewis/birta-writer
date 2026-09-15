import XCTest
@testable import BirtaWriter
@testable import BirtaWriterCore

/// The file a window is on after a settings change, decided from the window's
/// OWN slot rather than from the app-wide answer (MAR-456).
///
/// `Prefs.activeURL` is one file for the whole app, and a settings reload
/// reaches every window. A reload that read it moved every window onto that
/// file. `Prefs.binding(enteringAt:)` walks the same precedence entered at
/// the window's slot, and these are the three claims its header makes.
///
/// Against the runner's own standard defaults, as `NoteLocationChangeTests`
/// runs, so every key touched is saved first and put back after: a document
/// setting left set would reach the person's real app rather than the next
/// test.
@MainActor
final class BindingWalkTests: XCTestCase {
    private let folder = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("binding-walk-\(UUID().uuidString)", isDirectory: true)

    private struct Saved {
        let document: URL?
        let currentNote: URL?
        let scratchpad: URL?
        let preferICloud: Bool
    }

    private func save() -> Saved {
        Saved(document: Prefs.documentURL,
              currentNote: Prefs.currentNoteURL,
              scratchpad: Prefs.hasExplicitScratchpadPath ? Prefs.scratchpadURL : nil,
              preferICloud: Prefs.storeInICloud)
    }

    private func restore(_ saved: Saved) {
        Prefs.documentURL = saved.document
        Prefs.currentNoteURL = saved.currentNote
        Prefs.scratchpadURL = saved.scratchpad
        Prefs.storeInICloud = saved.preferICloud
    }

    /// A document, a note and a scratchpad, all set and all on disk, so the
    /// existence filter in `currentNoteURL` does not decide the case.
    private func setAllThree() throws -> (document: URL, note: URL, scratchpad: URL) {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let document = folder.appendingPathComponent("Chosen.md")
        let note = folder.appendingPathComponent("Note.md")
        let scratchpad = folder.appendingPathComponent("Pad.md")
        for url in [document, note, scratchpad] { try Data().write(to: url) }
        Prefs.storeInICloud = false
        Prefs.scratchpadURL = scratchpad
        Prefs.documentURL = document
        Prefs.currentNoteURL = note
        return (document, note, scratchpad)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
        try super.tearDownWithError()
    }

    func testADocumentWindowShouldEnterAtTheTopAndStayOnTheDocument() throws {
        let saved = save()
        defer { restore(saved) }
        let files = try setAllThree()

        let binding = Prefs.binding(enteringAt: .document)
        XCTAssertEqual(binding.url.path, files.document.path)
        XCTAssertEqual(binding.slot, .document)
        // The app-wide answer agrees here, which is the one case where it
        // was ever right for every window.
        XCTAssertEqual(Prefs.activeURL.path, files.document.path)
    }

    func testANoteWindowShouldNeverConsultTheDocumentSetting() throws {
        let saved = save()
        defer { restore(saved) }
        let files = try setAllThree()

        let binding = Prefs.binding(enteringAt: .currentNote)
        XCTAssertEqual(binding.url.path, files.note.path,
                       "a document is set, and this window is not on it")
        XCTAssertEqual(binding.slot, .currentNote)
        XCTAssertNotEqual(binding.url.path, Prefs.activeURL.path,
                          "the app-wide answer names the document; reading it here is the defect")
    }

    func testAScratchpadWindowShouldEnterAtTheBottom() throws {
        let saved = save()
        defer { restore(saved) }
        let files = try setAllThree()

        let binding = Prefs.binding(enteringAt: .scratchpad)
        XCTAssertEqual(binding.url.path, files.scratchpad.path)
        XCTAssertEqual(binding.slot, .scratchpad)
    }

    /// Back to My Notes clears the document setting and expects the window
    /// that held it to fall to the next slot down, which is what entering at
    /// the top still does.
    func testADocumentWindowShouldFallThroughOnceTheSettingIsCleared() throws {
        let saved = save()
        defer { restore(saved) }
        let files = try setAllThree()

        Prefs.documentURL = nil
        let binding = Prefs.binding(enteringAt: .document)
        XCTAssertEqual(binding.url.path, files.note.path)
        XCTAssertEqual(binding.slot, .currentNote)
    }

    /// The stored walk asks whether a SETTING moved, so it must not drop a
    /// note that has merely gone from disk the way the live walk does.
    func testTheStoredWalkShouldKeepNamingANoteThatIsGoneFromDisk() throws {
        let saved = save()
        defer { restore(saved) }
        let files = try setAllThree()
        try FileManager.default.removeItem(at: files.note)

        XCTAssertEqual(Prefs.binding(enteringAt: .currentNote).url.path, files.scratchpad.path,
                       "the live walk falls back, as opening a deleted note must")
        XCTAssertEqual(Prefs.storedBinding(enteringAt: .currentNote).path, files.note.path,
                       "the stored walk still names it, so a deletion does not read as a move")
    }
}
