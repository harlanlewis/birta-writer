import AppKit
import BirtaWriterCore
import XCTest
@testable import BirtaWriter

/// The Settings row that installs the terminal command.
///
/// Nothing here writes into the command directory belonging to whoever is
/// running it: the row is asked what it would SAY about a link of the test's
/// own choosing, and the filesystem half is `CommandInstallTests`'s, against a
/// temporary directory. What is pinned here is the pairing the row exists for,
/// which is that a link on disk and a command a shell can run are two
/// different claims and the row makes both.
@MainActor
final class CommandRowTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    private func makeController() -> SettingsWindowController {
        SettingsWindowController(flavour: .release, onHotkeyChange: { 0 }, onChange: { _ in },
                                 onChangeEverywhere: {}, onShowWelcome: {},
                                 onCheckForUpdates: {})
    }

    /// Somewhere that is certainly not on anybody's `PATH`, so the installed
    /// arms below read the same on every machine.
    private var link: URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("command-row-\(UUID().uuidString)/bin/bwr")
    }

    func testTheRowShouldBeOnTheGeneralPane() {
        let controller = makeController()
        controller.selectTabForTesting("general")
        XCTAssertNotNil(controller.rowForTesting(.commandLine),
                        "the terminal command row was not drawn")
    }

    /// Before it is installed the row says what the click would do, and where.
    /// A person deciding whether to press it is deciding about a file in a
    /// directory of theirs, so the directory is named.
    func testWithNothingInstalledTheRowShouldSayWhatWouldBeAdded() {
        let controller = makeController()
        let link = self.link
        let availability = controller.commandAvailability(name: "bwr", link: link, installed: false)
        XCTAssertFalse(availability.isProblem)
        XCTAssertTrue(availability.note.contains("bwr"), availability.note)
        XCTAssertTrue(availability.note.contains(link.deletingLastPathComponent().lastPathComponent),
                      availability.note)
    }

    /// The pairing this row exists for: the link is there and the name still
    /// does nothing, because the directory it is in is on nobody's `PATH`. A
    /// row that reported only the link would call this ready.
    func testALinkInADirectoryOffPathShouldBeReportedAsAProblem() {
        let controller = makeController()
        let availability = controller.commandAvailability(name: "bwr", link: link, installed: true)
        XCTAssertTrue(availability.isProblem, availability.note)
        XCTAssertTrue(availability.note.contains("PATH"), availability.note)
    }

    /// A refusal replaces the standing, whatever the standing was. Telling
    /// somebody their command is ready when the click that was meant to
    /// install it was turned away is the one thing the row must not do.
    func testARefusalShouldReplaceWhateverElseTheRowWouldSay() {
        let controller = makeController()
        controller.commandRefusal = "A file of that name is already there."
        let availability = controller.commandAvailability(name: "bwr", link: link, installed: false)
        XCTAssertTrue(availability.isProblem)
        XCTAssertEqual(availability.note, "A file of that name is already there.")
    }

    /// The name is the row's, so a renamed command is the one the sentence
    /// talks about rather than the default it no longer is.
    func testTheSentenceShouldNameTheCommandTheRowIsAbout() {
        let controller = makeController()
        let availability = controller.commandAvailability(name: "notes", link: link, installed: false)
        XCTAssertTrue(availability.note.contains("notes"), availability.note)
        XCTAssertFalse(availability.note.contains("bwr"), availability.note)
    }
}
