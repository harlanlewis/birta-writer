import XCTest
@testable import BirtaWriterCore

/// The command's name inside the bundle is spelled in two programs that
/// cannot see each other: `CommandInstall.executableName` is what Settings
/// links to, and `mac/scripts/build-app.sh` is what puts the binary there.
/// Rename either alone and every Swift test stays green while Settings says
/// the app has no command to link to. So the script is read as text and held
/// to the constant, the way `FirstRunWiringTests` holds `App.swift` to its
/// hops.
final class CommandBundleSpellingTests: XCTestCase {
    func testTheBuildScriptShouldCopyTheCommandUnderTheNameSettingsLinksTo() throws {
        let script = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("scripts/build-app.sh")
        let text = try String(contentsOf: script, encoding: .utf8)
        // The reach assertion first: a script that stopped copying anything
        // would otherwise satisfy an absence check about the wrong name.
        XCTAssertTrue(text.contains("Contents/MacOS/"), "the script no longer places a binary at all")
        XCTAssertTrue(text.contains("Contents/MacOS/\(CommandInstall.executableName)\""),
                      "build-app.sh copies the command under a name Settings does not link to")
    }
}
