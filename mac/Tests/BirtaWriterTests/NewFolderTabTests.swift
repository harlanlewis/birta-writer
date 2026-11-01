import AppKit
import BirtaWriterCore
import XCTest
@testable import BirtaWriter

/// Cmd+T in a folder window: a tab on the Folder Overview, over a note that
/// is not written until it is typed in (MAR-488).
///
/// The rules are `UnwrittenNote`'s and `UnwrittenNoteTests` holds them. What
/// this holds is that the window reaches them. Two halves are driven live,
/// on a window with no page: how the tab reads before anything is typed
/// (vacant, nothing to trash), and the free name a new note is given while
/// another tab holds one that is not on disk yet. The writes need a mounted
/// page (`hasLoaded` refuses every write before the first `ready`), so they
/// are held as source text, the shape `ShellWaitTests` and `FlushWriteTests`
/// use for the same reason.
@MainActor
final class NewFolderTabTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        _ = NSApplication.shared
        folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("NewFolderTabTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
        try super.tearDownWithError()
    }

    // MARK: live

    /// Vacant, so an outside open of a file in the folder takes the tab over
    /// rather than leaving a blank tab beside it; and not a file to trash,
    /// since there is none. The same window NOT waiting for text, on the same
    /// absent path, is neither vacant nor missing: that is the scratchpad's
    /// ordinary first launch, which this must not change.
    func testANewFolderTabShouldBeVacantAndHaveNothingToTrash() {
        let note = folder.appendingPathComponent("Untitled.md")
        let ordinary = Coordinator(boundTo: note, slot: nil, remembersFrame: false, frame: nil, explorerRoot: folder)
        defer { ordinary.tearDown() }
        XCTAssertFalse(ordinary.isVacant, "an absent path alone is not a vacant window")

        let tab = Coordinator(boundTo: note, slot: nil, remembersFrame: false, frame: nil, explorerRoot: folder)
        defer { tab.tearDown() }
        tab.awaitFirstText(openingOnOverview: true)
        XCTAssertTrue(tab.awaitsFirstText)
        XCTAssertTrue(tab.isVacant, "an untouched unwritten note has nothing to lose by being taken over")
        XCTAssertFalse(tab.canMoveBoundFileToTrash)
        XCTAssertFalse(FileManager.default.fileExists(atPath: note.path), "binding the tab must write nothing")
    }

    /// A name a tab is bound to is taken although nothing is on disk there,
    /// so a second Cmd+T (or New Note in the folder) does not get the same
    /// path and put two buffers over it.
    func testANameAnOpenTabHoldsShouldBeSkippedLikeAFileOnDisk() {
        let first = Coordinator.unusedURL(in: folder, stem: "Untitled", extension: "md")
        XCTAssertEqual(first.lastPathComponent, "Untitled.md")
        let held: (URL) -> Bool = { $0.standardizedFileURL == first.standardizedFileURL }
        XCTAssertEqual(Coordinator.unusedURL(in: folder, stem: "Untitled", extension: "md", alsoTaken: held)
            .lastPathComponent, "Untitled 2.md")
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.path))
    }

    // MARK: the wiring, as text

    private func source(_ file: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Sources/\(file)")
        return try XCTUnwrap(try? String(contentsOf: url, encoding: .utf8),
                             "could not read \(url.path); if it moved, this guard must follow it")
    }

    /// One function's body, by brace depth from its signature.
    private func body(of signature: String, in text: String) throws -> String {
        let lines = text.components(separatedBy: "\n")
        let start = try XCTUnwrap(lines.firstIndex { $0.contains(signature) },
                                  "\(signature) is gone or renamed, and this guard names it")
        var depth = 0
        var body: [String] = []
        for index in start..<lines.count {
            let line = lines[index]
            body.append(line)
            depth += line.filter { $0 == "{" }.count - line.filter { $0 == "}" }.count
            if depth <= 0, index > start { break }
        }
        return body.joined(separator: "\n")
    }

    /// The folder branch of Cmd+T makes no file, binds the tab as waiting,
    /// and asks for the overview; the loose branch is untouched and still
    /// makes its note up front.
    func testCmdTInAFolderWindowShouldMakeNoFileAndOpenOnTheOverview() throws {
        let newTab = try body(of: "func newTab(in spawn: Coordinator)", in: source("BirtaWriter/WindowSet.swift"))
        let parts = newTab.components(separatedBy: "} else {")
        XCTAssertEqual(parts.count, 2, "newTab's two branches are what this reads; it needs rewriting")
        let folderBranch = parts[0]
        XCTAssertTrue(folderBranch.contains("explorerRoot"), "the first branch is no longer the folder's")
        XCTAssertFalse(folderBranch.contains("makeNoteFile"), "a folder tab must not make its file up front")
        XCTAssertFalse(folderBranch.contains("AtomicFile"), "a folder tab must not make its file up front")
        XCTAssertTrue(folderBranch.contains("awaitFirstText(openingOnOverview: true)"))
        XCTAssertTrue(folderBranch.contains("alsoTaken: boundByAWindow"),
                      "the free name must skip names other tabs hold")
        XCTAssertTrue(parts[1].contains("makeNoteFile"), "Cmd+T outside a folder window is unchanged")
    }

    /// Every write funnels through `writeLatest`, so the hold is asked there,
    /// before the bytes go to the writer, and only an asked-for save passes it.
    func testTheOneWriteFunnelShouldHoldABlankUnwrittenNoteBeforeSubmitting() throws {
        let text = try source("BirtaWriter/Coordinator.swift")
        let funnel = try body(of: "private func writeLatest(", in: text)
        let hold = try XCTUnwrap(funnel.range(of: "guard saveAskedFor || UnwrittenNote.mayWrite(awaitingText: awaitsFirstText, buffer: latest) else"),
                                 "writeLatest no longer asks UnwrittenNote, or something other than an asked-for save is let past it")
        let submit = try XCTUnwrap(funnel.range(of: "writer.submit("))
        XCTAssertLessThan(hold.lowerBound, submit.lowerBound, "the hold must come before the write")
        // The quit prompt does not ask about a note with nothing to save.
        let decide = try body(of: "private func decideFinalWrite(", in: text)
        XCTAssertTrue(decide.contains("UnwrittenNote.mayWrite(awaitingText: awaitsFirstText, buffer: latest)"))
    }

    /// Only a save somebody asked for makes a blank never-written note's
    /// file. `.explicitSave` is also how the app flushes for its own reasons
    /// (the welcome screen, leaving a document, Discard), so the trigger
    /// cannot be the permission. The asked-for save is let past the hold for
    /// its one write and does not end the wait itself: only the bytes landing
    /// do, so a refused save leaves the note waiting. Its callers are named:
    /// Cmd+S, the debug hook that stands in for it, and the two gestures that
    /// hand the file's path to something that will read it.
    func testOnlyASaveSomebodyAskedForShouldMakeTheFileAndOnlyALandedWriteEndTheWait() throws {
        let text = try source("BirtaWriter/Coordinator.swift")
        let write = try body(of: "private func write(_ trigger: WriteTrigger)", in: text)
        XCTAssertFalse(write.contains("explicitSave"), "the trigger must not be what lets a blank note's file be made")
        let asked = try body(of: "private func writeSaveSomebodyAskedFor()", in: text)
        XCTAssertFalse(asked.contains("awaitsFirstText"), "a save that may be refused must not end the wait before it lands")
        XCTAssertTrue(asked.contains("saveAskedFor = true") && asked.contains("defer { saveAskedFor = false }"))
        let funnel = try body(of: "private func writeLatest(", in: text)
        XCTAssertTrue(funnel.contains("guard saveAskedFor || UnwrittenNote.mayWrite("))
        let lines = text.components(separatedBy: "\n")
        let enders = lines.indices.filter {
            lines[$0].contains("awaitsFirstText = false") && !lines[$0].contains("var awaitsFirstText") && !isComment(lines[$0])
        }
        let places = ["private var everSeenOnDisk = false {", "private var boundURL: URL {"]
        XCTAssertEqual(enders.count, 2, "the wait ends where the note lands and where the tab is rebound: \(enders.map { $0 + 1 })")
        for index in enders {
            let inside = places.contains { sig in
                guard let start = lines.firstIndex(where: { $0.contains(sig) }) else { return false }
                return (start...min(start + 60, lines.count - 1)).contains(index)
            }
            XCTAssertTrue(inside, "Coordinator.swift:\(index + 1) ends the wait outside those two places")
        }
        let callers = lines.filter { $0.contains("writeSaveSomebodyAskedFor()") && !$0.contains("func ") && !isComment($0) }
        XCTAssertEqual(callers.count, 4, "Cmd+S, its debug stand-in, Copy Reference and an /ai run, and nothing else")
        XCTAssertTrue(try body(of: "func saveNow()", in: text).contains("self.writeSaveSomebodyAskedFor()"))
        XCTAssertTrue(try body(of: "private func copyAgentReference()", in: text).contains("self.writeSaveSomebodyAskedFor()"))
    }

    private func isComment(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).hasPrefix("//")
    }

    /// A window taken over by a file from outside goes through `replaceFile`,
    /// in both branches, which flushes the page before deciding: vacancy is
    /// read off the host's buffer, and keystrokes whose sync has not landed
    /// exist only in the page. A never-written note with text counts as
    /// unwritten bytes whatever the edited flag says.
    func testAnOutsideOpenShouldFlushAWindowBeforeTakingItOver() throws {
        let set = try source("BirtaWriter/WindowSet.swift")
        let arm = try XCTUnwrap(set.range(of: "case .vacantFront:"))
        let next = try XCTUnwrap(set.range(of: "case let .tabBeside", range: arm.upperBound..<set.endIndex))
        let body = String(set[arm.upperBound..<next.lowerBound])
        XCTAssertEqual(body.components(separatedBy: "here.replaceFile(with: target").count - 1, 2,
                       "the folder branch and the loose branch both take the window over through the flush")
        XCTAssertFalse(body.contains("here.openInPlace("), "openInPlace does not flush, so it can drop typed text")
        let coordinator = try source("BirtaWriter/Coordinator.swift")
        XCTAssertTrue(coordinator.contains(
            "isEdited || UnwrittenNote.holdsTextOnlyInBuffer(awaitingText: awaitsFirstText, buffer: latest)"))
    }

    /// The takeover waits on a flush, and the tab is spoken for from the
    /// moment it is chosen: a second open routed meanwhile must not see it as
    /// vacant (`OpenRoutingTests` holds where that open goes).
    func testATabBeingTakenOverShouldStopBeingVacantAtOnce() throws {
        let text = try source("BirtaWriter/Coordinator.swift")
        let replace = try body(of: "func replaceFile(with url: URL", in: text)
        let mark = try XCTUnwrap(replace.range(of: "isBeingTakenOver = true"))
        let flush = try XCTUnwrap(replace.range(of: "flushThen("))
        XCTAssertLessThan(mark.lowerBound, flush.lowerBound, "marked before the round trip, not after it")
        let clear = try XCTUnwrap(replace.range(of: "self.isBeingTakenOver = false"))
        let decide = try XCTUnwrap(replace.range(of: "!self.isVacant"))
        XCTAssertLessThan(clear.lowerBound, decide.lowerBound, "cleared before the tab's own vacancy is asked")
        XCTAssertTrue(try body(of: "var isVacant: Bool {", in: text).contains("!isBeingTakenOver"))
    }

    /// Rename/Move refuses a name an open tab holds, file or no file, and
    /// says which of the two it was.
    func testARenameShouldRefuseANameAnOpenTabHoldsInItsOwnWords() throws {
        let relocate = try body(of: "func relocateActiveFile(to target: URL)", in: source("BirtaWriter/Coordinator.swift"))
        XCTAssertTrue(relocate.contains("if self.heldNames?()(target) == true {"))
        XCTAssertTrue(relocate.contains("\"Another tab is already using the name \\(target.lastPathComponent).\""))
        XCTAssertFalse(relocate.contains("|| self.heldNames"), "a held name is not a file that is already there")
    }

    /// A folder with nothing to open opens on a note that is not written
    /// yet, live: no file appears in the folder.
    func testAFolderWithNothingToOpenShouldOpenOnANoteWithNoFile() throws {
        let set = WindowSet()
        let choice = set.folderDefault(in: folder)
        XCTAssertTrue(choice.unwritten)
        XCTAssertEqual(choice.url.deletingLastPathComponent().standardizedFileURL, folder.standardizedFileURL)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), [],
                       "choosing the note must write nothing into the folder")
    }

    /// Every binding to the folder's choice says it is unwritten when it is,
    /// so the hold keeps it off disk; and the choice writes nothing itself.
    func testEveryWindowOnAFolderDefaultShouldBeToldItIsUnwritten() throws {
        let set = try source("BirtaWriter/WindowSet.swift")
        let choose = try body(of: "func folderDefault(in root: URL)", in: set)
        XCTAssertFalse(choose.contains("makeNoteFile"), "the folder's choice must not write a note")
        XCTAssertEqual(choose.components(separatedBy: "boundByAWindow()").count - 1, 1, "one predicate, built once")
        let openDirectory = try body(of: "func openDirectory(at folder: URL", in: set)
        XCTAssertTrue(openDirectory.contains("if choice.unwritten { made.awaitFirstText(openingOnOverview: false) }"))
        let launch = try body(of: "func openAtLaunch(launchedWith: URL?)", in: set)
        XCTAssertTrue(launch.contains("restoredUnwritten = choice.unwritten"))
        XCTAssertTrue(launch.contains("if restoredUnwritten { made.first?.awaitFirstText(openingOnOverview: false) }"))
        XCTAssertTrue(launch.contains("for path in tabs {"), "the loop must read the filled list")
        XCTAssertTrue(launch.contains("hadUnwrittenTab") == false, "the launch reads the plan, which already pruned")
        XCTAssertTrue(try body(of: "private func snapshotOpenSet()", in: set)
            .contains("hadUnwrittenTab: members.contains(where: \\.awaitsFirstText) ? true : nil"))
        let coordinator = try source("BirtaWriter/Coordinator.swift")
        XCTAssertTrue(try body(of: "func openFolderDefault(_ choice: WindowSet.FolderDefault)", in: coordinator)
            .contains("if choice.unwritten { awaitFirstText(openingOnOverview: false) }"))
    }

    /// Remembering a recent file goes through one funnel, which refuses a
    /// path with no file; the call sites carry no rule of their own.
    func testRecentsShouldBeFilteredInTheFunnelAndNowhereElse() throws {
        let prefs = try body(of: "static func rememberRecent(_ url: URL)", in: source("BirtaWriter/Preferences.swift"))
        XCTAssertTrue(prefs.contains("RecentFiles.remembering("))
        for file in ["BirtaWriter/WindowSet.swift", "BirtaWriter/Coordinator.swift"] {
            for line in try source(file).components(separatedBy: "\n") where line.contains("Prefs.rememberRecent(") {
                XCTAssertFalse(line.contains("awaitsFirstText"), "\(file): a special case outside the funnel: \(line)")
            }
        }
        XCTAssertTrue(try body(of: "func folderDefault(in root: URL)", in: source("BirtaWriter/WindowSet.swift"))
            .contains("let openElsewhere = boundByAWindow()"), "folderDefault asks the same question as naming, through one predicate")
    }

    /// Every note the app names for itself skips a name an open tab holds,
    /// or it can land on an unwritten tab's path. Read as every call site
    /// rather than a list of them, so a new caller joins the check; the
    /// missing-note screen's Discard is the one that needs the hook, since a
    /// window cannot see the other windows itself.
    func testEveryNewNoteShouldSkipANameAnOpenTabHolds() throws {
        // The one exemption: the launch's blank note is named before any
        // window exists, so there is no tab whose name it could take.
        let launch = try body(of: "private static func startBlankNote()", in: source("BirtaWriter/WindowSet.swift"))
        let exempt = "let note = try Coordinator.makeNoteFile()"
        XCTAssertTrue(launch.contains(exempt), "the exemption no longer names startBlankNote's call")
        var calls = 0
        for file in ["BirtaWriter/WindowSet.swift", "BirtaWriter/Coordinator.swift"] {
            for line in try source(file).components(separatedBy: "\n") {
                let code = line.trimmingCharacters(in: .whitespaces)
                guard code.contains("makeNoteFile("), !code.hasPrefix("//"), !code.contains("static func makeNoteFile"),
                      !code.contains("try makeNoteFile(in: Prefs.notesDirectory"), code != exempt else { continue }
                calls += 1
                XCTAssertTrue(code.contains("alsoTaken:"), "\(file): a new note that can take a held name: \(code)")
            }
        }
        XCTAssertGreaterThanOrEqual(calls, 5, "the call sites were not found; this guard is watching nothing")
        let discard = try body(of: "func startNewNoteHere()", in: source("BirtaWriter/Coordinator.swift"))
        XCTAssertTrue(discard.contains("alsoTaken: self.heldNames?()"))
        XCTAssertTrue(try source("BirtaWriter/WindowSet.swift")
            .contains("coordinator.heldNames = { [weak self] in self?.boundByAWindow() ?? { _ in false } }"),
                      "the hook is only as good as its wiring")
    }

    /// The page is told by the command View > Folder Overview already sends,
    /// once, on the first page to come up warm.
    func testTheFirstWarmPageShouldBeSentTheOverviewCommandOnce() throws {
        let text = try source("BirtaWriter/Coordinator.swift")
        let sends = text.components(separatedBy: "host.send(.editorCommand(\"showFolderOverview\"))").count - 1
        XCTAssertEqual(sends, 1)
        let at = try XCTUnwrap(text.range(of: "host.send(.editorCommand(\"showFolderOverview\"))"))
        let before = text[text.index(at.lowerBound, offsetBy: -1500)..<at.lowerBound]
        XCTAssertTrue(before.contains("if opensOnFolderOverview {") && before.contains("opensOnFolderOverview = false"),
                      "the overview is sent only when asked for, and spent as it is sent")
        XCTAssertTrue(before.contains("state = .warm"), "sent once the page can hear it")
    }
}
