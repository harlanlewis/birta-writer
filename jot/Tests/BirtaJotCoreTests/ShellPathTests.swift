import XCTest
@testable import BirtaJotCore

/// How Jot reads a `PATH` out of a shell, and what it does with the answer.
///
/// The defect behind all of it: an app launched from the Finder gets
/// `launchd`'s four system directories, every agent CLI is installed somewhere
/// else, and the AI Agent pane's Test button therefore reports a tool somebody
/// uses every day as not installed. The parsing is where that gets subtle,
/// because an rc file is somebody's own program and may print anything at all
/// around the value.
final class ShellPathTests: XCTestCase {
    private func fenced(_ path: String) -> String {
        ShellPath.openMarker + path + ShellPath.closeMarker
    }

    func testAFencedValueShouldBeReadOutOfTheOutput() {
        XCTAssertEqual(ShellPath.path(fromOutput: fenced("/opt/homebrew/bin:/usr/bin")),
                       "/opt/homebrew/bin:/usr/bin")
    }

    /// The reason there are markers at all. A "take the last line" rule breaks
    /// on the greeting, and a "take the first" rule breaks on the prompt.
    func testAnRcFileThatPrintsAroundTheValueShouldNotChangeIt() {
        let noisy = "Welcome to your shell\n"
            + "nvm: version 22\n"
            + fenced("/home/me/bin:/usr/bin")
            + "\nyou have mail\n"
        XCTAssertEqual(ShellPath.path(fromOutput: noisy), "/home/me/bin:/usr/bin")
    }

    func testAShellThatPrintedNoValueShouldReportNothingRatherThanAnEmptyPath() {
        // Nil rather than "", because the caller keeps what it already had for
        // a shell that failed and would throw it away for one that answered.
        XCTAssertNil(ShellPath.path(fromOutput: ""))
        XCTAssertNil(ShellPath.path(fromOutput: "command not found: printf\n"))
        XCTAssertNil(ShellPath.path(fromOutput: fenced("")))
        XCTAssertNil(ShellPath.path(fromOutput: ShellPath.openMarker + "/usr/bin"))
        XCTAssertNil(ShellPath.path(fromOutput: ShellPath.closeMarker + "/usr/bin"))
    }

    /// The markers have to bound the value in the order they are written, or a
    /// value containing the closing marker's own text could be read backwards.
    func testACloseMarkerBeforeTheOpenOneShouldNotBeReadAsAValue() {
        let backwards = ShellPath.closeMarker + "junk" + ShellPath.openMarker + "/usr/bin"
        XCTAssertNil(ShellPath.path(fromOutput: backwards))
    }

    // MARK: the merge

    func testTheChildShouldGetTheShellsOrderingFirstAndKeepWhatItAlreadyHad() {
        let merged = ShellPath.childPath(resolved: "/opt/homebrew/bin:/usr/bin",
                                         inherited: "/usr/bin:/sbin")
        // The shell's own ordering is what decides between two copies of a
        // tool, so it comes first; the inherited entry the shell did not
        // mention is kept rather than taken away.
        XCTAssertEqual(merged, "/opt/homebrew/bin:/usr/bin:/sbin")
    }

    func testADirectoryNamedTwiceShouldAppearOnce() {
        XCTAssertEqual(ShellPath.childPath(resolved: "/a:/b:/a", inherited: "/b:/c"), "/a:/b:/c")
    }

    /// A trailing colon means the current directory to some shells, and the
    /// current directory of an agent run is somebody's note folder.
    func testAnEmptySegmentShouldNotBecomeTheCurrentDirectory() {
        XCTAssertEqual(ShellPath.childPath(resolved: "/a::/b:", inherited: nil), "/a:/b")
    }

    func testAShellThatSaidNothingShouldLeaveTheInheritedPathAsItIs() {
        XCTAssertEqual(ShellPath.childPath(resolved: nil, inherited: "/usr/bin:/bin"),
                       "/usr/bin:/bin")
        XCTAssertNil(ShellPath.childPath(resolved: nil, inherited: nil))
        XCTAssertNil(ShellPath.childPath(resolved: "", inherited: ""))
    }

    // MARK: how the shell is asked

