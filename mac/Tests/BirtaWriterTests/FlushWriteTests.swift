import XCTest
@testable import BirtaWriter

/// The rule `flushThen`'s own header states: `write(_:)` is the one funnel,
/// and a flush writes nothing of its own.
///
/// That rule was already true of two paths out of three. When a flush times
/// out, and when the page is not warm enough to be asked, the fallbacks run
/// `then` and write nothing. The third path, the one that runs whenever the
/// page actually answers, wrote unconditionally, on the belief that "a flush
/// only ever happens because something that always writes asked for one".
///
/// Hiding the panel with autosave off is a flush asked for by something that
/// does NOT write, and so is quitting, where `AutosavePolicy` says to ask. So
/// with autosave off, hiding wrote the buffer to disk, and on the way out of a
/// quit the file was written before the Save / Don't Save sheet appeared, which
/// made Don't Save an answer to a question already settled (MAR-420).
///
/// `mac/scripts/measure.sh` is what found it and what proves the fix end to
/// end, but it found it INTERMITTENTLY: the write only lands when the page
/// answers before the panel is inspected. An intermittent gate is a poor
/// regression check, because the reading that costs nothing is to run it again.
/// This is the deterministic half.
///
/// Derived rather than hand-listed. The rule is a property of each call site's
/// own closure, which falls in one of three kinds. A `then` that consults the
/// policy must not have been written to already, so it says
/// `persisting: false`. A `then` that saves this note itself takes the default,
/// because the flush's write is one it makes anyway. A `then` that does
/// neither (a copy written elsewhere, an append to another file, the clipboard,
/// a reload that reads the file back) has no save of its own to lean on, so
/// the flush's write is the only one there is, and the call spells out which
/// it wants. A new caller joins by being written, and a fourth `WriteTrigger`
/// joins by not being `.explicitSave`, neither of which needs an edit here.
@MainActor
final class FlushWriteTests: XCTestCase {
    /// The only trigger `AutosavePolicy` cannot refuse: it IS the user saying
    /// so, so a caller following with one always wants the bytes written and
    /// the flush writing them first changes nothing.
    private let alwaysWrites = "write(.explicitSave)"

    /// Whether this closure saves this note itself, through the explicit save
    /// or the funnel a save somebody asked for goes through.
    private func savesItself(_ body: String) -> Bool {
        body.contains(alwaysWrites) || body.contains("writeSaveSomebodyAskedFor")
    }

    /// The function a call sits in, read back from the call to the nearest
    /// `func` declaration above it.
    private func enclosingFunction(of call: Call, in lines: [String]) -> String? {
        for line in lines[..<(call.line - 1)].reversed() {
            guard let range = line.range(of: "func ") else { continue }
            return String(line[range.upperBound...].prefix { $0 != "(" })
        }
        return nil
    }

