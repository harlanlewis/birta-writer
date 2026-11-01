import Foundation

/// Whether two URLs name the same file on disk.
///
/// Path equality is not the question a caller ever means. `/tmp/x.md` and
/// `/private/tmp/x.md` are one file, so are two paths through a symlinked
/// directory, and on a case-insensitive volume so are `Scratchpad.md` and
/// `scratchpad.md`. The file system answers all three at once through its own
/// identity for the file, so ask it whenever both URLs resolve to something
/// that exists.
public enum FileIdentity {
    /// Whether a path names one of `files`, asked of many paths against one
    /// set of files: a new note's free name, a folder's file to open on.
    ///
    /// The files' resolved paths are worked out once, so a path that is not
    /// on disk (every candidate name a new note is offered) costs one lookup
    /// in a set rather than an identity check per file. The identity check is
    /// kept for a path that IS on disk, because only there can the same file
    /// hide behind another spelling (a case-insensitive volume, a hard link),
    /// and only there can the file system say so.
    public static func matcher(for files: [URL],
                               exists: @escaping (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) },
                               sameFile: @escaping (URL, URL) -> Bool = FileIdentity.sameFile) -> (URL) -> Bool {
        let keys = Set(files.map(resolvedPath))
        return { url in
            if keys.contains(resolvedPath(url)) { return true }
            guard exists(url) else { return false }
            return files.contains { sameFile($0, url) }
        }
    }

    private static func resolvedPath(_ url: URL) -> String {
        url.resolvingSymlinksInPath().standardizedFileURL.path
    }

    /// True when `a` and `b` are the same file.
    ///
    /// Uses the file system's identity when both exist. When either does not,
    /// there is nothing to be identical to, so this falls back to comparing
    /// resolved paths: two names for a file that is not there are the same
    /// destination, which is what a save-target comparison wants.
    public static func sameFile(_ a: URL, _ b: URL) -> Bool {
        // Resolve first: a URL's resource values describe the SYMLINK when it
        // is one, so asking a link and its target for their identities gets two
        // different answers to the question "is this the same file".
        let (ra, rb) = (a.resolvingSymlinksInPath(), b.resolvingSymlinksInPath())
        let key: Set<URLResourceKey> = [.fileResourceIdentifierKey]
        if let ida = try? ra.resourceValues(forKeys: key).fileResourceIdentifier,
           let idb = try? rb.resourceValues(forKeys: key).fileResourceIdentifier {
            return ida.isEqual(idb)
        }
        return ra.standardizedFileURL.path == rb.standardizedFileURL.path
    }
}
