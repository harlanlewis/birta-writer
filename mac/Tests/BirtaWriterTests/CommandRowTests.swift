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

    func testTheRowShouldBeOnTheAdvancedPane() {
        let controller = makeController()
        controller.selectTabForTesting("advanced")
        XCTAssertNotNil(controller.rowForTesting(.commandLine),
                        "the terminal command row was not drawn")
        XCTAssertNotNil(controller.rowForTesting(.commandName),
                        "the command name row was not drawn")
    }

    /// The name row is drawn only while the command is installed, which is
    /// what the switch above it reports. Both arms, because a row that is
    /// always hidden would satisfy the first on its own.
    func testTheNameRowShouldFollowTheSwitchAboveIt() {
        let controller = makeController()
        defer { controller.window?.close() }
        controller.selectTabForTesting("advanced")
        guard let row = controller.rowForTesting(.commandName) else {
            return XCTFail("the command name row was not drawn")
        }
        controller.showCommandNameForTesting(installed: false)
        XCTAssertTrue(row.isHidden, "the name row was drawn with no command installed")
        controller.showCommandNameForTesting(installed: true)
        XCTAssertFalse(row.isHidden, "the name row stayed away with the command installed")
    }

    /// The sentence under the field says what the switch does and where, and
    /// names the directory: a person deciding whether to press it is deciding
    /// about a file in a directory of theirs.
    func testTheHelpSentenceShouldSayWhatIsAddedAndWhere() {
        let link = self.link
        let help = SettingsWindowController.commandHelp(name: "bwr", link: link)
        XCTAssertTrue(help.contains("bwr"), help)
        XCTAssertTrue(help.contains(link.deletingLastPathComponent().lastPathComponent), help)
    }

    /// One sentence whatever the command's standing is: the row it sits under
    /// is drawn only while the command is installed, so a second wording for
    /// the other state would be a wording nobody can reach. The switch row is
    /// what reports a problem, and `testARefusalShouldReplaceWhateverElse`
    /// below is where that is asked.
    func testTheSwitchRowShouldSayNothingWhenNothingIsWrong() {
        let controller = makeController()
        let link = self.link
        let onPath = "/usr/bin:/bin:" + link.deletingLastPathComponent().path
        for installed in [false, true] {
            let availability = controller.commandAvailability(name: "bwr", link: link,
                                                              installed: installed, path: onPath)
            XCTAssertEqual(availability.note, "", "installed: \(installed)")
        }
    }

    /// The pairing this row exists for: the link is there and the name still
    /// does nothing, because the directory it is in is on nobody's `PATH`. A
    /// row that reported only the link would call this ready.
    func testALinkInADirectoryOffPathShouldBeReportedAsAProblem() {
        let controller = makeController()
        // The PATH is handed in, so the row is asked about a shell whose PATH
        // provably lacks the link's directory rather than about whatever this
        // test process happened to inherit, which may be nothing at all.
        let availability = controller.commandAvailability(name: "bwr", link: link, installed: true,
                                                          path: "/usr/bin:/bin")
        XCTAssertTrue(availability.isProblem, availability.note)
        XCTAssertTrue(availability.note.contains("PATH"), availability.note)
    }

    /// The other answer of the same rule, so the test above is not satisfied
    /// by a row that calls every link a problem.
    func testALinkInADirectoryOnPathShouldNotBeReportedAsAProblem() {
        let controller = makeController()
        // Read once: `link` is a fresh directory on every access, so reading
        // it twice asks about two different directories.
        let link = self.link
        let onPath = "/usr/bin:/bin:" + link.deletingLastPathComponent().path
        let availability = controller.commandAvailability(name: "bwr", link: link, installed: true,
                                                          path: onPath)
        XCTAssertFalse(availability.isProblem, availability.note)
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
        let help = SettingsWindowController.commandHelp(name: "notes", link: link)
        XCTAssertTrue(help.contains("notes"), help)
        XCTAssertFalse(help.contains("bwr"), help)
    }

    /// The sentence follows the FIELD rather than the stored name, because
    /// the name is committed when the edit finishes: a sentence reading the
    /// preference would name the old command for the whole of an edit.
    func testAnEmptyFieldShouldBeReadAsTheDefaultName() {
        let field = NSTextField(string: "  ")
        XCTAssertEqual(SettingsWindowController.typedName(in: field), Prefs.defaultCommandName)
        field.stringValue = " notes "
        XCTAssertEqual(SettingsWindowController.typedName(in: field), "notes")
    }
}
