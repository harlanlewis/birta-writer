import XCTest
@testable import BirtaWriterCore

/// The rules around the fetch, driven through a fake transport so the cases
/// that matter are reachable: a redirect aimed inward, a chain that loops, a
/// body that is not HTML. None of these can be tested against a real network,
/// which is the reason the transport is a protocol.
final class PageMetadataFetcherTests: XCTestCase {
    /// Answers from a scripted map, and records what it was asked for.
    final class FakeTransport: HttpTransport, @unchecked Sendable {
        var replies: [String: HttpReply] = [:]
        private(set) var requested: [String] = []
        var maxBytesSeen: Int?

        func perform(_ request: URLRequest, maxBytes: Int) async throws -> HttpReply {
            let key = request.url?.absoluteString ?? ""
            requested.append(key)
            maxBytesSeen = maxBytes
            guard let reply = replies[key] else {
                throw NSError(domain: "test", code: 404, userInfo: [NSLocalizedDescriptionKey: "no stub for \(key)"])
            }
            return reply
        }
    }

    private func page(_ html: String, status: Int = 200, type: String? = "text/html") -> HttpReply {
        HttpReply(status: status, location: nil, contentType: type, body: Data(html.utf8))
    }

    private func redirect(to location: String, status: Int = 302) -> HttpReply {
        HttpReply(status: status, location: location, contentType: nil, body: Data())
    }

    private func fetcher(_ transport: FakeTransport,
                         allow: @escaping @Sendable (URL) -> Bool = { _ in true }) -> PageMetadataFetcher {
        PageMetadataFetcher(transport: transport, isAllowed: allow)
    }

    // MARK: the happy path

    func testReadsTitleAndDescription() async {
        let t = FakeTransport()
        t.replies["https://example.com/"] = page("""
        <html><head><meta property="og:title" content="A page">
        <meta property="og:description" content="About the page"></head></html>
        """)

        let meta = await fetcher(t).metadata(for: URL(string: "https://example.com/")!)

        XCTAssertEqual(meta.title, "A page")
        XCTAssertEqual(meta.description, "About the page")
    }

    func testFollowsARedirectAndReadsTheDestination() async {
        let t = FakeTransport()
        t.replies["https://example.com/"] = redirect(to: "https://example.com/final")
        t.replies["https://example.com/final"] = page("<title>Arrived</title>")

        let meta = await fetcher(t).metadata(for: URL(string: "https://example.com/")!)

        XCTAssertEqual(meta.title, "Arrived")
        XCTAssertEqual(t.requested, ["https://example.com/", "https://example.com/final"])
    }

    func testFollowsARelativeRedirect() async {
        let t = FakeTransport()
        t.replies["https://example.com/a"] = redirect(to: "/b")
        t.replies["https://example.com/b"] = page("<title>Relative</title>")

        let meta = await fetcher(t).metadata(for: URL(string: "https://example.com/a")!)

        XCTAssertEqual(meta.title, "Relative")
    }

    // MARK: the rules

    func testEveryHopIsChecked() async {
        // The case the whole design is for: a host that passes the check and
        // then sends the fetch somewhere it would never have been allowed.
        let t = FakeTransport()
        t.replies["https://example.com/"] = redirect(to: "http://169.254.169.254/latest/meta-data/")
        t.replies["http://169.254.169.254/latest/meta-data/"] = page("<title>secrets</title>")
        let blockMetadata: @Sendable (URL) -> Bool = { $0.host != "169.254.169.254" }

        let meta = await fetcher(t, allow: blockMetadata).metadata(for: URL(string: "https://example.com/")!)

        XCTAssertTrue(meta.isEmpty)
        XCTAssertFalse(t.requested.contains("http://169.254.169.254/latest/meta-data/"),
                       "the refused host must never be contacted")
    }

    func testTheFirstUrlIsCheckedToo() async {
        let t = FakeTransport()
        t.replies["http://localhost:8080/"] = page("<title>admin</title>")

        let meta = await fetcher(t, allow: { _ in false }).metadata(for: URL(string: "http://localhost:8080/")!)

        XCTAssertTrue(meta.isEmpty)
        XCTAssertEqual(t.requested, [], "nothing may go on the wire when the first check fails")
    }

    func testARedirectLoopEndsRatherThanSpinning() async {
        let t = FakeTransport()
        t.replies["https://a.example/"] = redirect(to: "https://b.example/")
        t.replies["https://b.example/"] = redirect(to: "https://a.example/")

        let meta = await fetcher(t).metadata(for: URL(string: "https://a.example/")!)

        XCTAssertTrue(meta.isEmpty)
        XCTAssertEqual(t.requested.count, 2, "a URL already visited is not fetched again")
    }

    func testAChainLongerThanTheLimitGivesUp() async {
        let t = FakeTransport()
        for i in 0...20 {
            t.replies["https://example.com/\(i)"] = redirect(to: "https://example.com/\(i + 1)")
        }

        let meta = await fetcher(t).metadata(for: URL(string: "https://example.com/0")!)

        XCTAssertTrue(meta.isEmpty)
        XCTAssertLessThanOrEqual(t.requested.count, PageMetadataFetcher.maxRedirects + 1)
    }

    func testANonHtmlBodyIsNotParsed() async {
        let t = FakeTransport()
        t.replies["https://example.com/x.pdf"] = page("<title>not really</title>", type: "application/pdf")

        let meta = await fetcher(t).metadata(for: URL(string: "https://example.com/x.pdf")!)

        XCTAssertTrue(meta.isEmpty)
    }

    func testAnErrorStatusYieldsNothing() async {
        let t = FakeTransport()
        t.replies["https://example.com/"] = page("<title>error page</title>", status: 500)

        let meta = await fetcher(t).metadata(for: URL(string: "https://example.com/")!)
        XCTAssertTrue(meta.isEmpty)
    }

    func testATransportFailureYieldsNothingRatherThanThrowing() async {
        let t = FakeTransport() // no stubs, so every request throws

        let meta = await fetcher(t).metadata(for: URL(string: "https://example.com/")!)
        XCTAssertTrue(meta.isEmpty)
    }

    func testARedirectWithNoLocationStops() async {
        let t = FakeTransport()
        t.replies["https://example.com/"] = HttpReply(status: 302, location: nil, contentType: nil, body: Data())

        let meta = await fetcher(t).metadata(for: URL(string: "https://example.com/")!)
        XCTAssertTrue(meta.isEmpty)
    }

    func testAByteCapIsHandedToTheTransport() async {
        let t = FakeTransport()
        t.replies["https://example.com/"] = page("<title>x</title>")

        _ = await fetcher(t).metadata(for: URL(string: "https://example.com/")!)

        XCTAssertEqual(t.maxBytesSeen, PageMetadataFetcher.maxBytes)
    }

    func testTitleOnlyIsTheSameFetch() async {
        let t = FakeTransport()
        t.replies["https://example.com/"] = page("<title>Just this</title>")

        let title = await fetcher(t).title(for: URL(string: "https://example.com/")!)
        XCTAssertEqual(title, "Just this")
    }
}
