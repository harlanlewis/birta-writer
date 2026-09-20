import XCTest
@testable import BirtaWriterCore

/// Every row of the command's invocation table, decided with no disk and no
/// app.
///
/// The filesystem is a closure per test, so what a word means can be asked of
/// a tree that does not exist. That is also the point: the working directory a
/// relative path resolves against belongs to the shell, and a check that used
/// the process's own would be measuring where the test runner happens to be
/// standing.
final class CliInvocationTests: XCTestCase {
    /// A tree, as a path-to-kind table. Anything not named is missing, which
    /// is the case the table exists to make cheap.
    private func tree(_ entries: [String: CliInvocation.PathKind]) -> (URL) -> CliInvocation.PathKind {
        { entries[$0.path] ?? .missing }
    }

    private let cwd = "/Users/someone/work"

    private func parse(_ words: [String],
                       piped: Bool = false,
                       tree entries: [String: CliInvocation.PathKind] = [:]) throws
        -> CliInvocation.Request {
        try CliInvocation.parse(arguments: words, workingDirectory: cwd,
                                standardInputIsPiped: piped, kind: tree(entries))
    }

    // MARK: what the words mean

    func testNoArgumentsShouldSummon() throws {
        XCTAssertEqual(try parse([]).action, .summon)
    }

    /// The one that separates "there is text arriving" from "this is not a
    /// terminal". A command run by a script has its input on /dev/null and
    /// means the same thing as one typed by hand.
    func testNoArgumentsWithTextArrivingShouldReadStandardInput() throws {
        XCTAssertEqual(try parse([], piped: true).action, .readStandardInput)
    }

    func testALoneHyphenShouldReadStandardInputEvenFromATerminal() throws {
        XCTAssertEqual(try parse(["-"]).action, .readStandardInput)
    }

    /// The distinction the hyphen row of the table is about: `./-` is a file.
    /// It is then refused for its extension like any other, which is the
    /// allowlist doing its job rather than the parser failing to see it.
    func testADotSlashHyphenShouldBeAPathRatherThanStandardInput() {
        XCTAssertThrowsError(try parse(["./-"])) { error in
            XCTAssertEqual(error as? CliInvocation.Failure, .unsupportedFile("./-"))
        }
    }

    func testAnExistingFileShouldBeOpenedWhereItIs() throws {
        let path = "\(cwd)/notes.md"
        let request = try parse(["notes.md"], tree: [path: .file])
        XCTAssertEqual(request.action, .open([.existing(URL(fileURLWithPath: path))]))
    }

    /// The whole reason the shell's directory is a parameter: the app's own is
    /// somewhere else entirely, and a relative path resolved there would name
    /// a different file or none.
    func testARelativePathShouldResolveAgainstTheShellsDirectory() throws {
        let path = "\(cwd)/deep/notes.md"
        let request = try parse(["./deep/../deep/notes.md"], tree: [path: .file])
        XCTAssertEqual(request.action, .open([.existing(URL(fileURLWithPath: path))]))
    }

    func testATildeShouldBeExpandedRatherThanTakenAsAFolderName() throws {
        let home = NSString(string: "~").expandingTildeInPath
        let path = "\(home)/notes.md"
        let request = try parse(["~/notes.md"], tree: [path: .file])
        XCTAssertEqual(request.action, .open([.existing(URL(fileURLWithPath: path))]))
    }

    func testAMissingPathShouldBeOneToCreate() throws {
        let request = try parse(["new.md"], tree: [cwd: .directory])
        XCTAssertEqual(request.action, .open([.create(URL(fileURLWithPath: "\(cwd)/new.md"))]))
    }

    func testAFolderShouldBeOpenedWhateverItIsCalled() throws {
        let path = "\(cwd)/notes"
        let request = try parse(["notes"], tree: [path: .directory])
        XCTAssertEqual(request.action, .open([.directory(URL(fileURLWithPath: path))]))
    }

    /// Tabs exist, so several files are several files rather than an error,
    /// and they keep the order they were typed in.
    func testSeveralFilesShouldAllBeOpenedInOrder() throws {
        let first = "\(cwd)/a.md"
        let second = "\(cwd)/b.md"
        let request = try parse(["a.md", "b.md"], tree: [first: .file, second: .file])
        XCTAssertEqual(request.action, .open([.existing(URL(fileURLWithPath: first)),
                                              .existing(URL(fileURLWithPath: second))]))
    }

    // MARK: the allowlist

    /// Derived from `DocumentTypes.opened` rather than listed, so a fourth
    /// format the editor learns is one this command learns on the same day.
    func testEveryExtensionTheEditorOpensShouldBeAccepted() throws {
        for ext in DocumentTypes.opened {
            let path = "\(cwd)/notes.\(ext)"
            XCTAssertEqual(try parse(["notes.\(ext)"], tree: [path: .file]).action,
                           .open([.existing(URL(fileURLWithPath: path))]), ext)
        }
    }

    /// The largest class of non-Markdown on a Unix machine is extensionless,
    /// and a command that opened `Makefile` because it had nothing to go on
    /// would be the one somebody points at a binary.
    func testAFileTheEditorDoesNotOpenShouldBeRefused() {
        for name in ["Makefile", "notes.txt", "shot.png", "notes.md.bak"] {
            XCTAssertThrowsError(try parse([name], tree: ["\(cwd)/\(name)": .file]), name) { error in
                XCTAssertEqual(error as? CliInvocation.Failure, .unsupportedFile(name), name)
            }
        }
    }

    /// Refused BEFORE anything is created, which is the half that matters: a
    /// path the command declined must leave no file behind.
    func testAMissingPathTheEditorWouldNotOpenShouldBeRefused() {
        XCTAssertThrowsError(try parse(["Makefile"], tree: [cwd: .directory])) { error in
            XCTAssertEqual(error as? CliInvocation.Failure, .unsupportedFile("Makefile"))
        }
    }