    private func source() -> [String] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Sources/BirtaWriter/Coordinator.swift")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            XCTFail("could not read \(url.path); if Coordinator.swift moved, this guard must follow it")
            return []
        }
        return text.components(separatedBy: "\n")
    }

    /// The call and the body of the closure it was given.
    private struct Call {
        let line: Int
        let text: String
        let body: String
    }

    private func flushCalls(in lines: [String]) -> [Call] {
        var calls: [Call] = []
        for (index, line) in lines.enumerated() {
            // Both spellings: `flushThen {` for a caller taking the default,
            // and `flushThen(persisting:) {` for one that does not. Matching
            // only the parenthesised form finds exactly the marked calls, so
            // the sweep would confirm that everything it looked at was marked
            // and never notice the eleven it had not looked at.
            guard line.contains("flushThen"), !line.contains("func flushThen"),
                  !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") else { continue }
            let indent = line.prefix { $0 == " " }.count
            // A call written on ONE line closes its own closure, and reading
            // past it would sweep in whatever followed until the next brace at
            // this indentation. That is not hypothetical: it swallowed the rest
            // of the file and classified every call as deciding, which is what
            // the discrimination assertion at the foot of each test is for.
            if line.filter({ $0 == "{" }).count == line.filter({ $0 == "}" }).count {
                calls.append(Call(line: index + 1, text: line, body: line))
                continue
            }
            // Otherwise the closure ends at the first `}` back at the call's
            // own indentation, which is how every multi-line one is written.
            var body: [String] = []
            for next in lines[(index + 1)...] {
                let trimmed = next.trimmingCharacters(in: .whitespaces)
                if trimmed == "}" && next.prefix { $0 == " " }.count == indent { break }
                body.append(next)
            }
            calls.append(Call(line: index + 1, text: line, body: body.joined(separator: "\n")))
        }
        return calls
    }

    /// Whether this closure's own body may decide NOT to write.
    ///
    /// Two ways to reach `AutosavePolicy`: a `write(_:)` with any trigger other
    /// than the one it cannot refuse, and `decideFinalWrite`, which is the quit
    /// question. Written as "a write that is not the explicit one" so that a
    /// trigger added to `WriteTrigger` later is covered without an edit.
    private func consultsPolicy(_ body: String) -> Bool {
        if body.contains("decideFinalWrite") { return true }
        var rest = Substring(body)
        while let found = rest.range(of: "write(.") {
            let call = rest[found.lowerBound...].prefix { $0 != ")" } + ")"
            if call != alwaysWrites { return true }
            rest = rest[found.upperBound...]
        }
        return false
    }

    func testAFlushWhoseCallerMayRefuseToWriteMustNotWriteItself() {
        let lines = source()
        guard !lines.isEmpty else { return }
        let calls = flushCalls(in: lines)

        XCTAssertFalse(calls.isEmpty, "no flushThen calls were found; this guard is watching nothing")

        var deciding = 0
        for call in calls where consultsPolicy(call.body) {
            deciding += 1
            XCTAssertTrue(call.text.contains("persisting: false"),
                          "Coordinator.swift:\(call.line) flushes and then lets AutosavePolicy decide, "
                            + "so the flush must not write first: " + call.text.trimmingCharacters(in: .whitespaces))
        }

        // Without this the sweep passes when `consultsPolicy` has quietly
        // stopped matching anything, which is the same green as a codebase
        // with no such caller in it.
        XCTAssertGreaterThanOrEqual(deciding, 2,
                                    "hiding the panel and quitting are both flushes whose caller may refuse "
                                     + "to write; finding fewer than two means this guard stopped recognising them")
    }

    /// The other half, and the one that keeps the first honest: a caller that
    /// always saves must NOT be marked, or the marking would spread until it
    /// meant nothing and the assertion above would hold trivially.
    func testAFlushThatIsAlwaysFollowedByASaveShouldNotBeMarked() {
        let lines = source()
        guard !lines.isEmpty else { return }

        var plain = 0
        for call in flushCalls(in: lines) where !consultsPolicy(call.body) && savesItself(call.body) {
            plain += 1
            XCTAssertFalse(call.text.contains("persisting:"),
                           "Coordinator.swift:\(call.line) saves this note itself, so the default is the "
                             + "honest spelling: " + call.text.trimmingCharacters(in: .whitespaces))
        }

        XCTAssertGreaterThan(plain, 0, "every flush was classified as deciding; the predicate discriminates nothing")
    }

    /// The third kind: a `then` that neither consults the policy nor saves this
    /// note has no save of its own behind the flush, so the flush's write is
    /// the only one, and with autosave off it is a save nobody asked for.
    /// Such a call says which it wants. The three that write elsewhere (Save a
    /// Copy As, Append to Note, and the clipboard and Share through
    /// `withFlushedContent`) promise to leave this note as it is, so they say
    /// false.
    func testAFlushWithNoSaveOfItsOwnShouldSayWhetherItPersists() {
        let lines = source()
        guard !lines.isEmpty else { return }

        var neither: [String: Call] = [:]
        for call in flushCalls(in: lines) where !consultsPolicy(call.body) && !savesItself(call.body) {
            XCTAssertTrue(call.text.contains("persisting:"),
                          "Coordinator.swift:\(call.line) neither saves this note nor asks AutosavePolicy, so "
                            + "the default's write is the only one it makes; say persisting: true or false: "
                            + call.text.trimmingCharacters(in: .whitespaces))
            if let name = enclosingFunction(of: call, in: lines) { neither[name] = call }
        }

        for name in ["saveAs", "appendToNote", "withFlushedContent"] {
            guard let call = neither[name] else {
                XCTFail("no flush of the third kind in \(name); this guard stopped recognising it")
                continue
            }
            XCTAssertTrue(call.text.contains("persisting: false"),
                          "\(name) writes elsewhere and leaves this note as it is, so its flush must not "
                            + "write it (Coordinator.swift:\(call.line))")
        }
    }

    /// A flush that timed out ran `then` against `latest`, which can lack
    /// keystrokes the page still holds. A closure that then replaces the
    /// page's document (`pushDocument`) would discard them, so it has to be
    /// told whether the page answered, and refuse when it did not.
    func testAFlushThatPushesADocumentOverThePageShouldRefuseWhenThePageDidNotAnswer() {
        let lines = source()
        guard !lines.isEmpty else { return }

        var pushing = 0
        for call in flushCalls(in: lines) where call.body.contains("pushDocument(") {
            pushing += 1
            let spoken = call.text.trimmingCharacters(in: .whitespaces)
            XCTAssertTrue(call.text.contains("flushThenAnswered") && call.text.contains("answered in"),
                          "Coordinator.swift:\(call.line) pushes a document over the page after a flush, so it "
                            + "must ask whether the page answered: " + spoken)
            XCTAssertTrue(call.body.contains("guard answered"),
                          "Coordinator.swift:\(call.line) is told whether the page answered and must refuse "
                            + "when it did not: " + spoken)
        }
        // Append to Note's receiving tab is one; finding none means the sweep
        // stopped recognising the shape, not that the risk went away.
        XCTAssertGreaterThanOrEqual(pushing, 1, "no flush closure pushes a document; this guard is watching nothing")
    }

    /// The other half of the same rule. A `persisting: false` caller decides
    /// from `isEdited` whether leaving is safe (hiding with autosave off, the
    /// explorer replacing a tab), and the flush is what brings keystrokes no
    /// sync has reported yet. If the admitted flush moves the buffer without
    /// marking it edited, that caller reads "nothing unsaved" and the last
    /// keystrokes go with the file it leaves.
    func testAnAdmittedFlushThatMovesTheBufferShouldMarkItEdited() {
        let lines = source()
        guard let start = lines.firstIndex(where: { $0.contains("case let .flushResult(") }) else {
            return XCTFail("no flushResult arm in Coordinator.swift; this guard must follow it")
        }
        guard let admit = lines[start...].firstIndex(where: { $0.contains("case .admit:") }),
              let next = lines[(admit + 1)...].firstIndex(where: { $0.contains("case .repush") }) else {
            return XCTFail("the flushResult arm no longer has the admit/repush shape this guard reads")
        }
        let arm = lines[admit..<next].joined(separator: "\n")
        XCTAssertTrue(arm.contains("isEdited = true"),
                      "an admitted flush must mark the buffer edited when it moved it")
    }
}
