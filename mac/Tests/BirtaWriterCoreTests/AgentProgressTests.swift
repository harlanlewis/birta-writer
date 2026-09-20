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
