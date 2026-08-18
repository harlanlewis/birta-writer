import Foundation

/// What a page said about itself, for a link card or a pasted link's title.
public struct PageMetadata: Equatable, Sendable {
    public let title: String?
    public let description: String?

    public init(title: String?, description: String?) {
        self.title = title
        self.description = description
    }

    /// Nothing usable came back. The caller shows the plain link.
    public static let none = PageMetadata(title: nil, description: nil)
    public var isEmpty: Bool { title == nil && description == nil }
}

/// One HTTP exchange, as the fetcher needs it. A protocol rather than a direct
/// URLSession call so the rules above it (redirect limits, host checks on every
/// hop, byte and time bounds) are testable without a network, which is the only
/// way to test the cases that matter: a redirect to localhost, a page that
/// never ends, a chain that loops.
public protocol HttpTransport: Sendable {
    /// Perform ONE request and do not follow redirects. A 3xx is returned as a
    /// response like any other; following it is the fetcher's decision to make,
    /// because it is the fetcher that re-checks the destination.
    func perform(_ request: URLRequest, maxBytes: Int) async throws -> HttpReply
}

public struct HttpReply: Sendable {
    public let status: Int
    public let location: String?
    public let contentType: String?
    public let body: Data

    public init(status: Int, location: String?, contentType: String?, body: Data) {
        self.status = status
        self.location = location
        self.contentType = contentType
        self.body = body
    }
}

/// Fetches the metadata behind a link, under the rules NETWORK_POSTURE.md
/// describes for rung 1: the URL the user typed goes to its own host, and to
/// the host it redirects to, and nowhere else.
///
/// Every rule here exists because the input is a URL out of a document:
///
///  - http(s) only, and the SSRF guard, on the ORIGINAL url and on every
///    redirect hop, since a public host that 302s to 169.254.169.254 is the
///    ordinary way past a check made only once;
///  - a redirect limit, so a chain cannot run forever;
///  - a byte cap, so a page that never ends cannot exhaust memory;
///  - a deadline, so a host that accepts and stalls cannot hold a request open;
///  - HTML only: a `content-type` that is not HTML is not parsed at all.
///
/// It never throws at the caller. Every failure is `PageMetadata.none`, because
/// every failure has the same remedy: show the plain link. A card that cannot
/// be built is not an error the user did anything about.
public struct PageMetadataFetcher: Sendable {
    public static let maxRedirects = 5
    public static let maxBytes = 512 * 1024
    public static let timeout: TimeInterval = 6

    let transport: HttpTransport
    let isAllowed: @Sendable (URL) -> Bool

    public init(transport: HttpTransport,
                isAllowed: @escaping @Sendable (URL) -> Bool = { UrlGuard.isPubliclyRoutable($0) }) {
        self.transport = transport
        self.isAllowed = isAllowed
    }

    /// The page's title and description, or `.none`.
    public func metadata(for url: URL) async -> PageMetadata {
        guard let html = await fetchHtml(for: url) else { return .none }
        return PageMetadata(title: OpenGraph.title(in: html),
                            description: OpenGraph.description(in: html))
    }

    /// The page's title alone, which is all paste-unfurl needs.
    public func title(for url: URL) async -> String? {
        await metadata(for: url).title
    }

    /// Follow the request to its end and return the HTML, or nil.
    private func fetchHtml(for url: URL) async -> String? {
        var current = url
        var seen: Set<URL> = []
        for _ in 0...Self.maxRedirects {
            guard isAllowed(current) else { return nil }
            // A chain that returns to a URL it already visited is a loop, and
            // the hop limit alone would spend every hop discovering that.
            guard seen.insert(current).inserted else { return nil }
            var request = URLRequest(url: current)
            request.timeoutInterval = Self.timeout
            request.httpMethod = "GET"
            // Ask for HTML. A server that offers something else in spite of
            // this is refused below on the content type it actually sent.
            request.setValue("text/html,application/xhtml+xml", forHTTPHeaderField: "Accept")
            guard let reply = try? await transport.perform(request, maxBytes: Self.maxBytes) else {
                return nil
            }
            if (300...399).contains(reply.status) {
                guard let location = reply.location,
                      let next = URL(string: location, relativeTo: current)?.absoluteURL else { return nil }
                current = next
                continue
            }
            guard reply.status == 200 else { return nil }
            let type = (reply.contentType ?? "").lowercased()
            guard type.isEmpty || type.contains("html") else { return nil }
            return String(data: reply.body, encoding: .utf8)
                ?? String(decoding: reply.body, as: UTF8.self)
        }
        return nil
    }
}

/// The real transport. Redirects are turned off at the session level so the
/// fetcher sees each hop and can check where it is being sent.
public final class URLSessionTransport: NSObject, HttpTransport, URLSessionTaskDelegate, @unchecked Sendable {
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpCookieAcceptPolicy = .never
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = PageMetadataFetcher.timeout
        config.timeoutIntervalForResource = PageMetadataFetcher.timeout
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    public override init() { super.init() }

    public func perform(_ request: URLRequest, maxBytes: Int) async throws -> HttpReply {
        // STREAMED, and stopped at the cap. `data(for:)` would buffer the whole
        // response before anything could be truncated, so a host that streams
        // without end is bounded only by the resource timeout, and on a fast
        // link that is a great many megabytes held in memory for a link card.
        // The extension has the same property for the same reason
        // (src/utils/cappedRead.ts); this is that, in Swift.
        let (stream, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            stream.task.cancel()
            return HttpReply(status: 0, location: nil, contentType: nil, body: Data())
        }
        var body = Data()
        body.reserveCapacity(min(maxBytes, 64 * 1024))
        do {
            for try await byte in stream {
                body.append(byte)
                if body.count >= maxBytes { break }
            }
        } catch {
            // A body that failed midway is still worth parsing: a title lives
            // near the top of <head>, and half a page is not nothing.
        }
        // Stop the transfer as soon as there is enough, rather than letting the
        // rest of a large page arrive unread.
        stream.task.cancel()
        return HttpReply(
            status: http.statusCode,
            location: http.value(forHTTPHeaderField: "Location"),
            contentType: http.value(forHTTPHeaderField: "Content-Type"),
            body: body)
    }

    /// Refuse to follow redirects here: the fetcher follows them itself, so
    /// that each destination is checked before it is contacted.
    public func urlSession(_ session: URLSession, task: URLSessionTask,
                           willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest,
                           completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
