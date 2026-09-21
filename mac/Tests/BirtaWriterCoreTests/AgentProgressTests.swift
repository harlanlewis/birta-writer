import XCTest
@testable import BirtaWriterCore

/// The Swift half of a reader that exists twice. The cases come from
/// `shared/__fixtures__/agentProgressCases.json`, which
/// `src/__tests__/agentProgress.test.ts` reads too, so a line only one of the
/// two readers produces fails here rather than sitting undiscovered in
/// whichever implementation was not updated.
final class AgentProgressTests: XCTestCase {
    private struct Feed: Decodable {
        let stream: String
        let chunk: String
        let repeatCount: Int?
        let feeds: Int?
        let shows: String?

        enum CodingKeys: String, CodingKey {
            case stream, chunk, feeds, shows
            case repeatCount = "repeat"
        }
    }

    private struct Case: Decodable {
        let name: String
        let why: String
        let feed: [Feed]
        let structured: Bool
        let lastSaid: String?
    }

    private struct Cases: Decodable {
        let cases: [Case]
    }

    private func loadCases() throws -> [Case] {
        // From this file to the repository root: Tests/BirtaWriterCoreTests -> mac -> repo.
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let file = root.appendingPathComponent("shared/__fixtures__/agentProgressCases.json")
        return try JSONDecoder().decode(Cases.self, from: Data(contentsOf: file)).cases
    }

    /// What each feed entry's last read answered, and the reader it left.
    private func play(_ c: Case) -> (shown: [String?], reader: AgentProgressReader) {
        let reader = AgentProgressReader()
        let shown: [String?] = c.feed.map { feed in
            let text = String(repeating: feed.chunk, count: feed.repeatCount ?? 1)
            let stream = AgentProgressReader.Stream(rawValue: feed.stream)!
            var last: String?
            for _ in 0..<(feed.feeds ?? 1) { last = reader.read(text, stream: stream) }
            return last
        }
        return (shown, reader)
    }

    func testEveryCaseInTheSharedFixtureShouldShowWhatItSays() throws {
        let cases = try loadCases()
        // An unreadable or emptied fixture would otherwise pass in silence.
        XCTAssertGreaterThanOrEqual(cases.count, 14, "the shared fixture lost its cases")
        var played = 0
        for c in cases {
            let (shown, reader) = play(c)
            XCTAssertEqual(shown, c.feed.map(\.shows), "\(c.name): \(c.why)")
            XCTAssertEqual(reader.isStructured, c.structured, "\(c.name): structured")
            XCTAssertEqual(reader.lastSaid, c.lastSaid, "\(c.name): lastSaid")
            played += 1
        }
        XCTAssertEqual(played, cases.count)
    }

    func testBothCapturedRunsShouldBeReducedToMoreThanAHandfulOfSteps() throws {
        let cases = try loadCases()
        for name in ["claude-code-2.1.278-stream-json", "codex-0.149.0-json"] {
            let c = try XCTUnwrap(cases.first { $0.name == name }, "no case \(name)")
            XCTAssertGreaterThan(play(c).shown.compactMap { $0 }.count, 3, name)
        }
    }

    func testAThinkingBlocksContentShouldNeverReachTheLine() throws {
        let c = try XCTUnwrap(try loadCases().first { $0.name == "thinking-content-withheld" })
        let shown = play(c).shown.compactMap { $0 }.joined(separator: " ")
        XCTAssertEqual(shown, "Thinking")
        XCTAssertFalse(shown.contains("production"))
    }

    /// Not in the shared cases because the extension cannot pass it: it
    /// decodes each chunk on its own, so a character split across two reads
    /// is two replacement characters there.
    func testACharacterSplitAcrossTwoReadsShouldBeDecodedWhole() {
        let reader = AgentProgressReader()
        let bytes = Array("café au lait\n".utf8)
        let split = bytes.firstIndex(of: 0xC3)! + 1
        XCTAssertNil(reader.read(Data(bytes[..<split]), stream: .stderr))
        XCTAssertEqual(reader.read(Data(bytes[split...]), stream: .stderr), "café au lait")
    }

