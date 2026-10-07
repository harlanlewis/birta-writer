import Foundation
import BirtaWriterCore

/// The app's half of `AccessGrantList`: taking a bookmark when the person
/// hands something over, and renewing every one at launch.
///
/// Two calls, and where each is made is the whole design. `remember` goes at
/// every place a file or folder arrives through the person's own gesture: the
/// Finder and the Dock (`application(_:open:)`), Open, Save As, the notes
/// Location, and the title's Move. `restoreAtLaunch` goes first in
/// `applicationDidFinishLaunching`, before anything reads a stored path,
/// because what it renews is exactly what the launch is about to read: the
/// windows it puts back, the recents and the notes folder.
///
/// Inert off the store channel, so a direct build stores no bookmarks and
/// starts no access; and every failure is swallowed into "no grant", since a
/// grant the system will not give back leaves the app where the sandbox put
/// it anyway, which is a window that cannot read its file and says so.
@MainActor
enum SandboxAccess {
    /// How a bookmark is taken and read back, injectable because the real
    /// ones need a sandboxed process with the bookmarks entitlement and a
    /// test process is neither.
    struct Bookmarks {
        var make: (URL) -> Data? = { url in
            try? url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
        }
        /// The URL a bookmark names and whether the system called it stale.
        ///
        /// Never mounting and never asking: this runs on the main thread
        /// before the first window, and a bookmark to a drive that is not
        /// plugged in or a share that is not reachable would otherwise stall
        /// the launch or put a dialog in front of it. Such a grant fails to
        /// resolve this launch and is dropped, which leaves its file where the
        /// sandbox leaves any other, unreadable and never written.
        var resolve: (Data) -> (url: URL, stale: Bool)? = { data in
            var stale = false
            guard let url = try? URL(resolvingBookmarkData: data,
                                     options: [.withSecurityScope, .withoutUI, .withoutMounting],
                                     relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
            return (url, stale)
        }
        var startAccessing: (URL) -> Bool = { $0.startAccessingSecurityScopedResource() }
    }

    static var bookmarks = Bookmarks()

    /// The grants this process renewed, held for its lifetime. Access is
    /// never stopped: the windows, the recents and the notes folder can be
    /// read at any moment, and a balanced stop would have to know when the
    /// last of them was done with a path, which nothing here can.
    private(set) static var live: [URL] = []

    /// Record a bookmark for each URL the person just handed over, unless a
    /// grant already reaches it. Call while the grant is live: right after the
    /// panel or the open event, never later.
    static func remember(_ urls: [URL], distribution: Distribution = .current) {
        guard distribution.keepsAccessGrants else { return }
        var list = Prefs.accessGrants
        for url in urls where !list.covers(url.path) {
            guard let data = bookmarks.make(url) else { continue }
            list = list.recording(.init(path: url.path, bookmark: data))
        }
        if list != Prefs.accessGrants { Prefs.accessGrants = list }
    }

    static func remember(_ url: URL, distribution: Distribution = .current) {
        remember([url], distribution: distribution)
    }

    /// Renew every stored grant. A bookmark that no longer resolves is
    /// dropped, and one the system calls stale is taken again from the URL it
    /// resolved to, so the list heals rather than failing on every launch.
    static func restoreAtLaunch(distribution: Distribution = .current) {
        guard distribution.keepsAccessGrants else { return }
        var list = Prefs.accessGrants
        for grant in list.grants {
            guard let (url, stale) = bookmarks.resolve(grant.bookmark), bookmarks.startAccessing(url) else {
                list = list.removing(grant.path)
                continue
            }
            live.append(url)
            if stale, let fresh = bookmarks.make(url) {
                list = list.renewing(grant.path, bookmark: fresh)
            }
        }
        if list != Prefs.accessGrants { Prefs.accessGrants = list }
    }

    /// For tests: forget what this process renewed.
    static func resetForTesting() { live = [] }
}
