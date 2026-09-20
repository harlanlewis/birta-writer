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

    /// The drawing follows the answer it is given. Both arms, because a row
    /// that is always hidden would satisfy the first on its own; which answer
    /// it is given is `showsCommandName`, asked below.
    func testTheNameRowShouldFollowTheSwitchAboveIt() {
        let controller = makeController()
        defer { controller.window?.close() }
        controller.selectTabForTesting("advanced")
        guard let row = controller.rowForTesting(.commandName) else {
            return XCTFail("the command name row was not drawn")
        }
        controller.showCommandNameForTesting(shown: false)
        XCTAssertTrue(row.isHidden, "the name row was drawn with no command installed")
        controller.showCommandNameForTesting(shown: true)
        XCTAssertFalse(row.isHidden, "the name row stayed away with the command installed")
    }

    /// A refusal keeps the field, and this is the dead end it exists to stop.
    ///
    /// A refusal is usually ABOUT the name (something else already answers to
    /// it) and leaves nothing installed. Going by the link alone would take
    /// the field away at exactly that moment, so the stored name would be
    /// stuck at the one that cannot be installed and every retry would be
    /// refused for the same reason with nothing to edit.
    func testARefusalShouldKeepTheNameRowEvenThoughNothingIsInstalled() {
        let controller = makeController()
        defer { controller.window?.close() }
        controller.selectTabForTesting("advanced")
        guard let row = controller.rowForTesting(.commandName) else {
            return XCTFail("the command name row was not drawn")
        }
        // The rule, both arms, asked of the predicate rather than of the disk:
        // whoever is running this may have the command installed, and reading
        // the real directory would answer about their machine.
        XCTAssertFalse(SettingsWindowController.showsCommandName(installed: false, refusal: nil),
                       "the row is drawn with nothing installed and nothing refused")
        XCTAssertTrue(SettingsWindowController.showsCommandName(
            installed: false, refusal: "A file of that name is already there."),
                      "a refusal takes away the field that answers it")
        XCTAssertTrue(SettingsWindowController.showsCommandName(installed: true, refusal: nil))

        // And the drawing follows the answer, so the rule above reaches a row.
        controller.showCommandNameForTesting(
            shown: SettingsWindowController.showsCommandName(
                installed: false, refusal: "A file of that name is already there."))

        XCTAssertFalse(row.isHidden, "a refusal took away the field that answers it")
    }

    /// The sentence the drawn row actually carries, and that it follows the
    /// field as it is typed in.
    ///
    /// `commandHelp` is a pure function and is asked directly below, which
    /// says nothing about whether anything calls it: the name is committed
    /// only when the edit finishes, so a caption wired to the stored
    /// preference would pass every check there is and still name the old
    /// command for the whole of an edit.
    func testTheSentenceUnderTheFieldShouldFollowWhatIsTyped() {
        let controller = makeController()
        defer { controller.window?.close() }
        controller.selectTabForTesting("advanced")
        guard let content = controller.window?.contentView,
              let row = controller.rowForTesting(.commandName),
              let field = monospacedField(in: content) else {
            return XCTFail("the command name row was not drawn")
        }

        field.stringValue = "notes"
        controller.controlTextDidChange(
            Notification(name: NSControl.textDidChangeNotification, object: field))

        XCTAssertEqual(row.caption?.stringValue,
                       SettingsWindowController.commandHelp(name: "notes", link: Prefs.commandLink),
                       "the row's sentence did not follow the field")
        // Nothing was written: the name belongs to the edit's end.
        XCTAssertNotEqual(Prefs.commandName, "notes")
    }

    /// The command field, which is the one monospaced editable field on the
    /// Advanced pane.
    private func monospacedField(in view: NSView) -> NSTextField? {
        if let found = view as? NSTextField, found.isEditable,
           found.font?.fontName.contains("Mono") == true { return found }
        for subview in view.subviews {
            if let found = monospacedField(in: subview) { return found }
        }
        return nil
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

    /// The switch row says nothing when nothing is wrong, whether or not the
    /// command is installed. What installing gets you is the name row's
    /// sentence; this row is for problems, and
    /// `testARefusalShouldReplaceWhateverElse` below is where that is asked.
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
