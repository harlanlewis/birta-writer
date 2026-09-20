import Foundation

/// Putting the command on `PATH`, and taking it off again.
///
/// A symlink in a directory the user already owns, pointing at the executable
/// inside the app bundle. That shape is what keeps the whole gesture free of
/// an administrator password: nothing is written outside the home directory,
/// nothing is copied, and an app that moves or updates carries its command
/// with it because the link names the bundle rather than a copy of what is in
/// it.
///
/// The decisions are here and the filesystem work is the three small functions
/// at the bottom, so what a click is about to do can be asked without doing
/// it. The one rule worth stating on its own: **anything at the install path
/// that is not a link into an app bundle of ours is left exactly where it is
/// and reported.** A command directory is somebody's own, and replacing a file
/// in it because the name collided is the kind of help nobody asks for twice.
public enum CommandInstall {
    /// What the command is called when nobody has renamed it.
    ///
    /// Three characters, specific to this app rather than to the company, so
    /// `bw` stays free for anything else. A development build installs under a
    /// name of its own: the two bundles are meant to sit in `/Applications`
    /// together, and one name would mean whichever was installed second
    /// silently took the other's.
    public static func defaultName(isDevelopmentBuild: Bool) -> String {
        isDevelopmentBuild ? "bwr-dev" : "bwr"
    }

    /// The executable's name inside the bundle, which the link points at.
    ///
    /// Fixed whatever the link is called, because it is a file in the app
    /// rather than a name on `PATH`. `mac/scripts/build-app.sh` copies the
    /// built command here, and `Contents/MacOS` rather than
    /// `Contents/Resources` is the placement notarization accepts (MAR-378).
    public static let executableName = "bwr"

    /// Where the link goes: a directory a user owns, on `PATH` by convention
    /// on a modern Mac and needing no password either way.
    public static func defaultDirectory(home: URL) -> URL {
        home.appendingPathComponent(".local/bin", isDirectory: true)
    }

    /// What is at the install path already.
    public enum Existing: Equatable, Sendable {
        case nothing
        /// A symlink into an app bundle of ours, resolving to the URL given.
        case ours(URL)
        /// A symlink somewhere else entirely.
        case foreignLink(URL)
        /// A file or a directory, which is never replaced.
        case foreignFile
    }

    /// What a click would do.
    public enum Plan: Equatable, Sendable {
        /// Create the link. The directory is created too when it is missing.
        case install
        /// Ours, but pointing at another copy of the app. Replace it.
        case relink
        /// Ours, already pointing here.
        case alreadyInstalled
        /// Somebody else's. The message is what the row says.
        case refuse(String)
    }

    /// What unchecking the box would do.
    public enum Removal: Equatable, Sendable {
        case remove
        /// Nothing of ours is there, so nothing is taken away.
        case nothing
        /// Something is there and it is not ours.
        case refuse(String)
    }

    /// Whether a link's destination is the command inside an app bundle.
    ///
    /// The test is the SHAPE of the destination rather than a comparison with
    /// where we would install, so a link left by another copy of the app is
    /// still recognised as ours and can be replaced. Three things have to hold
    /// together: the file is the command's executable name, it sits directly
    /// in `Contents/MacOS`, and the directory above that is a bundle.
    public static func isOurs(destination: URL) -> Bool {
        let components = destination.standardizedFileURL.pathComponents
        guard components.count >= 4 else { return false }
        let last = components[components.count - 1]
        let macOS = components[components.count - 2]
        let contents = components[components.count - 3]
        let bundle = components[components.count - 4]
        return last == executableName && macOS == "MacOS" && contents == "Contents"
            && bundle.hasSuffix(".app")
    }

    /// The plan for installing `target` at a path that currently holds
    /// `existing`.
    public static func plan(existing: Existing, target: URL) -> Plan {
        switch existing {
        case .nothing:
            return .install
        case let .ours(destination):
            return destination.standardizedFileURL == target.standardizedFileURL
                ? .alreadyInstalled : .relink
        case let .foreignLink(destination):
            return .refuse("Another program's \(destination.lastPathComponent) is already linked there.")
        case .foreignFile:
            return .refuse("A file of that name is already there.")
        }
    }

    /// The plan for removing it.
    ///
    /// Only a link we put there goes, and a link pointing at ANOTHER copy of
    /// the app goes too: it is still this product's command under this name,
    /// and leaving it would mean unchecking the box left the command working.
    public static func removal(existing: Existing) -> Removal {
        switch existing {
        case .nothing: return .nothing
        case .ours: return .remove
        case .foreignLink, .foreignFile:
            return .refuse("That name belongs to something else, so it was left alone.")
        }
    }

