import XCTest
@testable import BirtaWriter
import BirtaWriterCore

/// That the launch actually SEEDS the shipped themes, and does it between the
/// two lines it has to sit between.
///
/// `DefaultThemesTests` holds what seeding does and `DefaultThemeSurfacesTests`
/// holds what the pane does with it; both stay green with the launch call cut,
/// and a fresh install would then open with an empty theme library and no way
/// to notice. That is the shape AGENTS.md names, a guard that is ABSENT rather
/// than wrong.
///
/// A source-text guard rather than a live one, for the reason
/// `FirstRunWiringTests` gives: reaching the launch path builds a real
/// `WindowSet` and `Coordinator`, and nothing in this suite starts WebKit.
@MainActor
final class ThemeSeedWiringTests: XCTestCase {
    private func source(_ file: String) -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Sources/BirtaWriter/\(file)")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            XCTFail("could not read \(url.path); if \(file) moved, this guard must follow it")
            return ""
        }
        return text
    }

    func testTheLaunchShouldSeedTheShippedThemesIntoTheLibrary() {
        let text = source("App.swift")
        XCTAssertTrue(text.contains("seedDefaultThemes()"),
                      "nothing calls it, so a fresh install has an empty theme library")
        XCTAssertTrue(text.contains("windows.themeStore.seedDefaults("),
                      "the seed no longer goes through the store the app actually reads")
        XCTAssertTrue(text.contains("Prefs.seededDefaultThemes = result.seeded"),
                      "the record is never written, so every launch puts back what was removed")
    }

    /// The two ends it sits between, and both are silent when broken.
    ///
    /// Before it: `Prefs.isFirstLaunch` is the absence of every stored key, so
    /// a seed above that reading makes every launch an existing install, and
    /// the tour and the login item stop happening.
    ///
    /// After it: the first window resolves the appearance against the library,
    /// so a seed below that would leave a slot reading as the system's for as
    /// long as the launch took.
    func testTheSeedShouldSitAfterTheFirstLaunchReadingAndBeforeTheWindows() throws {
        let text = source("App.swift")
        let firstLaunch = try XCTUnwrap(text.range(of: "let firstLaunch = Prefs.isFirstLaunch"))
        let seed = try XCTUnwrap(text.range(of: "\n        seedDefaultThemes()"))
        let windows = try XCTUnwrap(text.range(of: "windows.openAtLaunch("))
        XCTAssertLessThan(firstLaunch.lowerBound, seed.lowerBound,
                          "the seed stores a key above the reading that must find none")
        XCTAssertLessThan(seed.lowerBound, windows.lowerBound,
                          "the first window resolves its appearance before the themes are there")
    }

    /// The bundle has to CARRY the files the seed copies.
    ///
    /// Nothing else can see this. A build script that stopped copying the
    /// folder would leave `DefaultThemes.file` answering nil on every install,
    /// the seed would write nothing and record nothing, and every test in the
    /// package would still pass, because each of them reads the committed
    /// folder rather than a bundle.
    func testTheBuildScriptShouldCopyTheShippedThemesIntoTheBundle() {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("scripts/build-app.sh")
        guard let script = try? String(contentsOf: url, encoding: .utf8) else {
            return XCTFail("could not read \(url.path); if build-app.sh moved, this guard must follow it")
        }
        XCTAssertTrue(script.contains("mac/Resources/\(DefaultThemes.folderName)"),
                      "the assembled bundle carries no theme folder, so no install is ever seeded")
        XCTAssertTrue(script.contains("Contents/Resources/\(DefaultThemes.folderName)"),
                      "the folder is copied somewhere `Bundle.main.resourceURL` does not reach")
    }

    /// The record is not a setting, so a reset leaves it alone. Clearing it
    /// would have the NEXT launch write four theme files into a folder the
    /// reset promised not to touch, and put back defaults somebody removed.
    func testAResetShouldNotClearTheRecordOfWhichShippedThemesWereGiven() {
        let text = source("Preferences.swift")
        XCTAssertTrue(text.contains(".hasSeenWelcome, .lastNotesDirectory, .lastScratchpadFile, .seededDefaultThemes,"),
                      "the seed record is no longer exempt from reset")
    }
}
