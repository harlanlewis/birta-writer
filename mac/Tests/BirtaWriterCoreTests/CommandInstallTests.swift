import XCTest
@testable import BirtaWriterCore

/// Putting the command on `PATH` and taking it off again.
///
/// The decisions are asked of values; the three that touch the filesystem are
/// driven against a temporary directory, never against the real
/// `~/.local/bin`, which belongs to whoever is running this.
final class CommandInstallTests: XCTestCase {
    private var work: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        work = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("command-install-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: work)
        try super.tearDownWithError()
    }

    /// A bundle shaped the way `build-app.sh` builds one, with the command
    /// where it puts it.
    private func bundle(named name: String) throws -> URL {
        let app = work.appendingPathComponent("\(name).app")
        let macOS = app.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
        let command = macOS.appendingPathComponent(CommandInstall.executableName)
        FileManager.default.createFile(atPath: command.path, contents: Data())
        return command
    }

    // MARK: the two builds

    /// One name for both flavours would mean whichever was installed second
    /// silently took the other's, and the two bundles are meant to sit in
    /// /Applications together.
    func testTheTwoFlavoursShouldOfferDifferentNames() {
        XCTAssertNotEqual(CommandInstall.defaultName(isDevelopmentBuild: false),
                          CommandInstall.defaultName(isDevelopmentBuild: true))
        XCTAssertEqual(CommandInstall.defaultName(isDevelopmentBuild: false), "bwr")
    }

    // MARK: recognising our own

    func testALinkIntoABundlesMacOSDirectoryShouldBeOurs() {
        XCTAssertTrue(CommandInstall.isOurs(destination: URL(
            fileURLWithPath: "/Applications/Birta Writer.app/Contents/MacOS/bwr")))
        // A second copy of the app, which is still ours and still replaceable.
        XCTAssertTrue(CommandInstall.isOurs(destination: URL(
            fileURLWithPath: "/Users/someone/Builds/Birta Writer [DEV].app/Contents/MacOS/bwr")))
    }

    /// Each arm breaks exactly one of the three things the shape rests on, so
    /// a predicate that stopped checking any one of them fails here.
    func testAnythingElseShouldNotBeOurs() {
        for path in [
            "/usr/local/bin/bwr",                                   // no bundle at all
            "/Applications/Other.tool/Contents/MacOS/bwr",          // not a bundle directory
            "/Applications/Birta Writer.app/Contents/Resources/bwr", // not MacOS
            "/Applications/Birta Writer.app/Contents/MacOS/BirtaWriter", // the app, not the command
        ] {
            XCTAssertFalse(CommandInstall.isOurs(destination: URL(fileURLWithPath: path)), path)
        }
    }

    // MARK: the plan

    func testNothingThereShouldInstall() {
        let target = URL(fileURLWithPath: "/Applications/Birta Writer.app/Contents/MacOS/bwr")
        XCTAssertEqual(CommandInstall.plan(existing: .nothing, target: target), .install)
    }

    func testOurOwnLinkPointingHereShouldAlreadyBeInstalled() {
        let target = URL(fileURLWithPath: "/Applications/Birta Writer.app/Contents/MacOS/bwr")
        XCTAssertEqual(CommandInstall.plan(existing: .ours(target), target: target),
                       .alreadyInstalled)
    }

    /// An app that moved, or a second copy that was installed from. Ours, so
    /// it is repaired rather than reported.
    func testOurOwnLinkPointingAtAnotherCopyShouldBeRelinked() {
        let target = URL(fileURLWithPath: "/Applications/Birta Writer.app/Contents/MacOS/bwr")
        let elsewhere = URL(fileURLWithPath: "/Volumes/Old/Birta Writer.app/Contents/MacOS/bwr")
        XCTAssertEqual(CommandInstall.plan(existing: .ours(elsewhere), target: target), .relink)
    }

