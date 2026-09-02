import CryptoKit
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
    ///
    /// Every field that can reach outside this process is stubbed here rather
    /// than per test, and two of them are the point. `download` must be, because
    /// a check that finds something now fetches the archive ON ITS OWN: a test
    /// that left the real one in place would download a release without ever
    /// calling the method that does it. `armSwap` must be, because the real one
    /// spawns a script that waits for this pid and then moves a bundle, so a
    /// test that reached it would replace something after the suite exited. It
    /// fails rather than returning quietly, so nothing can arm by accident and
    /// read as a pass.
    private func updater(current: String = "v2026.800.0",
                         body: Data? = nil,
                         code: Int = 200,
                         mayCheck: Bool = true,
                         autoUpdate: Bool = true,
                         declined: String? = nil) -> Updater {
        let made = Updater()
        made.environment.mayCheck = { mayCheck }
        made.environment.autoUpdate = { autoUpdate }
        made.environment.declined = { declined }
        made.environment.currentVersion = { current }
        made.environment.recordCheck = { _ in }
        made.environment.lastCheck = { nil }
        made.environment.fetch = { _, done in done(body, code) }
        made.environment.download = { _, done in done(nil) }
        made.environment.onMeteredNetwork = { false }
        made.environment.armSwap = { _, _ in
            XCTFail("the real swap script was armed from a test; it waits for this process")
            return false
        }
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

    // MARK: staging, which now happens before anybody is asked

    /// A release the fixtures below describe, with URLs that go nowhere.
    private func release(tag: String = "v2026.821.0") -> ReleaseFeed.Release {
        ReleaseFeed.parse(feed(tag: tag))!
    }

    /// A real archive in the shape the release job publishes: one `.app` at
    /// the root of the zip.
    ///
    /// Built rather than committed, and it has to be real: what the staging
    /// path does with it is unpack it with `ditto` and then ask the filesystem
    /// whether the bundle is there, so a fixture that merely looked like an
    /// archive would exercise none of that.
    private func archive(containing name: String) throws -> Data {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("updater-fixture-\(UUID().uuidString)")
        let bundle = root.appendingPathComponent(name)
        try FileManager.default.createDirectory(
            at: bundle.appendingPathComponent("Contents/MacOS"),
            withIntermediateDirectories: true)
        try Data("stub".utf8).write(to: bundle.appendingPathComponent("Contents/MacOS/stub"))
        let zip = root.appendingPathComponent("out.zip")
        let ditto = Process()
        ditto.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        ditto.arguments = ["-c", "-k", "--keepParent", bundle.path, zip.path]
        try ditto.run()
        ditto.waitUntilExit()
        defer { try? FileManager.default.removeItem(at: root) }
        return try Data(contentsOf: zip)
    }

    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Answer the archive URL with `archive` and the checksum URL with `sum`.
    ///
    /// Keyed on the name rather than on call order: the two requests are made
    /// one after the other today, and a test that encoded that would be
    /// asserting the order rather than the verification.
    private func serve(_ made: Updater, archive: Data?, sum: String?) {
        made.environment.download = { url, done in
            if url.lastPathComponent.hasSuffix(".sha256") {
                done(sum.map { Data($0.utf8) })
            } else {
                done(archive)
            }
        }
    }

    /// Wait for a staging run to answer, however it answers.
    private func stage(_ made: Updater, _ target: ReleaseFeed.Release) -> Updater.Staged? {
        var outcome: Updater.Staged?
        let done = expectation(description: "staged")
        made.stage(target) { outcome = $0; done.fulfill() }
        wait(for: [done], timeout: 10)
        cleanUpAfter(made)
        return outcome
    }

    /// Take an unpacked bundle off the machine whatever state the updater
    /// ended in.
    ///
    /// Not `discardStaged`, which refuses once the swap is armed. That refusal
    /// is right in the app, where the script waiting on the pid is about to
    /// move the thing and then remove its directory, and wrong here, where
    /// that script is a stub and nothing else is ever going to. A suite that
    /// leaves tens of megabytes in the temporary directory per run is the
    /// litter this repo has a reaper for.
    private func cleanUpAfter(_ made: Updater) {
        addTeardownBlock { @MainActor in
            guard let work = made.staged?.work else { return }
            try? FileManager.default.removeItem(at: work)
        }
    }

    func testACheckThatFindsSomethingShouldFetchItWithoutAnybodyBeingAsked() {
        // The whole of what the setting now buys. By the time an offer is
        // answered, or the machine goes quiet, there is nothing left to wait
        // for, and that is only true if the check itself starts the download.
        let made = updater(body: feed(tag: "v2026.821.0"))
        var asked: [URL] = []
        made.environment.download = { url, done in asked.append(url); done(nil) }
        XCTAssertEqual(result(of: made), .found("v2026.821.0"))
        XCTAssertFalse(asked.isEmpty, "the check found a release and fetched nothing")
    }

    /// The automatic download is the one thing here that spends money without
    /// being asked, and a release lands most nights, so a laptop tethered to a
    /// phone would pay for one after another for something nobody requested.
    func testACheckOverAMeteredConnectionShouldFindTheReleaseAndFetchNothing() {
        let made = updater(body: feed(tag: "v2026.821.0"))
        made.environment.onMeteredNetwork = { true }
        var asked = 0
        made.environment.download = { _, done in asked += 1; done(nil) }
        // Still FOUND, so the offer is still raised and Restart still works.
        // Low Data Mode is a preference about background traffic, not a
        // refusal to ever update.
        XCTAssertEqual(result(of: made), .found("v2026.821.0"))
        XCTAssertEqual(asked, 0)
    }

    /// And a person who presses Restart is not held to it. Anything else would
    /// be a button that does nothing, on a machine where the only explanation
    /// is a setting about something else.
    func testConfirmingTheOfferOverAMeteredConnectionShouldStillDownload() throws {
        let made = updater()
        made.environment.onMeteredNetwork = { true }
        let bytes = try archive(containing: "\(AppFlavor.current.displayName).app")
        serve(made, archive: bytes, sum: sha256(bytes))
        made.environment.compatibility = { _ in .compatible }
        var arms = 0
        made.environment.armSwap = { _, _ in arms += 1; return true }
        var armed: Bool?
        let done = expectation(description: "installed")
        made.install(release()) { armed = $0; done.fulfill() }
        wait(for: [done], timeout: 10)
        cleanUpAfter(made)
        XCTAssertEqual(armed, true)
        XCTAssertEqual(arms, 1)
    }

    func testAVersionAlreadyDeclinedShouldNotBeFetched() {
        // A no is an answer about the version, and spending somebody's
        // bandwidth on it is not honouring the answer any more than raising
        // the sheet again would be.
        let made = updater(body: feed(tag: "v2026.821.0"), declined: "v2026.821.0")
        var asked = 0
        made.environment.download = { _, done in asked += 1; done(nil) }
        XCTAssertEqual(result(of: made), .found("v2026.821.0"))
        XCTAssertEqual(asked, 0)
    }

    func testACheckWithAutomaticUpdatesOffShouldFetchNothingEvenWhenForced() {
        // The button is a request to be TOLD, not a request to be updated. A
        // forced check with the setting off still finds and still offers, and
        // still downloads nothing until the offer is confirmed.
        let made = updater(body: feed(tag: "v2026.821.0"), autoUpdate: false)
        var asked = 0
        made.environment.download = { _, done in asked += 1; done(nil) }
        XCTAssertEqual(result(of: made, force: true), .found("v2026.821.0"))
        XCTAssertEqual(asked, 0)
    }

    func testAReleaseThatPublishedNoChecksumShouldStageNothing() {
        let made = updater()
        let unverifiable = ReleaseFeed.Release(
            tag: "v2026.821.0",
            appURL: URL(string: "https://example.invalid/app.zip")!,
            checksumURL: nil)
        XCTAssertNil(stage(made, unverifiable))
        XCTAssertNil(made.staged)
    }

    func testAnArchiveThatDoesNotMatchItsChecksumShouldStageNothing() throws {
        let made = updater()
        let bytes = try archive(containing: "\(AppFlavor.current.displayName).app")
        serve(made, archive: bytes, sum: sha256(Data("something else".utf8)))
        XCTAssertNil(stage(made, release()))
        XCTAssertNil(made.staged)
    }

    /// The control for the arm above: the same archive, verified, does stage.
    ///
    /// Without it a mismatch refusing proves nothing, because a staging path
    /// that refused everything would satisfy that test and this one is the
    /// only thing that can tell the two apart.
    func testAVerifiedArchiveShouldStageTheBundleItCarries() throws {
        let made = updater()
        let bytes = try archive(containing: "\(AppFlavor.current.displayName).app")
        serve(made, archive: bytes, sum: sha256(bytes))
        made.environment.compatibility = { _ in .compatible }
        let staged = try XCTUnwrap(stage(made, release()))
        XCTAssertEqual(staged.tag, "v2026.821.0")
        XCTAssertTrue(FileManager.default.fileExists(atPath: staged.bundle.path),
                      "nothing was unpacked at \(staged.bundle.path)")
        XCTAssertEqual(made.staged, staged)
    }

    func testAnArchiveThisMacCannotRunShouldStageNothing() throws {
        // Asked of the DOWNLOADED bundle, before anything replaces the copy
        // that is running: the swap keeps the old app until the new one is in
        // place, and an update macOS refuses to launch defeats that from
        // outside, because the move succeeds and the refusal comes after.
        let made = updater()
        let bytes = try archive(containing: "\(AppFlavor.current.displayName).app")
        serve(made, archive: bytes, sum: sha256(bytes))
        made.environment.compatibility = { _ in .wrongArchitecture(built: [.arm64], machine: "x86_64") }
        XCTAssertNil(stage(made, release()))
        XCTAssertNil(made.staged)
    }

    func testAnArchiveWithoutTheAppInItShouldStageNothing() throws {
        let made = updater()
        let bytes = try archive(containing: "Something Else.app")
        serve(made, archive: bytes, sum: sha256(bytes))
        made.environment.compatibility = { _ in .compatible }
        XCTAssertNil(stage(made, release()))
        XCTAssertNil(made.staged)
    }

    func testStagingTheSameVersionTwiceShouldNotDownloadItTwice() throws {
        let made = updater()
        let bytes = try archive(containing: "\(AppFlavor.current.displayName).app")
        var fetches = 0
        made.environment.download = { url, done in
            fetches += 1
            done(url.lastPathComponent.hasSuffix(".sha256") ? Data(self.sha256(bytes).utf8) : bytes)
        }
        made.environment.compatibility = { _ in .compatible }
        XCTAssertNotNil(stage(made, release()))
        let after = fetches
        XCTAssertNotNil(stage(made, release()))
        XCTAssertEqual(fetches, after, "the archive already on disk was fetched again")
    }

    func testDecliningShouldTakeTheStagedBytesWithIt() throws {
        let made = updater()
        let bytes = try archive(containing: "\(AppFlavor.current.displayName).app")
        serve(made, archive: bytes, sum: sha256(bytes))
        made.environment.compatibility = { _ in .compatible }
        let staged = try XCTUnwrap(stage(made, release()))
        made.discardStaged()
        XCTAssertNil(made.staged)
        XCTAssertFalse(FileManager.default.fileExists(atPath: staged.work.path),
                       "a declined version left its unpacked bundle behind")
    }

    // MARK: arming, and which way the app comes back

    /// The confirmed offer, end to end: nothing on disk, and one arm at the
    /// end of it.
    func testConfirmingTheOfferShouldStageThenArmExactlyOneSwap() throws {
        let made = updater()
        let bytes = try archive(containing: "\(AppFlavor.current.displayName).app")
        serve(made, archive: bytes, sum: sha256(bytes))
        made.environment.compatibility = { _ in .compatible }
        var arms: [Bool] = []
        made.environment.armSwap = { _, background in arms.append(background); return true }
        var armed: Bool?
        let done = expectation(description: "installed")
        made.install(release()) { armed = $0; done.fulfill() }
        wait(for: [done], timeout: 10)
        cleanUpAfter(made)
        XCTAssertEqual(armed, true)
        XCTAssertEqual(arms, [false], "a confirmed restart must reopen in front of the person")
        // A second arm would be a second script waking on the same pid and
        // racing the first over one destination.
        XCTAssertFalse(made.armStagedSwap(inBackground: true))
        XCTAssertEqual(arms, [false])
    }

    /// The unattended swap reopens WITHOUT taking the front. The person is
    /// somewhere else, and an app that activates itself while nobody asked is
    /// the interruption that path exists not to be.
    func testAnUnattendedSwapShouldReopenInTheBackground() throws {
        let made = updater()
        let bytes = try archive(containing: "\(AppFlavor.current.displayName).app")
        serve(made, archive: bytes, sum: sha256(bytes))
        made.environment.compatibility = { _ in .compatible }
        var arms: [Bool] = []
        made.environment.armSwap = { _, background in arms.append(background); return true }
        XCTAssertNotNil(stage(made, release()))
        XCTAssertTrue(made.armStagedSwap(inBackground: true))
        XCTAssertEqual(arms, [true])
        XCTAssertTrue(made.armed)
    }

    func testArmingWithNothingStagedShouldRefuseRatherThanRunAnything() {
        let made = updater()
        // `armSwap` fails the test if it is reached, so this asserts twice:
        // the answer is no, and nothing was spawned to produce it.
        XCTAssertFalse(made.armStagedSwap(inBackground: true))
        XCTAssertFalse(made.armed)
    }

    // MARK: what a background run says, and to whom

    /// A staging run nobody asked for says nothing on screen.
    ///
    /// It was not requested, and a person who did nothing can do nothing about
    /// "could not download the update"; the status line is for answers to
    /// things they pressed. The same run announces the moment somebody
    /// confirms the offer, which is the other half and is what stops this from
    /// being a rule that simply swallows failures.
    func testABackgroundStagingRunShouldSayNothingAndAConfirmedOneShouldSay() throws {
        let quiet = updater()
        var said: [String] = []
        quiet.onStatus = { said.append($0) }
        serve(quiet, archive: nil, sum: nil)
        XCTAssertNil(stage(quiet, release()))
        XCTAssertEqual(said, [], "a background run reported a failure nobody asked about")

        let asked = updater()
        var toldThem: [String] = []
        asked.onStatus = { toldThem.append($0) }
        serve(asked, archive: nil, sum: nil)
        let done = expectation(description: "install answered")
        asked.install(release()) { _ in done.fulfill() }
        wait(for: [done], timeout: 10)
        XCTAssertFalse(toldThem.isEmpty, "a confirmed restart failed without saying so")
    }

    /// A newer release supersedes a staged one, and takes its bytes with it.
    ///
    /// Both halves of that matter. The app must not arm a version it is no
    /// longer offering, and the superseded bundle must not be left unpacked in
    /// the temporary directory with nothing pointing at it, which is tens of
    /// megabytes per release for as long as the machine stays up.
    func testANewerReleaseShouldReplaceTheStagedOneAndFreeIt() throws {
        let made = updater()
        let bytes = try archive(containing: "\(AppFlavor.current.displayName).app")
        serve(made, archive: bytes, sum: sha256(bytes))
        made.environment.compatibility = { _ in .compatible }
        let first = try XCTUnwrap(stage(made, release(tag: "v2026.821.0")))
        let second = try XCTUnwrap(stage(made, release(tag: "v2026.822.0")))
        XCTAssertEqual(made.staged?.tag, "v2026.822.0")
        XCTAssertNotEqual(first.work, second.work)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.work.path),
                       "the superseded version was left unpacked")
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.bundle.path))
    }

    /// And a run that fails after one succeeded frees the good one too, rather
    /// than leaving a bundle nothing can reach.
    func testAFailedRunAfterAGoodOneShouldNotStrandTheBundleItReplaces() throws {
        let made = updater()
        let bytes = try archive(containing: "\(AppFlavor.current.displayName).app")
        serve(made, archive: bytes, sum: sha256(bytes))
        made.environment.compatibility = { _ in .compatible }
        let good = try XCTUnwrap(stage(made, release(tag: "v2026.821.0")))
        serve(made, archive: nil, sum: nil)
        XCTAssertNil(stage(made, release(tag: "v2026.822.0")))
        XCTAssertNil(made.staged)
        XCTAssertFalse(FileManager.default.fileExists(atPath: good.work.path))
    }

    // MARK: reading the machine

    /// The whole unattended path hangs on this one value resolving, and a nil
    /// here would be invisible: `systemIdleSeconds` would answer zero forever,
    /// no swap would ever go in, and every other test in this file would stay
    /// green. `CGEventType` is a C enum and `init?(rawValue:)` on one answers
    /// nil for a value it does not declare, which is what this value is.
    ///
    /// Asserting the ANSWER cannot stand in for this. Zero is what a machine
    /// somebody is using reports too, so the return value cannot tell a broken
    /// read from a working one.
    func testTheAnyInputEventTypeShouldResolve() {
        XCTAssertNotNil(Updater.anyInputEvent)
    }

    /// And what comes back is a number the policy can compare against.
    func testTheIdleReadShouldAnswerAFiniteNonNegativeNumberOfSeconds() {
        let idle = Updater.systemIdleSeconds()
        XCTAssertTrue(idle.isFinite, "\(idle)")
        XCTAssertGreaterThanOrEqual(idle, 0)
    }
}
