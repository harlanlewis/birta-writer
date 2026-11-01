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
    /// before the bytes go to the writer, and nothing passes it.
    func testTheOneWriteFunnelShouldHoldABlankUnwrittenNoteBeforeSubmitting() throws {
        let text = try source("BirtaWriter/Coordinator.swift")
        let funnel = try body(of: "private func writeLatest(", in: text)
        let hold = try XCTUnwrap(funnel.range(of: "guard UnwrittenNote.mayWrite(awaitingText: awaitsFirstText, buffer: latest) else"),
                                 "writeLatest no longer asks UnwrittenNote, or something is let past it")
        let submit = try XCTUnwrap(funnel.range(of: "writer.submit("))
        XCTAssertLessThan(hold.lowerBound, submit.lowerBound, "the hold must come before the write")
        // The quit prompt does not ask about a note with nothing to save.
        let decide = try body(of: "private func decideFinalWrite(", in: text)
        XCTAssertTrue(decide.contains("UnwrittenNote.mayWrite(awaitingText: awaitsFirstText, buffer: latest)"))
    }

    /// Only a save the person asked for makes a blank never-written note's
    /// file. `.explicitSave` is also how the app flushes for its own reasons
    /// (an agent run, Copy Reference, the welcome screen, leaving a document,
    /// Discard), so the trigger cannot be the permission: the wait is ended
    /// by name, in one function, called from Cmd+S and from the debug hook
    /// that stands in for Cmd+S.
    func testOnlyASaveSomebodyAskedForShouldEndTheWait() throws {
        let text = try source("BirtaWriter/Coordinator.swift")
        let write = try body(of: "private func write(_ trigger: WriteTrigger)", in: text)
        XCTAssertFalse(write.contains("explicitSave"), "the trigger must not be what lets a blank note's file be made")
        let lines = text.components(separatedBy: "\n")
        let enders = lines.indices.filter { lines[$0].contains("awaitsFirstText = false") && !lines[$0].contains("var awaitsFirstText") && !isComment(lines[$0]) }
        let didSets = ["private var everSeenOnDisk = false {", "private var boundURL: URL {",
                       "private func writeSaveSomebodyAskedFor()"]
        XCTAssertEqual(enders.count, 3, "the wait ends in exactly three places: \(enders.map { $0 + 1 })")
        for index in enders {
            let inside = didSets.contains { sig in
                guard let start = lines.firstIndex(where: { $0.contains(sig) }) else { return false }
                return (start...min(start + 60, lines.count - 1)).contains(index)
            }
            XCTAssertTrue(inside, "Coordinator.swift:\(index + 1) ends the wait outside the three places")
        }
        let callers = lines.filter { $0.contains("writeSaveSomebodyAskedFor()") && !$0.contains("func ") && !isComment($0) }
        XCTAssertEqual(callers.count, 2, "Cmd+S and its debug stand-in, and nothing else")
        XCTAssertTrue(try body(of: "func saveNow()", in: text).contains("self.writeSaveSomebodyAskedFor()"))
    }

    private func isComment(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).hasPrefix("//")
    }

    /// A tab taken over by a file from outside goes through `replaceFile`,
    /// which flushes the page before deciding: vacancy is read off the host's
    /// buffer, and keystrokes whose sync has not landed exist only in the
    /// page. A never-written note with text counts as unwritten bytes whatever
    /// the edited flag says, because that flush brings text across without it.
    func testAnOutsideOpenShouldFlushATabBeforeTakingItOver() throws {
        let set = try source("BirtaWriter/WindowSet.swift")
        let arm = try XCTUnwrap(set.range(of: "case .vacantFront:"))
        let next = try XCTUnwrap(set.range(of: "case let .tabBeside", range: arm.upperBound..<set.endIndex))
        let body = String(set[arm.upperBound..<next.lowerBound])
        let rooted = try XCTUnwrap(body.components(separatedBy: "Prefs.documentURL = target").first)
        XCTAssertTrue(rooted.contains("here.replaceFile(with: target"), "a folder tab must be flushed before it is replaced")
        XCTAssertFalse(rooted.contains("here.openInPlace("), "openInPlace does not flush, so it can drop typed text")
        let coordinator = try source("BirtaWriter/Coordinator.swift")
        XCTAssertTrue(coordinator.contains(
            "isEdited || UnwrittenNote.holdsTextOnlyInBuffer(awaitingText: awaitsFirstText, buffer: latest)"))
    }

    /// Rename/Move refuses a name an open tab holds, file or no file.
    func testARenameShouldRefuseANameAnOpenTabHolds() throws {
        let relocate = try body(of: "func relocateActiveFile(to target: URL)", in: source("BirtaWriter/Coordinator.swift"))
        XCTAssertTrue(relocate.contains("manager.fileExists(atPath: target.path) || self.heldNames?()(target) == true"))
    }

    /// A folder window whose tabs were all never written comes back on the
    /// folder's own choice of file (`OpenSet.pruned` keeps the group).
    func testARestoredFolderGroupWithNoTabsShouldOpenOnTheFolderDefault() throws {
        let launch = try body(of: "func openAtLaunch(launchedWith: URL?)", in: source("BirtaWriter/WindowSet.swift"))
        XCTAssertTrue(launch.contains("if tabs.isEmpty, let root, let first = folderDefault(in: root)"))
        XCTAssertTrue(launch.contains("for path in tabs {"), "the loop must read the filled list")
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
        XCTAssertGreaterThanOrEqual(calls, 6, "the call sites were not found; this guard is watching nothing")
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
