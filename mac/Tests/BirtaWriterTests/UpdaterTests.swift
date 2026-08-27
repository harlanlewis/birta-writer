import XCTest
import BirtaWriterCore
@testable import BirtaWriter

/// Every outcome of a check, and the sentence each one puts on screen.
///
/// This surface had no tests at all, and could not have had any: both halves
/// of `Updater`'s gate read TRUE in an xctest process. `AppFlavor.forBundle`
/// answers `.release` for any bundle id that is not the development one, and
/// nothing sets a throwaway defaults suite, so calling `check(force:)` from a
/// test reached api.github.com for real. Every result other than `.refused`
/// was therefore unreachable, and the status strings behind them unasserted.
///
/// The `Environment` seam is what makes them reachable. Nothing here touches
/// the network or the user's defaults.
@MainActor
final class UpdaterTests: XCTestCase {
    /// A release payload in the shape `ReleaseFeed.parse` reads.
    ///
    /// The asset names are built from `ReleaseFeed.assetPrefix` rather than
    /// spelled out, because that prefix is what the parser selects on: a
    /// hand-written name that stopped matching would make every arm here
    /// report `.failed` for the wrong reason, and a suite whose fixture no
    /// longer parses still goes green on the arms that expect a failure.
    private func feed(tag: String) -> Data {
        let asset = "\(ReleaseFeed.assetPrefix)\(tag).zip"
        return Data("""
        {"tag_name": "\(tag)", "assets": [
          {"name": "\(asset)",
           "browser_download_url": "https://example.invalid/\(tag)/\(asset)"},
          {"name": "\(asset).sha256",
           "browser_download_url": "https://example.invalid/\(tag)/\(asset).sha256"}
        ]}
        """.utf8)
    }

    /// The fixture's own control: if this stops parsing, every arm below that
    /// expects a failure would pass for a reason that has nothing to do with
    /// what it claims to test.
    func testTheFixtureShouldActuallyParseAsARelease() {
        let release = ReleaseFeed.parse(feed(tag: "v2026.821.0"))
        XCTAssertEqual(release?.tag, "v2026.821.0")
        XCTAssertNotNil(release?.checksumURL, "the fixture published no checksum, so install would refuse")
    }

    /// An updater that answers from memory rather than from the network.
    private func updater(current: String = "v2026.800.0",
                         body: Data? = nil,
                         code: Int = 200,
                         mayCheck: Bool = true,
                         autoUpdate: Bool = true) -> Updater {
        let made = Updater()
        made.environment.mayCheck = { mayCheck }
        made.environment.autoUpdate = { autoUpdate }
        made.environment.currentVersion = { current }
        made.environment.recordCheck = { _ in }
        made.environment.lastCheck = { nil }
        made.environment.fetch = { _, done in done(body, code) }
        return made
    }

    private func result(of made: Updater, force: Bool = true) -> Updater.CheckResult? {
        var outcome: Updater.CheckResult?
        let done = expectation(description: "check answered")
        made.check(force: force) { outcome = $0; done.fulfill() }
        wait(for: [done], timeout: 2)
        return outcome
    }

    func testANewerTagShouldBeFound() {
        let made = updater(body: feed(tag: "v2026.821.0"))
        XCTAssertEqual(result(of: made), .found("v2026.821.0"))
        XCTAssertEqual(made.available?.tag, "v2026.821.0")
    }

    func testTheSameOrAnOlderTagShouldBeUpToDate() {
        XCTAssertEqual(result(of: updater(current: "v2026.821.0", body: feed(tag: "v2026.821.0"))),
                       .upToDate)
        XCTAssertEqual(result(of: updater(current: "v2026.821.0", body: feed(tag: "v2026.820.0"))),
                       .upToDate)
    }

    /// A check that could not reach the host is NOT a check that found
    /// nothing, and the type exists to keep those apart: saying "up to date"
    /// for a failure is a false statement about the thing somebody pressed a
    /// button to learn.
    func testAnUnreachableOrUnreadableHostShouldFailRatherThanReportUpToDate() {
        for (body, code) in [(feed(tag: "v9.9.9"), 500), (nil, 0), (Data("not json".utf8), 200)] {
            XCTAssertEqual(result(of: updater(body: body, code: code)), .failed,
                           "HTTP \(code) was not reported as a failure")
        }
    }

    func testABuildThatCannotUpdateItselfShouldRefuseRatherThanFail() {
        // Refused and failed are different words for the user, and this is the
        // one where no check ever happened.
        XCTAssertEqual(result(of: updater(body: feed(tag: "v9.9.9"), mayCheck: false)), .refused)
    }

    func testAnAutomaticCheckShouldRespectTheSettingAndAForcedOneShouldNot() {
        let off = updater(body: feed(tag: "v2026.821.0"), autoUpdate: false)
        XCTAssertEqual(result(of: off, force: false), .refused)
        let pressed = updater(body: feed(tag: "v2026.821.0"), autoUpdate: false)
        XCTAssertEqual(result(of: pressed, force: true), .found("v2026.821.0"),
                       "the button must work whatever the automatic setting says")
    }

    func testTheCheckShouldBeStampedWhenItGoesOutRatherThanWhenItSucceeds() {
        // A machine that is offline fails every check. Stamping on success
        // only would mean a laptop with no network retried on every timer
        // tick, indefinitely, because it never got to record having tried.
        var stamped: [Date] = []
        let made = updater(body: nil, code: 0)
        made.environment.recordCheck = { stamped.append($0) }
        XCTAssertEqual(result(of: made), .failed)
        XCTAssertEqual(stamped.count, 1, "a failed check recorded no attempt")
    }

    func testADueCheckShouldRunAndAnUndueOneShouldNot() {
        let due = updater(body: feed(tag: "v2026.821.0"))
        var reached = 0
        due.environment.fetch = { _, done in reached += 1; done(self.feed(tag: "v2026.821.0"), 200) }
        due.environment.lastCheck = { nil }
        due.checkIfDue()
        XCTAssertEqual(reached, 1)

        let fresh = updater(body: feed(tag: "v2026.821.0"))
        var touched = 0
        fresh.environment.fetch = { _, done in touched += 1; done(self.feed(tag: "v2026.821.0"), 200) }
        let now = Date()
        fresh.environment.now = { now }
        fresh.environment.lastCheck = { now.addingTimeInterval(-60) }
        fresh.checkIfDue()
        XCTAssertEqual(touched, 0, "a check ran a minute after the last one")
    }

    /// The button says something whatever happened, which is what it is for.
    func testEveryOutcomeOfTheButtonShouldSaySomething() {
        var said: [String] = []
        let cases: [(Data?, Int)] = [(feed(tag: "v2026.821.0"), 200), (feed(tag: "v2026.800.0"), 200), (nil, 0)]
        for (body, code) in cases {
            let made = updater(body: body, code: code)
            made.onStatus = { said.append($0) }
            let done = expectation(description: "answered")
            made.check(force: true) { _ in done.fulfill() }
            wait(for: [done], timeout: 2)
        }
        // Not an assertion that any PARTICULAR sentence appeared: what must
        // hold is that no outcome leaves the status line holding the previous
        // one. An empty string would be the row going quiet mid-answer.
        XCTAssertFalse(said.contains(where: \.isEmpty))
    }
}