    func testClampShouldCountUTF16AndNeverSplitACharacter() {
        let long = String(repeating: "😀", count: 50)
        let clamped = AgentProgressReader.clamp(long, AgentProgressReader.lineMax)
        XCTAssertLessThanOrEqual(clamped.utf16.count, AgentProgressReader.lineMax)
        XCTAssertTrue(clamped.hasSuffix("…"))
        XCTAssertFalse(clamped.contains("\u{FFFD}"))
    }

    // MARK: a finished transcript

    /// The whole of what a run printed, as `AgentRunner` collects it: both
    /// streams, interleaved in the order their chunks arrived.
    private func transcript(_ c: Case) -> String {
        c.feed.map { String(repeating: $0.chunk, count: $0.repeatCount ?? 1) }.joined()
    }

    /// The captured Claude Code run, read the way the Test sheet reads it
    /// rather than the way the corner does.
    ///
    /// Every step is kept, in order, where the corner shows only the newest;
    /// the two `Thinking` events in a row collapse to one, which is the
    /// throttle's rule; and a narration is kept whole rather than clamped.
    func testAStructuredTranscriptShouldReduceToEveryStepInOrder() throws {
        let c = try XCTUnwrap(try loadCases().first { $0.name == "claude-code-2.1.278-stream-json" },
                              "the shared fixture lost the captured Claude Code run")
        XCTAssertEqual(AgentProgressReader.transcriptLines(transcript(c)), [
            "Thinking",
            "I'll read the file and then append 'ok' to it.",
            "Read note.md",
            "Done. I've appended 'ok' to note.md.",
        ])
    }

    func testTheCapturedCodexRunShouldReduceToItsOwnSteps() throws {
        let c = try XCTUnwrap(try loadCases().first { $0.name == "codex-0.149.0-json" },
                              "the shared fixture lost the captured Codex run")
        let lines = try XCTUnwrap(AgentProgressReader.transcriptLines(transcript(c)))
        XCTAssertGreaterThan(lines.count, 2, "\(lines)")
        XCTAssertEqual(lines.last, "Appended `ok` to note2.md.")
        XCTAssertTrue(lines.contains("Editing note2.md"), "\(lines)")
    }

    /// The difference this reduction exists to make, and the one that could
    /// cost somebody the only line they can act on.
    ///
    /// The corner SILENCES prose once a stream has proved structured, because
    /// a glance showing stray output beside events reads as noise. A run that
    /// emitted events and then failed says why in exactly that prose, so a
    /// transcript keeps it. `prose-silenced-after-event` is the same input
    /// asserted the other way one test up, which is what makes this one
    /// discriminate rather than agree with itself.
    func testProseAfterAnEventShouldSurviveIntoATranscript() throws {
        let c = try XCTUnwrap(try loadCases().first { $0.name == "prose-silenced-after-event" })
        XCTAssertEqual(play(c).shown, [ "Read note.md", nil ], "the corner still silences it")
        XCTAssertEqual(AgentProgressReader.transcriptLines(transcript(c)),
                       ["Read note.md", "[2/7] tokens"])
    }

    /// A narration is kept WHOLE, which the captured runs cannot show: every
    /// answer in them is one short line, so the corner's clamped opening and
    /// the harness's own words are the same string and a test over them would
    /// pass either way.
    ///
    /// This is a real answer to `AgentRequest.probePrompt` from Claude Code
    /// 2.1.278, which is two lines with a blank between them. The corner shows
    /// the first; a sheet shows what was said.
    func testANarrationShouldReachATranscriptWholeRatherThanClampedToItsOpening() {
        let spoke = "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":"
            + "[{\"type\":\"text\",\"text\":\"Hello! 👋\\n\\nWhat can I help you with today?\"}]},"
            + "\"session_id\":\"a0d0fa2b-0068-4c92-a5ec-e6432a329485\"}\n"
        XCTAssertEqual(AgentProgressReader.transcriptLines(spoke),
                       ["Hello! 👋\n\nWhat can I help you with today?"])
        // The same event through the corner, which wants one line.
        XCTAssertEqual(AgentProgressReader().read(spoke, stream: .stdout), "Hello! 👋")
    }

