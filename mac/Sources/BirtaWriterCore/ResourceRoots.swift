import Foundation

/// Which files the page is allowed to read, and the only place that question is
/// answered.
///
/// The page needs two kinds of file: its own bundle, and the images the open
/// document references, read from the note's folder and, in a rooted window,
/// from the folder the window is opened on. A relative image path reaches the
/// second kind through the document namespace (`documentNamespace`), which is
/// how `../` keeps its meaning. The second one is document-controlled input, so it is
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
    /// The folder a rooted window is opened on, or nil for a loose file.
    /// Tried after `document`, so a note in a subfolder finds the image beside
    /// it (what every Markdown renderer means by a relative path) and an
    /// image written relative to the root still resolves.
    public let project: URL?

    /// The note's folder as a path below the project root ("" when it IS the
    /// root), or nil when there is no project or the note is outside it.
    /// Worked out once, here, because every document request reads it.
    let documentPathInProject: String?

    public init(bundle: URL, document: URL?, project: URL? = nil) {
        self.bundle = bundle
        self.document = document
        self.project = project
        self.documentPathInProject = Self.path(of: document, below: project)
    }

    /// Same roots, pointed at a different document. The project root is kept:
    /// it is what the window is opened on, and a new file does not change it.
    public func rebound(toDocument document: URL?) -> ResourceRoots {
        ResourceRoots(bundle: bundle, document: document, project: project)
    }

    /// The first path segment of the document namespace. A request under it
    /// names a document resource by its path from `documentScopeRoot`, so a
    /// relative image path keeps its `..` (the page resolves it against
    /// `documentBasePath`, `webview/components/imageView/documentBase.ts`).
    /// Nothing in the bundle is named this, and a request under it is never
    /// answered from the bundle.
    public static let documentNamespace = "~doc"

    /// The folder document paths are measured from: the project root when the
    /// note is inside it, otherwise the note's own folder.
    var documentScopeRoot: URL? {
        documentPathInProject != nil ? project : document
    }

    /// `folder` as a path below `root`, found by walking up from `folder`
    /// until a directory IS `root`. Identity rather than spelling: APFS is
    /// case- and normalization-insensitive by default, so the same folder can
    /// be named `Notes` by one route and `notes` by another, and a prefix test
    /// on the strings would put a note outside the folder it is in. The part
    /// below keeps the note's own spelling, which the base is built from and
    /// requests come back in.
    static func path(of folder: URL?, below root: URL?) -> String? {
        guard let folder, let root,
              let rootID = Self.identity(of: root.resolvingSymlinksInPath()) else { return nil }
        var below: [String] = []
        var current = folder.resolvingSymlinksInPath().standardizedFileURL
        while true {
            if let id = Self.identity(of: current), id.isEqual(rootID) {
                return below.reversed().joined(separator: "/")
            }
            guard current.pathComponents.count > 1 else { return nil }
            below.append(current.lastPathComponent)
            current = current.deletingLastPathComponent().standardizedFileURL
        }
    }

    private static func identity(of url: URL) -> NSObjectProtocol? {
        try? url.resourceValues(forKeys: [.fileResourceIdentifierKey]).fileResourceIdentifier as? NSObjectProtocol
    }

    /// The URL path of the note's folder in the document namespace, ending in
    /// `/` and percent-encoded, or nil with no document. The page resolves a
    /// relative image path against it.
    public var documentBasePath: String? {
        guard document != nil else { return nil }
        let below = (documentPathInProject ?? "").split(separator: "/").map {
            String($0).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0)
        }
        return "/" + ([Self.documentNamespace] + below).joined(separator: "/") + "/"
    }

    /// What the page's `init` carries as `documentBase`: the note folder's URL
    /// and the namespace's, both on the page's own origin, or nil with no
    /// document (the page then uses paths as written).
    public func documentBase(origin: URL) -> DocumentBase? {
        guard let path = documentBasePath,
              let url = URL(string: path, relativeTo: origin)?.absoluteString,
              let scope = URL(string: "/\(Self.documentNamespace)/", relativeTo: origin)?.absoluteString
        else { return nil }
        return DocumentBase(url: url, scope: scope)
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
        let prefix = Self.documentNamespace + "/"
        if relative.hasPrefix(prefix) {
            return resolveDocumentPath(String(relative.dropFirst(prefix.count)))
        }
        for root in [bundle, document, project].compactMap({ $0 }) {
            if let file = Self.contained(relative, in: root) { return file }
        }
        return nil
    }

    /// A path from `documentScopeRoot`, as the page resolved it. When it names
    /// nothing and the note sits below the root, the part below the note's
    /// folder is tried against the root too, so an image written relative to
    /// the root (an `Attachments` folder at the top) still resolves.
    private func resolveDocumentPath(_ path: String) -> URL? {
        guard !path.isEmpty, let scope = documentScopeRoot else { return nil }
        if let file = Self.contained(path, in: scope) { return file }
        guard let project, let below = documentPathInProject, !below.isEmpty,
              path.hasPrefix(below + "/") else { return nil }
        return Self.contained(String(path.dropFirst(below.count + 1)), in: project)
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

/// The page's `DocumentBase` (`shared/messages.ts`): where a relative image
/// path is resolved, and the prefix it may not climb out of.
public struct DocumentBase: Equatable, Sendable {
    public let url: String
    public let scope: String

    public init(url: String, scope: String) {
        self.url = url
        self.scope = scope
    }
}
