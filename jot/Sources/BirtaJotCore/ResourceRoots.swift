import Foundation

/// Which files the page is allowed to read, and the only place that question is
/// answered.
///
/// The page needs two kinds of file: its own bundle, and the images the open
/// document references. The second one is document-controlled input, so it is
/// the reason this type exists rather than a `webRoot + path` join: a document
/// can say `![](../../.ssh/id_rsa)`, and the handler must be able to answer
/// "not yours" without thinking about it at the call site.
///
/// This is VS Code's `localResourceRoots` idea, small enough to hold in one
/// head: a request resolves against an ordered list of roots, and a resolved
/// path that is not INSIDE the root that produced it is refused. Containment is
/// checked on the resolved, symlink-followed path, because `..` is not the only
/// way out of a directory.
public struct ResourceRoots: Sendable {
    /// The app's own web assets. Always present.
    public let bundle: URL
    /// The folder of the document being edited, or nil when there is none.
    /// Serves the images that document references, and nothing above it.
    public let document: URL?

    public init(bundle: URL, document: URL?) {
        self.bundle = bundle
        self.document = document
    }

    /// Same roots, pointed at a different document.
    public func rebound(toDocument document: URL?) -> ResourceRoots {
        ResourceRoots(bundle: bundle, document: document)
    }

    /// The file a request path names, or nil when no root will serve it.
    ///
    /// Roots are tried in order, so the bundle always wins: a document folder
    /// that happens to contain an `index.html` can never shadow the page.
    public func resolve(_ requestPath: String) -> URL? {
        let relative = requestPath.hasPrefix("/") ? String(requestPath.dropFirst()) : requestPath
        guard !relative.isEmpty else { return nil }
        // Refuse before touching the disk: an encoded traversal is a request
        // about a path, not about a file, and there is nothing to resolve.
        guard !relative.split(separator: "/").contains("..") else { return nil }
        for root in [bundle, document].compactMap({ $0 }) {
            if let file = Self.contained(relative, in: root) { return file }
        }
        return nil
    }

    /// `relative` resolved inside `root`, or nil when it escapes or is absent.
    static func contained(_ relative: String, in root: URL) -> URL? {
        let candidate = root.appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: candidate.path) else { return nil }
        // Resolve BOTH sides: a symlinked root (macOS /tmp is one) would fail a
        // prefix test against its own children otherwise, and a symlink inside
        // the root pointing out of it would pass one.
        let resolvedRoot = root.resolvingSymlinksInPath().standardizedFileURL
        let resolved = candidate.resolvingSymlinksInPath().standardizedFileURL
        let rootPath = resolvedRoot.path.hasSuffix("/") ? resolvedRoot.path : resolvedRoot.path + "/"
        return resolved.path.hasPrefix(rootPath) ? resolved : nil
    }
}
