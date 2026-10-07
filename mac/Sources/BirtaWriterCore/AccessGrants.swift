import Foundation

/// What a sandboxed copy has been allowed to reach outside its container, kept
/// so it can reach it again after a relaunch.
///
/// The App Sandbox grants a file or a folder for the life of the process when
/// the person hands it over (the Finder, Open, Save As, a folder chosen in
/// Settings), and forgets it at quit. Every path the app stores (the recent
/// files, the windows a launch puts back, the notes folder somebody named) is
/// then unreadable by path on the next launch, and a window put back on one
/// opens on a note it can neither read nor write. A security-scoped bookmark
/// taken while the grant is live is what survives, and resolving it at launch
/// is what renews the grant. `mac/scripts/sandbox-check.sh` holds both halves.
///
/// This is the list of those bookmarks and nothing else: which paths, in what
/// order, and how many. Taking a bookmark and resolving one are the app's,
/// because they need the process's entitlements; everything that can be
/// decided without them is here, so it can be asked about with no sandbox.
///
/// Kept only where it is needed (`Distribution.keepsAccessGrants`). A direct
/// build reads its paths as it always has and stores no bookmarks at all.
public struct AccessGrantList: Equatable, Sendable, Codable {
    /// One grant: the path it was taken for, and the bookmark that renews it.
    public struct Grant: Equatable, Sendable, Codable {
        public let path: String
        public let bookmark: Data

        public init(path: String, bookmark: Data) {
            self.path = path
            self.bookmark = bookmark
        }
    }

    /// The most grants kept. Each one resolved at launch holds a sandbox
    /// extension open for the life of the process, and the kernel's table of
    /// those is finite; the recents list and the windows a launch restores
    /// are far smaller than this, so it is a ceiling that should never bind.
    public static let capacity = 64

    /// Most recently granted first.
    public private(set) var grants: [Grant]

    public init(grants: [Grant] = []) {
        self.grants = Array(grants.prefix(Self.capacity))
    }

    /// The form every path is compared in: absolute, standardized, symlinks
    /// resolved and no trailing slash. A grant for a folder reached through a
    /// link must cover the same files as one taken for the folder itself.
    public static func key(_ path: String) -> String {
        let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
        return resolved.count > 1 && resolved.hasSuffix("/") ? String(resolved.dropLast()) : resolved
    }

    /// Whether some grant reaches `path`: a grant for it, or for a folder it
    /// is inside. `/notes` covers `/notes/a.md`, never `/notes-old/a.md`.
    public func covers(_ path: String) -> Bool {
        let target = Self.key(path)
        return grants.contains { Self.contains($0.path, target) }
    }

    /// The list with `grant` recorded as the most recent. A grant already
    /// held for the same path is replaced rather than kept twice, a folder
    /// grant drops the grants it now covers, and the oldest go past
    /// `capacity`.
    public func recording(_ grant: Grant) -> AccessGrantList {
        let fresh = Grant(path: Self.key(grant.path), bookmark: grant.bookmark)
        let rest = grants.filter { !Self.contains(fresh.path, $0.path) }
        return AccessGrantList(grants: [fresh] + rest)
    }

    /// The list without the grant for `path`, for a bookmark that no longer
    /// resolves: kept, it would be tried and fail on every launch.
    public func removing(_ path: String) -> AccessGrantList {
        let target = Self.key(path)
        return AccessGrantList(grants: grants.filter { $0.path != target })
    }

    /// The list with the bookmark for `path` swapped for a fresh one, in
    /// place. A bookmark the system reports stale still resolves this time
    /// and may not next time, so it is renewed where it stands rather than
    /// moved to the front: renewing is not the person granting it again.
    public func renewing(_ path: String, bookmark: Data) -> AccessGrantList {
        let target = Self.key(path)
        return AccessGrantList(grants: grants.map {
            $0.path == target ? Grant(path: target, bookmark: bookmark) : $0
        })
    }

    /// Whether `inner` is `outer` or inside it, both already keys.
    static func contains(_ outer: String, _ inner: String) -> Bool {
        inner == outer || inner.hasPrefix(outer == "/" ? "/" : outer + "/")
    }

    /// The stored form, a property list, so it sits in the defaults domain
    /// beside the paths it renews.
    public func encoded() -> Data? { try? PropertyListEncoder().encode(self) }

    /// The list a stored form describes; an empty one for nothing stored or a
    /// form this build cannot read, since the grants are a convenience and a
    /// launch must never fail on them.
    public static func decoded(_ data: Data?) -> AccessGrantList {
        guard let data, let list = try? PropertyListDecoder().decode(AccessGrantList.self, from: data) else {
            return AccessGrantList()
        }
        return list
    }
}