    /// The rule the whole thing rests on: a command directory is somebody's
    /// own, and a name that collided is never reason to replace what is there.
    func testSomebodyElsesNameShouldBeRefusedRatherThanReplaced() {
        let target = URL(fileURLWithPath: "/Applications/Birta Writer.app/Contents/MacOS/bwr")
        let foreign = URL(fileURLWithPath: "/opt/homebrew/bin/bw")
        guard case .refuse = CommandInstall.plan(existing: .foreignLink(foreign), target: target)
        else { return XCTFail("a foreign link was not refused") }
        guard case .refuse = CommandInstall.plan(existing: .foreignFile, target: target)
        else { return XCTFail("a foreign file was not refused") }
    }

    func testRemovalShouldTakeOnlyOurOwnLink() {
        let ours = URL(fileURLWithPath: "/Applications/Birta Writer.app/Contents/MacOS/bwr")
        XCTAssertEqual(CommandInstall.removal(existing: .ours(ours)), .remove)
        XCTAssertEqual(CommandInstall.removal(existing: .nothing), .nothing)
        guard case .refuse = CommandInstall.removal(existing: .foreignFile)
        else { return XCTFail("a foreign file was not refused") }
    }

    // MARK: where the name would be found

    func testADirectoryOnPathWithNothingEarlierShouldBeReachable() {
        XCTAssertEqual(
            CommandInstall.standing(name: "bwr", directory: "/Users/me/.local/bin",
                                    path: "/usr/bin:/Users/me/.local/bin:/sbin",
                                    isExecutable: { _ in false }),
            .reachable)
    }

    /// A link that exists and a name that does nothing, which is the failure a
    /// row reporting only the link would be silent about.
    func testADirectoryNotOnPathShouldSaySo() {
        XCTAssertEqual(
            CommandInstall.standing(name: "bwr", directory: "/Users/me/.local/bin",
                                    path: "/usr/bin:/bin",
                                    isExecutable: { _ in false }),
            .notOnPath)
    }

    func testSomethingEarlierOnPathShouldBeNamed() {
        XCTAssertEqual(
            CommandInstall.standing(name: "bwr", directory: "/Users/me/.local/bin",
                                    path: "/opt/homebrew/bin:/Users/me/.local/bin",
                                    isExecutable: { $0 == "/opt/homebrew/bin/bwr" }),
            .shadowed("/opt/homebrew/bin/bwr"))
    }

    /// An entry AFTER ours is one the installed command shadows rather than
    /// one that shadows it, which is not news and must not be reported as a
    /// problem.
    func testSomethingLaterOnPathShouldNotBeReported() {
        XCTAssertEqual(
            CommandInstall.standing(name: "bwr", directory: "/Users/me/.local/bin",
                                    path: "/Users/me/.local/bin:/opt/homebrew/bin",
                                    isExecutable: { $0 == "/opt/homebrew/bin/bwr" }),
            .reachable)
    }

    /// A hand-edited `PATH` carries trailing slashes and tildes, and neither
    /// changes the directory meant.
    func testAPathEntrySpelledDifferentlyShouldStillBeOurs() {
        XCTAssertEqual(
            CommandInstall.standing(name: "bwr",
                                    directory: NSString(string: "~/.local/bin").expandingTildeInPath,
                                    path: "/usr/bin:~/.local/bin/",
                                    isExecutable: { _ in false }),
            .reachable)
    }

    func testOnlyAProblemShouldHaveSomethingToSay() {
        XCTAssertTrue(CommandInstall.Standing.reachable.note(name: "bwr", directory: "~/.local/bin").isEmpty)
        XCTAssertFalse(CommandInstall.Standing.reachable.isProblem)
        for standing in [CommandInstall.Standing.notOnPath, .shadowed("/opt/homebrew/bin/bwr")] {
            XCTAssertTrue(standing.isProblem)
            let note = standing.note(name: "bwr", directory: "~/.local/bin")
            XCTAssertTrue(note.contains("bwr"), note)
        }
    }

    // MARK: the filesystem