    /// Whether an installed command would actually be the one that runs.
    ///
    /// Two independent ways for the link to exist and the name to do nothing,
    /// and a row that reported only the link would be silent about both. The
    /// directory may not be on `PATH` at all, and something earlier on `PATH`
    /// may already answer to the name.
    public enum Standing: Equatable, Sendable {
        case reachable
        case notOnPath
        /// The full path of the command that answers first.
        case shadowed(String)

        /// What the settings row says, empty when there is nothing to report.
        public func note(name: String, directory: String) -> String {
            switch self {
            case .reachable: return ""
            case .notOnPath:
                return "\(directory) is not on your PATH, so \(name) will not be found yet."
            case let .shadowed(other):
                return "\(other) already answers to \(name), and it comes first on your PATH."
            }
        }

        public var isProblem: Bool { self != .reachable }
    }

    /// Where `name` would be found, given the `PATH` a terminal has.
    ///
    /// `isExecutable` is injected because the answer depends on the user's own
    /// filesystem and the question is decidable without it. The walk stops at
    /// our own directory: an entry AFTER it is one the installed command would
    /// shadow rather than one that shadows it, which is not news.
    public static func standing(name: String,
                                directory: String,
                                path: String,
                                isExecutable: (String) -> Bool) -> Standing {
        let ours = standardized(directory)
        let entries = path.split(separator: ":", omittingEmptySubsequences: true).map(String.init)
        var sawOurs = false
        for entry in entries {
            if standardized(entry) == ours {
                sawOurs = true
                break
            }
            let candidate = (entry as NSString).appendingPathComponent(name)
            if isExecutable(candidate) { return .shadowed(candidate) }
        }
        return sawOurs ? .reachable : .notOnPath
    }

    /// A `PATH` entry as something comparable. A trailing slash and a `~` are
    /// both ordinary in a hand-edited `PATH` and neither changes the directory
    /// meant; `standardizedFileURL` settles both, the tilde included.
    private static func standardized(_ directory: String) -> String {
        URL(fileURLWithPath: directory).standardizedFileURL.path
    }

    // MARK: the filesystem

    /// What is at `link` right now.
    ///
    /// A symlink is read rather than resolved through `FileManager`'s
    /// existence checks, because a link pointing at a bundle that has been
    /// deleted still has to be recognised as ours: it is exactly the link an
    /// install is being asked to repair.
    public static func inspect(link: URL, fileManager: FileManager = .default) -> Existing {
        guard let attributes = try? fileManager.attributesOfItem(atPath: link.path),
              let type = attributes[.type] as? FileAttributeType else { return .nothing }
        guard type == .typeSymbolicLink else { return .foreignFile }
        guard let destination = try? fileManager.destinationOfSymbolicLink(atPath: link.path)
        else { return .foreignFile }
        let resolved = destination.hasPrefix("/")
            ? URL(fileURLWithPath: destination)
            : link.deletingLastPathComponent().appendingPathComponent(destination)
        return isOurs(destination: resolved) ? .ours(resolved.standardizedFileURL)
                                             : .foreignLink(resolved.standardizedFileURL)
    }

    /// Carry out an install. Returns nil on success and the sentence to show
    /// otherwise.
    ///
    /// The target is checked first, and it is the one thing here that is about
    /// this app rather than about the user's directory: a link to a command
    /// that is not in the bundle is a name on `PATH` that fails when it is
    /// run, which is worse than a row that refused.
    ///
    /// The directory is created when it is missing, which is the ordinary case
    /// on a Mac nobody has set one up on.
    public static func install(link: URL, target: URL,
                               fileManager: FileManager = .default) -> String? {
        guard fileManager.fileExists(atPath: target.path) else {
            return "This copy of the app has no \(executableName) to link to."
        }
        let plan = plan(existing: inspect(link: link, fileManager: fileManager), target: target)
        do {
            switch plan {
            case .alreadyInstalled:
                return nil
            case let .refuse(reason):
                return reason
            case .install:
                try fileManager.createDirectory(at: link.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
            case .relink:
                // Removed rather than overwritten, because `createSymbolicLink`
                // has no such option. What is being removed is a link the plan
                // has already decided is ours.
                try fileManager.removeItem(at: link)
            }
            try fileManager.createSymbolicLink(at: link, withDestinationURL: target)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Carry out a removal. Returns nil when there is nothing of ours left at
    /// the path, which is what unchecking the box promises, and the sentence
    /// to show when something is in the way.
    public static func uninstall(link: URL, fileManager: FileManager = .default) -> String? {
        switch removal(existing: inspect(link: link, fileManager: fileManager)) {
        case .nothing:
            return nil
        case let .refuse(reason):
            return reason
        case .remove:
            do {
                try fileManager.removeItem(at: link)
                return nil
            } catch {
                return error.localizedDescription
            }
        }
    }
}
