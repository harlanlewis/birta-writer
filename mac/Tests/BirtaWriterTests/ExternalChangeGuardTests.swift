import XCTest
@testable import BirtaWriter

/// Every path that puts bytes at the bound file asks first whether anything
/// else changed it (MAR-469).
///
/// A guard over the SOURCE, for the reason `FlushWriteTests` reads the same
/// file: what this is about is a path that does not exist yet. The rule is one
/// call in `writeLatest`, and a second write path added beside it would be
/// correct in every test anybody would think to write, and would replace
/// another tool's file on a Tuesday. A dead one was already there when this
/// landed, three years of nobody calling it away from being that path.
///
/// It fails on a `writer.submit` outside `writeLatest`, on a `writeLatest`
/// that has stopped reconciling, on a summon that has stopped looking, and on
/// an `AtomicFile` write this file has not been told the purpose of. None is a
/// rule about spelling: they are the halves of "the file is read before it is
/// written", which nothing else in the suite can see, since a Coordinator
/// needs a window and a web process to be driven at all (which is what
/// `mac/scripts/check-external-change.sh` does, and why it exists).
@MainActor
final class ExternalChangeGuardTests: XCTestCase {
    private func source() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Sources/BirtaWriter/Coordinator.swift")
        return try XCTUnwrap(try? String(contentsOf: url, encoding: .utf8),
                             "could not read \(url.path); if Coordinator.swift moved, this guard must follow it")
    }

    /// One function's body, by brace depth from its signature.
    private func functionBody(named name: String, in text: String) throws -> String {
        let lines = text.components(separatedBy: "\n")
        let start = try XCTUnwrap(lines.firstIndex { Self.functionName(declaredIn: $0) == name },
                                  "\(name) is gone or renamed, and this guard names it")
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

    /// The body of the one function allowed to submit, by brace depth from its
    /// signature. Returned separately so the sweep below can say which side of
    /// it a submission is on.
    private func writeLatestBody(of text: String) throws -> (body: String, rest: String) {
        let lines = text.components(separatedBy: "\n")
        let start = try XCTUnwrap(lines.firstIndex { $0.contains("private func writeLatest(") },
                                  "writeLatest is what every write goes through; it is gone or renamed")
        var depth = 0
        var body: [String] = []
        var rest = lines[..<start].joined(separator: "\n")
        var index = start
        while index < lines.count {
            let line = lines[index]
            body.append(line)
            depth += line.filter { $0 == "{" }.count - line.filter { $0 == "}" }.count
            index += 1
            if depth <= 0, index > start { break }
        }
        rest += "\n" + lines[index...].joined(separator: "\n")
        return (body.joined(separator: "\n"), rest)
    }

    /// The functions in `Coordinator` that call an `AtomicFile` write helper,
    /// paired with what the write is for.
    ///
    /// `writer.submit` is not the only way bytes reach a path, and the arm
    /// below it was the whole of this guard: an `AtomicFile.writeString` with
    /// the bound file as its destination would have passed. So every call site
    /// is enumerated here, and a new one fails this test rather than shipping,
    /// which is the only moment anybody asks which of the two kinds it is.
    ///
    /// Two kinds. A write BESIDE the note (a rescue, a new note, a copy, a
    /// relocation) is not this rule's business: it lands on a path nothing is
    /// bound to. A write AT the bound file has to leave the baseline
    /// describing what it put there, which in practice means going on to
    /// `bindTo` or `rebase`.
    private static let writesBesideTheNote: Set<String> = [
        "rescueMissingNote",      // the buffer, beside a note that was deleted
        "rescueDriftedBuffer",    // the buffer, beside a note something else changed
        "rescueAgentVersion",     // the agent's version, beside the note
        "makeNoteFile",           // a new note, at a path nothing is bound to yet
        "relocateActiveFile",     // a rename with no file to move yet, at the new path
        "saveAs",                 // Save As writes a copy and leaves the binding alone
    ]
    private static let writesTheBoundFile: Set<String> = [
        "seedFirstRunNote",       // the tour, over the empty scratchpad on a first run
    ]

    /// Call sites of the write helpers, as (enclosing function, line).
    private func atomicWrites(in lines: [String]) -> [(function: String, line: Int)] {
        var found: [(String, Int)] = []
        var current = "(top level)"
        for (index, line) in lines.enumerated() {
            if let name = Self.functionName(declaredIn: line) { current = name }
            // Code only. This file explains itself at length, and half a dozen
            // of those paragraphs name the write helpers; a sweep that counted
            // them would be reporting on the prose.
            let code = line.trimmingCharacters(in: .whitespaces)
            guard !code.hasPrefix("//") else { continue }
            if code.contains("AtomicFile.write") { found.append((current, index + 1)) }
        }
        return found
    }

    private static func functionName(declaredIn line: String) -> String? {
        guard let range = line.range(of: "func ") else { return nil }
        let after = line[range.upperBound...]
        let name = after.prefix { $0.isLetter || $0.isNumber || $0 == "_" }
        return name.isEmpty ? nil : String(name)
    }

    func testEveryAtomicWriteInTheCoordinatorShouldBeOneOfTheTwoKnownKinds() throws {
        let lines = try source().components(separatedBy: "\n")
        let writes = atomicWrites(in: lines)
        XCTAssertGreaterThanOrEqual(writes.count, 6,
                                    "the sweep found almost nothing; the write helpers have been "
                                    + "renamed and this guard is now matching text that is gone")
        let known = Self.writesBesideTheNote.union(Self.writesTheBoundFile)
        for write in writes {
            XCTAssertTrue(known.contains(write.function),
                          "Coordinator.swift:\(write.line): \(write.function) writes a file and is "
                          + "in neither list. If it writes beside the note, say so there; if it "
                          + "writes the bound file, it must leave the baseline describing what it "
                          + "wrote, or the next write goes over somebody else's edit unasked")
        }
    }

    func testAWriteAtTheBoundFileShouldLeaveTheBaselineDescribingIt() throws {
        let text = try source()
        for name in Self.writesTheBoundFile {
            let body = try functionBody(named: name, in: text)
            XCTAssertTrue(body.contains("bindTo(") || body.contains("rebase("),
                          "\(name) writes the bound file and does not take the baseline again")
        }
    }

    func testTheOnlyPlaceThatSubmitsToTheWriterShouldBeWriteLatest() throws {
        let text = try source()
        let split = try writeLatestBody(of: text)
        XCTAssertEqual(split.body.components(separatedBy: "writer.submit(").count - 1, 1,
                       "writeLatest submits exactly once")
        XCTAssertFalse(split.rest.contains("writer.submit("),
                       "a second write path would write the buffer over a file nobody re-read")
    }

    func testWriteLatestShouldReconcileBeforeItSubmits() throws {
        let body = try writeLatestBody(of: source()).body
        let reconcile = try XCTUnwrap(body.range(of: "reconcileWithDisk("),
                                      "the write no longer asks whether the file changed")
        let submit = try XCTUnwrap(body.range(of: "writer.submit("))
        XCTAssertTrue(reconcile.lowerBound < submit.lowerBound,
                      "asking after the bytes have gone is asking about a file we just replaced")
        XCTAssertTrue(body.contains("guard reconcileWithDisk("),
                      "the answer decides whether the write happens; an unread one decides nothing")
    }

    /// The autosave tick must not stand on the main thread waiting for its
    /// predecessor to reach the disk.
    ///
    /// A spelling check, and it is here because the property is invisible to
    /// every other instrument: the wait only happens when a write is still in
    /// flight, which a test would have to manufacture with a timer, and a
    /// timing assertion on a shared machine measures the machine. What it
    /// pins is that the write's own answer to "may I block" is the one the
    /// check is given, rather than the default.
    func testTheWriteShouldHandItsOwnPatienceToTheCheck() throws {
        let body = try writeLatestBody(of: source()).body
        XCTAssertTrue(body.contains("reconcileWithDisk(asking: true, mayWait: waiting)"),
                      "the check decides on its own whether to wait for the disk, so the autosave "
                      + "tick waits for the write before it on the thread the keystrokes arrive on")
    }

    /// Both places that decline to look ask the WRITER whether anything is in
    /// flight, and neither asks this window's own pending flag.
    ///
    /// The two predicates read alike and differ in the one way that matters.
    /// `writer.isIdle` stops being false the moment the bytes land;
    /// `pendingWrite` stays set until this window next accounts for its own
    /// write, which the autosave path never does, so declining on it declines
    /// for ever. Both of these functions were written with the flag first and
    /// both had to be fixed, which is why this is pinned by name rather than
    /// left to a reader to notice: nothing in either function's behaviour
    /// shows the difference until a notification is dropped or a check is
    /// skipped, and the one instrument that sees either is a shell script
    /// somebody has to run.
    func testTheTwoPlacesThatDeclineToLookShouldAskTheWriterRatherThanAFlag() throws {
        let text = try source()
        for name in ["reconcileWithDisk", "noteChangedOnDisk"] {
            let body = try functionBody(named: name, in: text)
            let code = body.components(separatedBy: "\n")
                .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
                .joined(separator: "\n")
            XCTAssertTrue(code.contains("writer.isIdle"),
                          "\(name) no longer asks the writer whether a write is in flight")
            XCTAssertFalse(code.contains("pendingWrite == nil") || code.contains("pendingWrite != nil"),
                           "\(name) decides on a flag that stays set until the next reconcile, so it "
                           + "stops looking altogether after a typing burst")
        }
    }

    /// An `/ai` run in flight decides whether a conflict ASKS now, never
    /// whether the file is looked at (MAR-478).
    ///
    /// The shape this pins is the order: the run's status is read after the
    /// disk has been compared, so the write is refused for a file that moved
    /// whatever moved it. A guard on the run ahead of the comparison is the
    /// exemption this replaced, under which autosave wrote over a third
    /// program's change for as long as an agent took, and the check itself
    /// reads as cautious either way, which is why the order is pinned rather
    /// than left to a reader. The comparison's own verdicts are `DiskDrift`'s,
    /// and what the arms of `mac/scripts/check-external-change.sh` drive is
    /// the app doing this to a real file.
    func testARunInFlightShouldGovernOnlyWhetherAConflictAsksNow() throws {
        let body = try functionBody(named: "reconcileWithDisk", in: source())
        let code = body.components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
        let run = try XCTUnwrap(code.range(of: "agent.hasRunsInFlight"),
                                "reconcileWithDisk no longer consults the run at all, so a conflict "
                                + "found in the middle of one asks about the file the agent is editing")
        let judge = try XCTUnwrap(code.range(of: "DiskDrift.judge("),
                                  "the comparison is gone or renamed, and this guard names it")
        XCTAssertTrue(judge.lowerBound < run.lowerBound,
                      "the run is consulted before the disk is compared, which is the check "
                      + "standing down for every writer while an agent works")
        XCTAssertEqual(code.components(separatedBy: "agent.hasRunsInFlight").count - 1, 1,
                       "the run is consulted in one place, the asking, and nowhere before it")
    }

    /// The other side of the same rule: a summon is where a stale panel is
    /// corrected and the only place there is a window to put the question on.
    func testTheSummonShouldReconcileToo() throws {
        let text = try source()
        let show = try XCTUnwrap(text.range(of: "\n    func show() {"))
        let after = text[show.upperBound...]
        let end = try XCTUnwrap(after.range(of: "\n    }\n"))
        XCTAssertTrue(after[..<end.lowerBound].contains("reconcileWithDisk("),
                      "a summon that does not look is how a file edited elsewhere stays invisible")
    }
}