    /// Login AND interactive. Login alone misses `.zshrc`, which is where a
    /// zsh user's PATH most often is, and zsh has been the macOS default for
    /// years; interactive alone misses `.zprofile`, which is where Homebrew's
    /// own installer writes.
    func testTheShellShouldBeAskedAsBothALoginAndAnInteractiveOne() {
        let arguments = ShellPath.arguments()
        XCTAssertTrue(arguments.contains("-i"), "\(arguments)")
        XCTAssertTrue(arguments.contains("-l"), "\(arguments)")
        XCTAssertEqual(arguments.last, ShellPath.script)
        XCTAssertEqual(arguments[arguments.count - 2], "-c")
    }

    func testTheScriptShouldFenceThePathAndNothingElse() {
        XCTAssertTrue(ShellPath.script.contains(ShellPath.openMarker))
        XCTAssertTrue(ShellPath.script.contains(ShellPath.closeMarker))
        // The EXPORTED variable, never the shell's own. In fish `PATH` is a
        // list and `"$PATH"` renders it space-separated, which loses every
        // directory in it; `printenv` is colon-separated in every shell.
        XCTAssertTrue(ShellPath.script.contains("printenv PATH"))
        XCTAssertFalse(ShellPath.script.contains("$PATH"))
    }

    /// `printenv` ends its line, and the newline is not part of the value.
    func testTheLineBreakPrintenvLeavesShouldNotEndUpInThePath() {
        XCTAssertEqual(ShellPath.path(fromOutput: fenced("/usr/bin:/bin\n")), "/usr/bin:/bin")
        XCTAssertNil(ShellPath.path(fromOutput: fenced("\n")))
    }

    /// Ask a real shell and read the answer back.
    ///
    /// Driven rather than asserted about: the script and the parser are two
    /// halves of one mechanism, and a check of either alone would pass on a
    /// pair that cannot talk to each other.
    private func askingRealShell(_ shell: String) throws -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ShellPath.arguments()
        process.environment = ["PATH": "/birta-test-bin:/usr/bin:/bin",
                               "HOME": NSTemporaryDirectory(),
                               "ZDOTDIR": NSTemporaryDirectory()]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        try process.run()
        let data = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
        process.waitUntilExit()
        let output = try XCTUnwrap(String(data: data, encoding: .utf8))
        return ShellPath.path(fromOutput: output)
    }

    func testARealShellAskedThisWayShouldGiveBackItsOwnPath() throws {
        for shell in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            let path = try XCTUnwrap(askingRealShell(shell), "\(shell) fenced nothing in")
            XCTAssertTrue(path.split(separator: ":").contains("/birta-test-bin"),
                          "\(shell): \(path)")
        }
    }

    /// The shell the script shape was changed for. Skipped where it is not
    /// installed, and SAID rather than passed quietly: a check that reported
    /// success having run against nothing is worse than one that did not run.
    func testFishIfInstalledShouldGiveBackAColonSeparatedPath() throws {
        let fish = ["/opt/homebrew/bin/fish", "/usr/local/bin/fish"]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
        guard let fish else { throw XCTSkip("fish is not installed on this machine") }

        let path = try XCTUnwrap(askingRealShell(fish), "fish fenced nothing in")
        XCTAssertTrue(path.split(separator: ":").contains("/birta-test-bin"), path)
        XCTAssertFalse(path.contains(" "), "fish rendered its PATH as a list: \(path)")
    }

    func testTheShellToAskShouldBeTheAccountsOwnOneWithAWorkingDefault() {
        XCTAssertEqual(ShellPath.shell(fromEnvironment: ["SHELL": "/bin/bash"]), "/bin/bash")
        // Not `/bin/sh` when there is no answer: `sh` reads none of the files
        // this exists to read, so a fallback to it would resolve nothing and
        // look like it had worked.
        XCTAssertEqual(ShellPath.shell(fromEnvironment: [:]), "/bin/zsh")
        XCTAssertEqual(ShellPath.shell(fromEnvironment: ["SHELL": ""]), "/bin/zsh")
        XCTAssertEqual(ShellPath.shell(fromEnvironment: ["SHELL": "zsh"]), "/bin/zsh")
    }
}
