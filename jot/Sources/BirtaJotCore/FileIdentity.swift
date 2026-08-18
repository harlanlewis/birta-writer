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