    func testAnInstallShouldCreateTheDirectoryAndTheLink() throws {
        let target = try bundle(named: "Birta Writer")
        let link = work.appendingPathComponent("bin/bwr")
        XCTAssertNil(CommandInstall.install(link: link, target: target))
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: link.path),
                       target.path)
        XCTAssertEqual(CommandInstall.inspect(link: link), .ours(target.standardizedFileURL))
    }

    /// The gesture somebody makes after moving the app, and the one an install
    /// from a second copy makes.
    func testAnInstallOverOurOwnStaleLinkShouldRepairIt() throws {
        let old = try bundle(named: "Birta Writer Old")
        let target = try bundle(named: "Birta Writer")
        let link = work.appendingPathComponent("bin/bwr")
        XCTAssertNil(CommandInstall.install(link: link, target: old))
        XCTAssertNil(CommandInstall.install(link: link, target: target))
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: link.path),
                       target.path)
    }

    /// The bytes have to still be there afterwards, not only the refusal: this
    /// is somebody's own file in their own command directory.
    func testAForeignFileShouldBeLeftExactlyWhereItIs() throws {
        let target = try bundle(named: "Birta Writer")
        let link = work.appendingPathComponent("bin/bwr")
        try FileManager.default.createDirectory(at: link.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data("someone else's".utf8).write(to: link)
        XCTAssertNotNil(CommandInstall.install(link: link, target: target))
        XCTAssertEqual(try Data(contentsOf: link), Data("someone else's".utf8))
        XCTAssertNotNil(CommandInstall.uninstall(link: link))
        XCTAssertEqual(try Data(contentsOf: link), Data("someone else's".utf8))
    }

    /// A link into somebody else's program, which is the collision the name is
    /// chosen to avoid and still has to be survivable.
    func testAForeignLinkShouldBeLeftAlone() throws {
        let target = try bundle(named: "Birta Writer")
        let other = work.appendingPathComponent("their-tool")
        FileManager.default.createFile(atPath: other.path, contents: Data())
        let link = work.appendingPathComponent("bin/bwr")
        try FileManager.default.createDirectory(at: link.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: other)
        XCTAssertNotNil(CommandInstall.install(link: link, target: target))
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: link.path),
                       other.path)
    }

    func testARemovalShouldTakeTheLinkAndLeaveTheApp() throws {
        let target = try bundle(named: "Birta Writer")
        let link = work.appendingPathComponent("bin/bwr")
        XCTAssertNil(CommandInstall.install(link: link, target: target))
        XCTAssertNil(CommandInstall.uninstall(link: link))
        XCTAssertEqual(CommandInstall.inspect(link: link), .nothing)
        XCTAssertTrue(FileManager.default.fileExists(atPath: target.path))
    }

    /// A link to a command that is not in the bundle is a name on `PATH` that
    /// fails when it is run, which is worse than a row that refused. Nothing
    /// may be left behind either.
    func testALinkToACommandThatIsNotThereShouldBeRefused() {
        let target = work.appendingPathComponent("Nothing.app/Contents/MacOS/bwr")
        let link = work.appendingPathComponent("bin/bwr")
        XCTAssertNotNil(CommandInstall.install(link: link, target: target))
        XCTAssertEqual(CommandInstall.inspect(link: link), .nothing)
    }

    /// Unchecking a box over a command that is already gone is not an error.
    func testARemovalWithNothingThereShouldSayNothing() {
        XCTAssertNil(CommandInstall.uninstall(link: work.appendingPathComponent("bin/bwr")))
    }

    /// A link into an app that has been deleted is exactly the one an install
    /// is being asked to repair, so it must still read as ours.
    func testALinkIntoADeletedAppShouldStillBeOurs() throws {
        let target = try bundle(named: "Birta Writer")
        let link = work.appendingPathComponent("bin/bwr")
        XCTAssertNil(CommandInstall.install(link: link, target: target))
        try FileManager.default.removeItem(at: target.deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent())
        XCTAssertEqual(CommandInstall.inspect(link: link), .ours(target.standardizedFileURL))
    }

    /// The default directory is under the home it is given rather than under
    /// the one the process happens to have, which is what keeps this test off
    /// the real one.
    func testTheDefaultDirectoryShouldSitUnderTheHomeItIsGiven() {
        let home = URL(fileURLWithPath: "/Users/someone")
        XCTAssertEqual(CommandInstall.defaultDirectory(home: home).path,
                       "/Users/someone/.local/bin")
    }
}
