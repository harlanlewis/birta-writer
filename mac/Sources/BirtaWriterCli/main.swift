import BirtaWriterCore
import Darwin
import Foundation

/// The command a shell types to reach Birta Writer for Mac.
///
/// It is a launcher rather than a second front end. Everything it can be asked
/// to do ends in LaunchServices opening a file with the app, which is the same
/// route the Finder's Open With takes, so a file named here lands exactly
/// where a file double-clicked lands and `OpenRouting` stays the only answer to
/// that question. What the command does on its own is the part LaunchServices
/// cannot express: resolving a relative path against the shell's working
/// directory, creating a file that does not exist yet, and putting piped text
/// somewhere before there is anything to open.
///
/// Where the decisions live: `CliInvocation` for what the words mean,
/// `CommandInstall` for how the name gets onto `PATH`. What is here is the
/// running of it, and the two seams a check needs.

/// Standard error, one line.
func fail(_ message: String) {
    FileHandle.standardError.write(Data("\(programName): \(message)\n".utf8))
}

/// The name the command was invoked by, which is the link's name rather than
/// the executable's: somebody who renamed it in Settings should read their own
/// name back out of an error and out of the usage text.
let programName = URL(fileURLWithPath: CommandLine.arguments.first ?? CommandInstall.executableName)
    .lastPathComponent

/// This executable's own path, from the kernel rather than from `argv[0]`.
///
/// `argv[0]` is the word the shell typed, which is the whole point of the
/// command and useless for finding the bundle. `_NSGetExecutablePath` answers
/// with the path that was executed, which for an installed command is the
/// symlink; resolving it is what walks back into the app.
func executablePath() -> URL? {
    var size = UInt32(0)
    _ = _NSGetExecutablePath(nil, &size)
    var buffer = [CChar](repeating: 0, count: Int(size) + 1)
    guard _NSGetExecutablePath(&buffer, &size) == 0 else { return nil }
    return URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath()
}

/// The app bundle this command belongs to.
///
/// `Contents/MacOS/<command>` is where `build-app.sh` puts it, so the bundle is
/// three levels up. Checked rather than assumed, because the same binary is
/// built and run outside a bundle by `mac/scripts/check-cli.sh`.
/// `BIRTA_MAC_CLI_BUNDLE` names one for a check, in the shape every other
/// `BIRTA_MAC_*` seam has.
func appBundle() -> URL? {
    if let named = ProcessInfo.processInfo.environment["BIRTA_MAC_CLI_BUNDLE"], !named.isEmpty {
        return URL(fileURLWithPath: named)
    }
    guard let executable = executablePath() else { return nil }
    let bundle = executable
        .deletingLastPathComponent()  // MacOS
        .deletingLastPathComponent()  // Contents
        .deletingLastPathComponent()  // <app>.app
    guard bundle.pathExtension == "app",
          FileManager.default.fileExists(atPath: bundle.appendingPathComponent("Contents/Info.plist").path)
    else { return nil }
    return bundle
}

/// Print what would happen instead of launching, for `mac/scripts/check-cli.sh`.
///
/// The filesystem half still runs. Creating the file a path names and writing
/// piped text are this command's own work rather than the app's, and a check
/// that skipped them would be checking the printing.
let dryRun = ProcessInfo.processInfo.environment["BIRTA_MAC_CLI_DRY_RUN"] == "1"

func report(_ line: String) {
    FileHandle.standardOutput.write(Data("\(line)\n".utf8))
}

let usage = """
    usage: \(programName) [options] [file | folder ...]

      \(programName)                open Birta Writer
      \(programName) notes.md       open a file, creating it if it is not there
      \(programName) ~/notes/       open a folder
      cat draft.md | \(programName) open what was piped in
      \(programName) -              the same, said out loud

    options:
      -h, --help      this
      -v, --version   the version of the app this command belongs to
      -w, --wait      wait until the document is closed (not available yet)
      --              stop reading options, so a file may begin with a hyphen

    Files are opened where Open With would open them, which the "Open files in"
    setting decides. Birta Writer opens \(CliInvocation.openedSpelling) files.
    """

/// Run `open(1)` for one thing, and say whether it worked.
///
/// `open` rather than `NSWorkspace` because this process has no run loop and
/// wants none: the work is one blocking call whose exit status is the answer.
/// One invocation per item, which is what makes `\(programName) a.md b.md`
/// open both: LaunchServices delivers a single call's items in one event, and
/// the app takes one of those, as it must for a Finder selection.
func launch(_ app: URL, arguments: [String]) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-a", app.path] + arguments
    do {
        try process.run()
    } catch {
        fail(error.localizedDescription)
        return false
    }
    process.waitUntilExit()
    return process.terminationStatus == 0
}

/// The bundle this command belongs to, looked for even under a dry run.
///
/// A check must read the flavour the real command would: a development build's
/// piped text goes in a folder of its own, and a dry run that skipped the
/// lookup would put it in the release's and report that as correct. Nil only
/// where there is no bundle at all, which is the command run straight out of
/// `swift build`.
let app = appBundle()

/// The bundle, or a refusal. Everything that actually launches needs one.
func requireApp() -> URL {
    guard let app else {
        fail("cannot find Birta Writer.app; reinstall the command from Settings")
        exit(1)
    }
    return app
}