    /// Caught here rather than by the app, so the shell hears about it instead
    /// of a window coming up over nothing.
    func testAMissingPathWithNoFolderToPutItInShouldBeRefused() {
        XCTAssertThrowsError(try parse(["nowhere/new.md"], tree: [cwd: .directory])) { error in
            XCTAssertEqual(error as? CliInvocation.Failure, .noSuchDirectory("\(cwd)/nowhere"))
        }
    }

    // MARK: options

    func testHelpAndVersionShouldWinOverEverythingElse() throws {
        XCTAssertEqual(try parse(["--help", "notes.md"]).action, .help)
        XCTAssertEqual(try parse(["-h"]).action, .help)
        XCTAssertEqual(try parse(["--version", "--wait"]).action, .version)
        XCTAssertEqual(try parse(["-v"]).action, .version)
    }

    func testAnUnknownOptionShouldBeRefusedAndNamed() {
        XCTAssertThrowsError(try parse(["--nope"])) { error in
            XCTAssertEqual(error as? CliInvocation.Failure, .unknownOption("--nope"))
        }
    }

    func testWaitShouldBeCarriedOnTheRequest() throws {
        let path = "\(cwd)/notes.md"
        let request = try parse(["--wait", "notes.md"], tree: [path: .file])
        XCTAssertTrue(request.waitsForClose)
        XCTAssertEqual(request.action, .open([.existing(URL(fileURLWithPath: path))]))
    }

    /// There is nothing to wait for, so the shell would block until the app
    /// quit. Refused rather than reinterpreted as a summon.
    func testWaitWithNoFileShouldBeRefused() {
        XCTAssertThrowsError(try parse(["--wait"])) { error in
            XCTAssertEqual(error as? CliInvocation.Failure, .waitWithoutFile)
        }
    }

    func testEverythingAfterADoubleHyphenShouldBeAPath() throws {
        let path = "\(cwd)/-weird.md"
        let request = try parse(["--", "-weird.md"], tree: [path: .file])
        XCTAssertEqual(request.action, .open([.existing(URL(fileURLWithPath: path))]))
    }

    /// A file after `--` that would otherwise have been read as an option, and
    /// a hyphen after it that would otherwise have been standard input.
    func testADoubleHyphenShouldAlsoStopTheStandardInputHyphen() throws {
        let path = "\(cwd)/-"
        XCTAssertThrowsError(try parse(["--", "-"], tree: [path: .file])) { error in
            XCTAssertEqual(error as? CliInvocation.Failure, .unsupportedFile("-"))
        }
    }

    func testStandardInputAndFilesTogetherShouldBeRefused() {
        XCTAssertThrowsError(try parse(["-", "notes.md"], tree: ["\(cwd)/notes.md": .file])) { error in
            XCTAssertEqual(error as? CliInvocation.Failure, .standardInputWithFiles)
        }
    }

    // MARK: messages

    /// Every failure says which word caused it. A refusal that described the
    /// shape of the mistake without naming the argument costs the reader the
    /// same look twice.
    func testEveryFailureShouldSayWhatItWasAbout() {
        XCTAssertTrue(CliInvocation.Failure.unknownOption("--nope").message.contains("--nope"))
        XCTAssertTrue(CliInvocation.Failure.unsupportedFile("Makefile").message.contains("Makefile"))
        XCTAssertTrue(CliInvocation.Failure.noSuchDirectory("/a/b").message.contains("/a/b"))
        XCTAssertFalse(CliInvocation.Failure.waitWithoutFile.message.isEmpty)
        XCTAssertFalse(CliInvocation.Failure.standardInputWithFiles.message.isEmpty)
    }

    /// The refusal names what IS opened, and names it from the one list, so
    /// the sentence cannot go stale against the allowlist it describes.
    func testTheUnsupportedMessageShouldNameEveryFormatTheEditorOpens() {
        let message = CliInvocation.Failure.unsupportedFile("Makefile").message
        for ext in DocumentTypes.opened {
            XCTAssertTrue(message.contains(".\(ext)"), ext)
        }
    }

    // MARK: piped text

    func testThePipedFileShouldCarryTheClockDownToTheSecond() {
        let directory = URL(fileURLWithPath: "/tmp/piped")
        let noon = Date(timeIntervalSince1970: 1_600_000_000)
        let file = CliInvocation.pipedFile(in: directory, now: noon, exists: { _ in false })
        XCTAssertEqual(file.deletingLastPathComponent().path, directory.path)
        XCTAssertEqual(file.pathExtension, "md")
        XCTAssertTrue(file.lastPathComponent.hasPrefix("Piped "), file.lastPathComponent)
    }

    /// Two pipes inside one second, which is the only thing the clock in the
    /// name cannot separate.
    func testASecondPipeInTheSameSecondShouldGetADistinctName() {
        let directory = URL(fileURLWithPath: "/tmp/piped")
        let noon = Date(timeIntervalSince1970: 1_600_000_000)
        let taken = CliInvocation.pipedFile(in: directory, now: noon, exists: { _ in false })
        let next = CliInvocation.pipedFile(in: directory, now: noon,
                                           exists: { $0.path == taken.path })
        XCTAssertNotEqual(next.path, taken.path)
        XCTAssertEqual(next.pathExtension, "md")
        // The counter goes on the stem rather than after the extension, or the
        // second file stops being a Markdown file.
        XCTAssertTrue(next.deletingPathExtension().lastPathComponent
            .hasPrefix(taken.deletingPathExtension().lastPathComponent))
    }
}
