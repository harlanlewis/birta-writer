import XCTest
@testable import BirtaJot

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
/// `jot/scripts/measure.sh` is what found it and what proves the fix end to
/// end, but it found it INTERMITTENTLY: the write only lands when the page
/// answers before the panel is inspected. An intermittent gate is a poor
/// regression check, because the reading that costs nothing is to run it again.
/// This is the deterministic half.
///
/// Derived rather than hand-listed. The rule is a property of each call site's
/// own closure: a `then` that consults the policy must not have been written
/// to already. So every `flushThen` call is found, its closure is read, and the
/// ones that consult the policy are required to say `persisting: false`. A new
/// caller joins by being written, and a fourth `WriteTrigger` joins by not
/// being `.explicitSave`, neither of which needs an edit here.
@MainActor
final class FlushWriteTests: XCTestCase {
    /// The only trigger `AutosavePolicy` cannot refuse: it IS the user saying
    /// so, so a caller following with one always wants the bytes written and
    /// the flush writing them first changes nothing.
    private let alwaysWrites = "write(.explicitSave)"

    private func source() -> [String] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaJotTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // jot
            .appendingPathComponent("Sources/BirtaJot/Coordinator.swift")
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
            guard line.contains("flushThen"), !line.contains("func flushThen") else { continue }
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
    /// always writes must NOT be marked, or the marking would spread until it
    /// meant nothing and the assertion above would hold trivially.
    func testAFlushThatIsAlwaysFollowedByASaveShouldNotBeMarked() {
        let lines = source()
        guard !lines.isEmpty else { return }

        var plain = 0
        for call in flushCalls(in: lines) where !consultsPolicy(call.body) {
            plain += 1
            XCTAssertFalse(call.text.contains("persisting: false"),
                           "Coordinator.swift:\(call.line) does not consult the policy, so marking it says "
                             + "something untrue about why: " + call.text.trimmingCharacters(in: .whitespaces))
        }

        XCTAssertGreaterThan(plain, 0, "every flush was classified as deciding; the predicate discriminates nothing")
    }
}