/// Whether text is arriving on standard input.
///
/// A pipe, a socket, or a redirected file. Deliberately not "is not a
/// terminal", which is also true of a command run from a script or a launchd
/// job with its input on `/dev/null`: that is a plain summon, and answering it
/// by reading a character device that never ends nothing would be a complaint
/// about an empty pipe instead of a window.
func standardInputIsPiped() -> Bool {
    var status = stat()
    guard fstat(FileHandle.standardInput.fileDescriptor, &status) == 0 else { return false }
    let type = status.st_mode & S_IFMT
    return type == S_IFIFO || type == S_IFSOCK || type == S_IFREG
}

func kind(of url: URL) -> CliInvocation.PathKind {
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
    else { return .missing }
    return isDirectory.boolValue ? .directory : .file
}

let request: CliInvocation.Request
do {
    request = try CliInvocation.parse(
        arguments: Array(CommandLine.arguments.dropFirst()),
        workingDirectory: FileManager.default.currentDirectoryPath,
        standardInputIsPiped: standardInputIsPiped(),
        kind: kind(of:))
} catch let failure as CliInvocation.Failure {
    fail(failure.message)
    exit(2)
} catch {
    fail(error.localizedDescription)
    exit(2)
}

// Refused here rather than in the parser, which validates it: the flag's
// meaning is settled and the channel that would carry the app's answer back is
// not built, so the honest answer is to say so rather than to return the moment
// the document opens.
if request.waitsForClose {
    fail("--wait is not available yet")
    exit(2)
}

switch request.action {
case .help:
    report(usage)

case .version:
    let app = requireApp()
    guard let bundle = Bundle(url: app) else {
        fail("cannot read \(app.lastPathComponent)")
        exit(1)
    }
    // The APP's version rather than one of this command's own: the two ship in
    // one bundle, and a second number would be a second thing to keep in step.
    //
    // Spelled by `AboutInfo` rather than here, which is the same sentence the
    // About window draws and the same reason it has one place to come from. An
    // unstamped build says so instead of printing a number that identifies no
    // release; `macUpdateVersionSpelling.test.ts` is what holds every surface
    // to that, and it read this line before there was one.
    let about = AboutInfo(
        name: AppFlavor.forBundle(bundle.bundleIdentifier).displayName,
        shortVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
        copyright: nil)
    report([about.name, about.versionLine].joined(separator: " "))

case .summon:
    if dryRun {
        // The word itself, not just the verb: what the app reads out of its
        // own `argv` is the other end of this and cannot see this spelling.
        report("summon \(CliInvocation.summonArgument)")
        break
    }
    // `--summon` reaches the app's `argv` on a cold launch and is ignored on a
    // warm one, where `open` sends the reopen event the Dock icon sends and the
    // app summons from there. Both routes end in every window showing, which is
    // what a call from a shell means: a request, never a toggle.
    guard launch(requireApp(), arguments: ["--args", CliInvocation.summonArgument])
    else { exit(1) }

case .readStandardInput:
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty else {
        fail("nothing on standard input")
        exit(1)
    }
    let flavour = AppFlavor.forBundle(app.flatMap { Bundle(url: $0)?.bundleIdentifier })
    // `BIRTA_MAC_CLI_SUPPORT` points this at a throwaway folder for a checking
    // run, as `BIRTA_MAC_THEMES_DIR` does for the theme library and for the
    // same reason: the real one holds somebody's own files, and a check that
    // writes there has to tidy up after itself in a directory it did not make.
    let named = ProcessInfo.processInfo.environment["BIRTA_MAC_CLI_SUPPORT"] ?? ""
    let support = named.isEmpty
        ? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        : URL(fileURLWithPath: named)
    guard let support else {
        fail("cannot find Application Support")
        exit(1)
    }
    // Piped text has no name and no folder of its own, so it goes in the app's
    // own, under the flavour's name: a development build must not drop files
    // in among the release's. A note somebody wants to keep is one Save As
    // away from anywhere they like.
    let directory = support
        .appendingPathComponent(flavour.displayName, isDirectory: true)
        .appendingPathComponent("Piped", isDirectory: true)
    let file = CliInvocation.pipedFile(in: directory) {
        FileManager.default.fileExists(atPath: $0.path)
    }
    do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: file)
    } catch {
        fail(error.localizedDescription)
        exit(1)
    }
    if dryRun {
        report("write \(file.path)")
        report("open \(file.path)")
        break
    }
    guard launch(requireApp(), arguments: [file.path]) else { exit(1) }

case let .open(targets):
    // Asked for before the loop, so a command that cannot find its app says so
    // rather than creating every file it was given and then failing.
    if !dryRun { _ = requireApp() }
    for target in targets {
        if case let .create(url) = target {
            // LaunchServices refuses a path with nothing at it, so a file the
            // shell named into being is created here, empty, before the app is
            // asked for it. Its mode is the one the user's `umask` gives any
            // other file they make from a shell; 0600 is for a note the app
            // named itself, not for a path somebody typed.
            guard FileManager.default.createFile(atPath: url.path, contents: Data()) else {
                fail("cannot create \(url.path)")
                exit(1)
            }
            if dryRun { report("create \(url.path)") }
        }
        if dryRun {
            report("open \(target.url.path)")
            continue
        }
        guard launch(requireApp(), arguments: [target.url.path]) else { exit(1) }
    }
}
