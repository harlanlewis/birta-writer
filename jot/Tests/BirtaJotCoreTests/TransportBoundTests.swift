import XCTest
@testable import BirtaJotCore

/// The one property of `URLSessionTransport` no fake transport can check.
///
/// Every other rule around the fetch is tested through `HttpTransport`, which
/// is the point of that protocol. The byte cap is different: it is a property
/// of the real transport's own reading, so the only thing a test here can hold
/// is HOW it reads, and it is worth holding because the wrong way looks
/// correct. `session.data(for:)` followed by `.prefix(maxBytes)` truncates
/// what gets PARSED and buffers the whole response first, so a host that
/// streams without end is bounded only by the resource timeout.
///
/// The reason this was invisible is the part worth keeping: a bound applied to
/// the RESULT reads the same as a bound applied to the READING, in review and
/// in every test that supplies a fake transport, because the fake never streams
/// more than it was told to. Point the real transport at a page that never ends
/// and ask how much arrived; that is the only question that separates them.
final class TransportBoundTests: XCTestCase {
    private func transportSource() throws -> String {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/BirtaJotCore/PageMetadata.swift")
        return try String(contentsOf: file, encoding: .utf8)
    }

    func testTheRealTransportStreamsAndStopsAtTheCap() throws {
        let source = try transportSource()
        // The instrument reached the right file.
        XCTAssertTrue(source.contains("final class URLSessionTransport"), "wrong file")

        XCTAssertTrue(source.contains("session.bytes(for: request)"),
                      "the transport must stream, so it can stop reading at the cap")
        XCTAssertTrue(source.contains("if body.count >= maxBytes { break }"),
                      "streaming without a break at the cap bounds nothing")
        XCTAssertTrue(source.contains("stream.task.cancel()"),
                      "the transfer must be cancelled once there is enough")
        XCTAssertFalse(source.contains("session.data(for:"),
                       "buffering the whole response makes the cap cosmetic")
    }

    func testTheCapAndTheDeadlineAreBothSmallEnoughToMeanSomething() {
        // A cap large enough to hurt, or a deadline long enough to hang a
        // paste, would satisfy the check above and still be wrong.
        XCTAssertLessThanOrEqual(PageMetadataFetcher.maxBytes, 2 * 1024 * 1024)
        XCTAssertLessThanOrEqual(PageMetadataFetcher.timeout, 10)
        XCTAssertLessThanOrEqual(PageMetadataFetcher.maxRedirects, 10)
    }
}
