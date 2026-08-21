import XCTest
@testable import BirtaJotCore

/// The `/ai-advanced` attachment path, host side.
///
/// The first three cases mirror `saveAgentAttachment` in
/// `src/__tests__/askAgent.test.ts` one for one, by the rule in
/// `AgentAttachment`'s header: both surfaces hand a path to the same agents, so
/// a change to either has to be made in both.
final class AgentAttachmentTests: XCTestCase {

    // ── The sanitizer ──────────────────────────────────────────

    func testAFileWithinTheCapShouldKeepItsName() {
        XCTAssertEqual(AgentAttachment.safeName("shot.png"), "shot.png")
    }

    func testANameThatWalksOutOfTheDirectoryShouldBeReducedToAFilename() {
        let safe = AgentAttachment.safeName("../../../etc/passwd")

        XCTAssertFalse(safe.contains(".."))
        XCTAssertFalse(safe.contains("/"))
        XCTAssertEqual(safe, "passwd")
    }

    func testAnOversizedAttachmentShouldBeRefused() {
        XCTAssertThrowsError(try AgentAttachment.check(byteCount: 17 * 1024 * 1024)) { error in
            XCTAssertEqual(error as? AgentAttachment.Failure,
                           .tooLarge(bytes: 17 * 1024 * 1024))
        }
    }

    func testAnAttachmentAtExactlyTheCapShouldBeAllowed() {
        XCTAssertNoThrow(try AgentAttachment.check(byteCount: AgentAttachment.maxBytes))
    }

    func testABackslashPathShouldAlsoBeReducedToItsBasename() {
        XCTAssertEqual(AgentAttachment.safeName(#"C:\Users\me\notes.txt"#), "notes.txt")
    }

    func testCharactersOutsideTheSafeAlphabetShouldBecomeUnderscores() {
        XCTAssertEqual(AgentAttachment.safeName("my file (1).png"), "my_file__1_.png")
    }

    func testALeadingDotShouldBeStrippedSoNothingLandsHidden() {
        XCTAssertEqual(AgentAttachment.safeName(".ssh"), "ssh")
        XCTAssertEqual(AgentAttachment.safeName("...."), "file")
    }

    func testANameThatSanitizesToNothingShouldBecomeFile() {
        XCTAssertEqual(AgentAttachment.safeName(""), "file")
        // A trailing separator has an empty basename, matching the
        // TypeScript's `split().pop()`, rather than naming the directory above.
        XCTAssertEqual(AgentAttachment.safeName("some/dir/"), "file")
    }

    func testAVeryLongNameShouldBeTruncatedToItsTail() {
        let safe = AgentAttachment.safeName(String(repeating: "a", count: 200) + ".png")

        XCTAssertEqual(safe.count, 64)
        XCTAssertTrue(safe.hasSuffix(".png"))
    }

    // ── Where it lands ─────────────────────────────────────────

    func testTwoAttachmentsOfOneNameShouldNotCollide() {
        let dir = AgentAttachment.directory(
            temporaryDirectory: URL(fileURLWithPath: "/tmp", isDirectory: true), processID: 42)

        let first = AgentAttachment.destination(in: dir, sequence: 1, name: "shot.png")
        let second = AgentAttachment.destination(in: dir, sequence: 2, name: "shot.png")

        XCTAssertNotEqual(first, second)
        XCTAssertEqual(first.lastPathComponent, "1-shot.png")
        XCTAssertEqual(second.lastPathComponent, "2-shot.png")
    }

    func testTheDirectoryShouldBeKeyedByProcessSoTwoCopiesDoNotShare() {
        let tmp = URL(fileURLWithPath: "/tmp", isDirectory: true)

        XCTAssertNotEqual(AgentAttachment.directory(temporaryDirectory: tmp, processID: 1),
                          AgentAttachment.directory(temporaryDirectory: tmp, processID: 2))
    }

    /// The property the sanitizer exists for, asserted over the whole set of
    /// shapes rather than the three that happen to be interesting: whatever
    /// goes in, what comes out is one path component that cannot climb.
    func testNoNameShouldEverProduceAPathThatEscapesItsDirectory() {
        let hostile = [
            "../../../etc/passwd", "..", ".", "/etc/shadow", #"..\..\windows"#,
            "a/../../b", "", "....", "/", "\\", "con:name", "x\u{0000}y", "-",
        ]

        for raw in hostile {
            let dir = URL(fileURLWithPath: "/tmp/birta-ai-1", isDirectory: true)
            let target = AgentAttachment.destination(in: dir, sequence: 7, name: raw)

            XCTAssertEqual(target.deletingLastPathComponent().standardizedFileURL,
                           dir.standardizedFileURL, "escaped for \(raw)")
            XCTAssertFalse(target.lastPathComponent.contains(".."), "climbed for \(raw)")
            XCTAssertTrue(target.lastPathComponent.hasPrefix("7-"), "lost its number for \(raw)")
        }
        XCTAssertEqual(hostile.count, 13)
    }
}