    /// A long answer is not cut either. The corner's 72 characters are what
    /// fits beside a document; a scrollable sheet has no such bound, and an
    /// answer ending in `…` is one the reader has to go and run again to see.
    func testALongAnswerShouldNotBeClampedIntoATranscript() {
        let long = String(repeating: "word ", count: 40).trimmingCharacters(in: .whitespaces)
        let spoke = "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":"
            + "[{\"type\":\"text\",\"text\":\"\(long)\"}]},\"session_id\":\"s\"}\n"
        XCTAssertEqual(AgentProgressReader.transcriptLines(spoke), [long])
        XCTAssertGreaterThan(long.utf16.count, AgentProgressReader.lineMax,
                             "the fixture is too short to tell a clamp from none")
    }

    /// Nil, not an empty list and not a reconstruction: a caller holding a
    /// plain transcript has to show the bytes the child printed.
    func testATranscriptWithNoEventsInItShouldNotBeReduced() {
        XCTAssertNil(AgentProgressReader.transcriptLines("Hello!\nAnything else?\n"))
        XCTAssertNil(AgentProgressReader.transcriptLines(""))
        XCTAssertNil(AgentProgressReader.transcriptLines(
            "{\"level\":\"debug\",\"msg\":\"cache warm\"}\nready\n"),
                     "JSON in a shape no reader knows is prose, not an event")
    }

    /// A structured run whose every event says nothing reduces to no lines at
    /// all. The caller has to be able to tell that from a plain transcript,
    /// because showing an empty box is the one outcome worse than showing the
    /// events.
    func testAStructuredTranscriptThatSaidNothingShouldReduceToNoLines() {
        let session = "\"session_id\":\"s\""
        let events = "{\"type\":\"system\",\"subtype\":\"init\",\(session)}\n"
            + "{\"type\":\"result\",\"subtype\":\"success\",\(session)}\n"
        XCTAssertEqual(AgentProgressReader.transcriptLines(events), [])
    }
}

/// The one-line-per-window rule `askAgent.ts`'s `sendProgress` keeps, as a
/// decision with no clock in it.
final class AgentProgressThrottleTests: XCTestCase {
    func testTheFirstLineOfARunShouldBeSentAtOnce() {
        var throttle = AgentProgressThrottle()
        XCTAssertEqual(throttle.offer("Thinking"), "Thinking")
    }

    func testTheSameLineAgainShouldNotBeSent() {
        var throttle = AgentProgressThrottle()
        _ = throttle.offer("Thinking")
        XCTAssertNil(throttle.windowClosed())
        XCTAssertNil(throttle.offer("Thinking"))
    }

    func testLinesInsideAWindowShouldLeaveOnlyTheNewestForItsEnd() {
        var throttle = AgentProgressThrottle()
        _ = throttle.offer("a")
        XCTAssertNil(throttle.offer("b"))
        XCTAssertNil(throttle.offer("c"))
        XCTAssertEqual(throttle.windowClosed(), "c")
        XCTAssertNil(throttle.windowClosed())
    }

    func testReturningToTheSentLineInsideAWindowShouldEndOnIt() {
        // A then B then A: the run has moved back past B, so nothing new is
        // sent at the window's end and the corner still says A.
        var throttle = AgentProgressThrottle()
        _ = throttle.offer("a")
        XCTAssertNil(throttle.offer("b"))
        XCTAssertNil(throttle.offer("a"))
        XCTAssertNil(throttle.windowClosed())
        XCTAssertEqual(throttle.offer("b"), "b")
    }

    func testAQueuedLineSentAtAWindowsEndShouldOpenANewWindow() {
        var throttle = AgentProgressThrottle()
        _ = throttle.offer("a")
        _ = throttle.offer("b")
        XCTAssertEqual(throttle.windowClosed(), "b")
        XCTAssertNil(throttle.offer("c"))
        XCTAssertEqual(throttle.windowClosed(), "c")
    }
}
