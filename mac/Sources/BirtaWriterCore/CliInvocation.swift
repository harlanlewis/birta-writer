import Foundation

/// What a shell asked the app to do, decided from the words it typed and
/// nothing else.
///
/// Pure, and that is the point rather than a testing convenience. The command
/// runs in the shell's process and the app runs in its own, so every fact that
/// separates them has to be carried across as a parameter: the working
/// directory a relative path resolves against is the SHELL's, never the app's,
/// and whether text is arriving on standard input is a fact about the
/// invocation rather than about the machine. `CliInvocationTests` supplies
/// both, along with the filesystem probe, so every row of the table below is
/// decidable without a disk and without a running app.
///
/// What this does NOT decide is where an opened file lands. That is
/// `OpenRouting.destination`'s, reached the same way Open With reaches it, so
/// a file named on a command line and a file double-clicked in the Finder
/// behave identically. A command that answered it here would be a second
/// routing rule nobody could see from the app.
public enum CliInvocation {
    /// What the command is being asked to do.
    public enum Action: Equatable, Sendable {
        /// No file: bring the app forward. A call from a shell is a request
        /// rather than a toggle, so it always shows.
        case summon
        /// Open these, in the order they were typed.
        case open([Target])
        /// Read standard input, put it in a file, and open that.
        case readStandardInput
        case version
        case help
    }

    /// One thing to open, and what it is on disk RIGHT NOW.
    ///
    /// The kind is resolved at parse time rather than carried as a bare path,
    /// because the three cases do different work before anything is opened and
    /// only one of them can fail late.
    public enum Target: Equatable, Sendable {
        /// A file that is there.
        case existing(URL)
        /// A folder, which opens as a directory window.
        case directory(URL)
        /// A path with nothing at it. The command creates it empty before
        /// opening, because LaunchServices refuses a path that does not exist
        /// and the app is reached through LaunchServices.
        case create(URL)

        public var url: URL {
            switch self {
            case let .existing(url), let .directory(url), let .create(url): return url
            }
        }
    }

    /// What is at a path, as much as the command needs to know.
    public enum PathKind: Equatable, Sendable {
        case file
        case directory
        case missing
    }

    /// Why a command line could not be carried out, with the sentence the
    /// shell is told.
    ///
    /// Every case carries what it was about, so the message names the word the
    /// user typed rather than describing the shape of the mistake.
    public enum Failure: Error, Equatable, Sendable {
        case unknownOption(String)
        case unsupportedFile(String)
        case noSuchDirectory(String)
        case waitWithoutFile
        case standardInputWithFiles

        /// What is printed on standard error. One sentence, naming the word
        /// that caused it and, where there is one, the way out.
        public var message: String {
            switch self {
            case let .unknownOption(option):
                return "unknown option: \(option)"
            case let .unsupportedFile(name):
                return "\(name) is not a file Birta Writer opens (\(CliInvocation.openedSpelling))"
            case let .noSuchDirectory(path):
                return "no such directory: \(path)"
            case .waitWithoutFile:
                return "--wait needs a file to wait for"
            case .standardInputWithFiles:
                return "- reads standard input and cannot be given with files"
            }
        }
    }

    /// A parsed command line: what to do, and whether the shell is waiting.
    public struct Request: Equatable, Sendable {
        public let action: Action
        /// `--wait`, which asks the command to block until the document is
        /// closed. Parsed and validated here; carrying out the wait needs a
        /// channel back from the app that does not exist yet, so the command
        /// refuses rather than returning early and pretending.
        public let waitsForClose: Bool

        public init(action: Action, waitsForClose: Bool = false) {
            self.action = action
            self.waitsForClose = waitsForClose
        }
    }

    /// The extensions in the message above, spelled once.
    ///
    /// Derived from `DocumentTypes.opened` rather than listed, because the
    /// command must not invent a second allowlist: what a shell may name is
    /// exactly what Open With and Cmd+O accept.
    public static var openedSpelling: String {
        DocumentTypes.opened.map { ".\($0)" }.joined(separator: ", ")
    }

    /// What `bwr <words>` means.
    ///
    /// `arguments` excludes the program name. `workingDirectory` is the
    /// shell's, and every relative path is resolved against it. `kind` is the
    /// only look at the disk, injected so the whole table is checkable without
    /// one.
    ///
    /// Options stop at `--`, so a file whose name begins with a hyphen is
    /// reachable as `bwr -- -weird.md` as well as `bwr ./-weird.md`.
    public static func parse(arguments: [String],
                             workingDirectory: String,
                             standardInputIsPiped: Bool,
                             kind: (URL) -> PathKind) throws -> Request {
        var waits = false
        var readsStandardInput = false
        var words: [String] = []
        var optionsEnded = false
        for argument in arguments {
            if optionsEnded {
                words.append(argument)
                continue
            }
            switch argument {
            case "--": optionsEnded = true
            case "-h", "--help": return Request(action: .help)
            case "-v", "--version": return Request(action: .version)
            case "-w", "--wait": waits = true
            // A lone hyphen is the POSIX spelling for standard input and is a
            // position in the list rather than an option. A file really called
            // `-` is `./-`, which lands in `words` below.
            case "-": readsStandardInput = true
            default:
                if argument.hasPrefix("-") && argument.count > 1 {
                    throw Failure.unknownOption(argument)
                }
                words.append(argument)
            }
        }

        if readsStandardInput && !words.isEmpty { throw Failure.standardInputWithFiles }

        let targets = try words.map { try target(for: $0, workingDirectory: workingDirectory, kind: kind) }
        if targets.isEmpty {
            if waits { throw Failure.waitWithoutFile }
            // Nothing named and nothing arriving means the shell wants the app
            // itself. `standardInputIsPiped` is deliberately narrower than "not
            // a terminal": a command run from a script has its input closed or
            // pointed at `/dev/null`, and reading that would answer a plain
            // summon with a complaint about an empty pipe. What counts is text
            // actually arriving, which is a pipe or a redirected file.
            return Request(action: readsStandardInput || standardInputIsPiped
                           ? .readStandardInput : .summon)
        }
        return Request(action: .open(targets), waitsForClose: waits)
    }

    /// One word of the command line as something to open.
    ///
    /// A directory is taken whatever it is called; a file is taken only when
    /// its extension is one the editor opens, whether it exists or not. The
    /// missing case also insists on a folder to put it in, so `bwr
    /// nowhere/new.md` fails before the app is launched rather than after.
    private static func target(for word: String,
                               workingDirectory: String,
                               kind: (URL) -> PathKind) throws -> Target {
        let url = resolve(word, workingDirectory: workingDirectory)
        switch kind(url) {
        case .directory:
            return .directory(url)
        case .file:
            guard DocumentTypes.accepts(url) else { throw Failure.unsupportedFile(word) }
            return .existing(url)
        case .missing:
            guard DocumentTypes.accepts(url) else { throw Failure.unsupportedFile(word) }
            let parent = url.deletingLastPathComponent()
            guard kind(parent) == .directory else { throw Failure.noSuchDirectory(parent.path) }
            return .create(url)
        }
    }

    /// A typed word as an absolute path.
    ///
    /// `~` is expanded here rather than left to the shell, because a quoted
    /// argument reaches the command unexpanded and a path that silently became
    /// a folder called `~` in the working directory is the kind of file nobody
    /// finds again.
    ///
    /// `standardized` and NOT `standardizedFileURL`, which is the one that
    /// touches the disk: it shortens `/private/var` to `/var` for a path that
    /// is there and leaves it alone for one that is not, so two files in one
    /// directory reach the app spelled two ways depending on which of them
    /// exists yet. Removing `.` and `..` is all this owes the app, which
    /// standardizes what it is handed anyway.
    public static func resolve(_ word: String, workingDirectory: String) -> URL {
        var path = word
        if path == "~" || path.hasPrefix("~/") {
            path = NSString(string: path).expandingTildeInPath
        }
        let base = URL(fileURLWithPath: workingDirectory, isDirectory: true)
        return URL(fileURLWithPath: path, relativeTo: base).absoluteURL.standardized
    }

    /// The file piped text is written to, under `directory`.
    ///
    /// Named by the clock down to the second, because a pipe has no name of
    /// its own and two of them in one day are ordinary. The template is
    /// expanded by `NoteNameTemplate`, so the date in a piped file's name is
    /// spelled the way the date in every other new note's name is.
    public static let pipedNameTemplate = "Piped %Y-%m-%d %H-%M-%S.md"

    /// That name, made unique against what is already in the folder.
    ///
    /// Two pipes inside one second are the case this exists for. The suffix is
    /// a counter rather than a longer clock, because the clock has already run
    /// out of resolution by the time this is reached.
    public static func pipedFile(in directory: URL,
                                 now: Date = Date(),
                                 exists: (URL) -> Bool) -> URL {
        let name = NoteNameTemplate.expand(pipedNameTemplate, at: now)
        let candidate = directory.appendingPathComponent(name)
        guard exists(candidate) else { return candidate }
        let stem = candidate.deletingPathExtension().lastPathComponent
        let ext = candidate.pathExtension
        var counter = 2
        while true {
            let next = directory.appendingPathComponent("\(stem) \(counter).\(ext)")
            if !exists(next) { return next }
            counter += 1
        }
    }
}
