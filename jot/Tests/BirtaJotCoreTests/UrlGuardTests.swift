import XCTest
@testable import BirtaJotCore

/// The Swift half of a guard that exists twice. The cases come from
/// `shared/__fixtures__/urlGuardCases.json`, which `src/__tests__/urlGuard.test.ts`
/// reads too, so a rule only one side enforces fails here rather than sitting
/// undiscovered in whichever implementation was not updated.
final class UrlGuardTests: XCTestCase {
    private struct Cases: Decodable {
        let privateIps: [[Fixture]]
        let blockedHostnames: [[Fixture]]
    }

    /// A case row is `[value, expected, why]`, so its elements are of mixed
    /// type; this reads whichever one is there.
    private enum Fixture: Decodable {
        case text(String)
        case flag(Bool)

        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let b = try? c.decode(Bool.self) { self = .flag(b); return }
            self = .text(try c.decode(String.self))
        }

        var string: String { if case let .text(s) = self { return s }; return "" }
        var bool: Bool { if case let .flag(b) = self { return b }; return false }
    }

    private func loadCases() throws -> Cases {
        // From this file to the repository root: Tests/BirtaJotCoreTests -> jot -> repo.
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let file = root.appendingPathComponent("shared/__fixtures__/urlGuardCases.json")
        return try JSONDecoder().decode(Cases.self, from: Data(contentsOf: file))
    }

    func testPrivateAddressCasesFromTheSharedFixture() throws {
        let cases = try loadCases()
        // The instrument has to have measured something: an unreadable or
        // emptied fixture would otherwise pass this file in silence.
        XCTAssertGreaterThanOrEqual(cases.privateIps.count, 25,
                                    "the shared fixture lost its cases")
        for row in cases.privateIps {
            let (ip, expected, why) = (row[0].string, row[1].bool, row[2].string)
            XCTAssertEqual(UrlGuard.isPrivateIP(ip), expected, "\(ip): \(why)")
        }
    }

    func testBlockedHostnameCasesFromTheSharedFixture() throws {
        let cases = try loadCases()
        XCTAssertGreaterThanOrEqual(cases.blockedHostnames.count, 8,
                                    "the shared fixture lost its cases")
        for row in cases.blockedHostnames {
            let (host, expected, why) = (row[0].string, row[1].bool, row[2].string)
            XCTAssertEqual(UrlGuard.isBlockedHostname(host), expected, "\(host): \(why)")
        }
    }

    // MARK: the URL-level rule

    private func refuseResolve(_ host: String) -> [String] {
        XCTFail("DNS must not be consulted for \(host)")
        return []
    }

    func testAnIPLiteralIsJudgedWithoutDNS() {
        XCTAssertFalse(UrlGuard.isPubliclyRoutable(URL(string: "http://192.168.1.1/")!, resolve: refuseResolve))
        XCTAssertTrue(UrlGuard.isPubliclyRoutable(URL(string: "http://8.8.8.8/")!, resolve: refuseResolve))
        XCTAssertFalse(UrlGuard.isPubliclyRoutable(URL(string: "http://[::1]/")!, resolve: refuseResolve))
    }

    func testTheManySpellingsOfALocalAddressAreAllRefused() {
        for spelling in ["http://[::ffff:127.0.0.1]/",
                         "http://[::ffff:169.254.169.254]/",
                         "http://[::ffff:192.168.0.1]/",
                         "http://[64:ff9b::7f00:1]/",
                         "http://[0:0:0:0:0:ffff:7f00:1]/"] {
            XCTAssertFalse(UrlGuard.isPubliclyRoutable(URL(string: spelling)!, resolve: refuseResolve), spelling)
        }
        XCTAssertTrue(UrlGuard.isPubliclyRoutable(URL(string: "http://[2606:4700::6810:84e5]/")!, resolve: refuseResolve))
    }

    func testABlockedNameIsRefusedBeforeDNS() {
        XCTAssertFalse(UrlGuard.isPubliclyRoutable(URL(string: "http://localhost:3000/")!, resolve: refuseResolve))
    }

    func testOnePrivateAnswerPoisonsTheWholeSet() {
        let mixed = { (_: String) in ["93.184.216.34", "10.0.0.5"] }
        XCTAssertFalse(UrlGuard.isPubliclyRoutable(URL(string: "https://evil.example")!, resolve: mixed))
    }

    func testAV4MappedAnswerIsJudgedByItsV4() {
        let mapped = { (_: String) in ["::ffff:10.0.0.5"] }
        XCTAssertFalse(UrlGuard.isPubliclyRoutable(URL(string: "https://sneaky.example")!, resolve: mapped))
    }

    func testAPublicOnlyAnswerIsAllowed() {
        let public4 = { (_: String) in ["93.184.216.34"] }
        XCTAssertTrue(UrlGuard.isPubliclyRoutable(URL(string: "https://example.com")!, resolve: public4))
    }

    func testNoAnswerFailsClosed() {
        let none = { (_: String) in [String]() }
        XCTAssertFalse(UrlGuard.isPubliclyRoutable(URL(string: "https://nope.example")!, resolve: none))
    }

    func testOnlyHttpAndHttpsAreFetchable() {
        let any = { (_: String) in ["93.184.216.34"] }
        for scheme in ["file:///etc/passwd", "ftp://example.com/x", "birta://app/index.html",
                       "javascript:alert(1)", "data:text/html,hi"] {
            XCTAssertFalse(UrlGuard.isPubliclyRoutable(URL(string: scheme)!, resolve: any), scheme)
        }
        XCTAssertTrue(UrlGuard.isPubliclyRoutable(URL(string: "http://example.com")!, resolve: any))
        XCTAssertTrue(UrlGuard.isPubliclyRoutable(URL(string: "https://example.com")!, resolve: any))
    }

    func testAScopedLinkLocalAnswerIsStillRefused() {
        // getaddrinfo hands back fe80::1%en0 for a link-local answer, and the
        // scope has to come off before the address can be classified.
        let scoped = { (_: String) in ["fe80::1%en0"] }
        XCTAssertFalse(UrlGuard.isPubliclyRoutable(URL(string: "https://scoped.example")!, resolve: {
            scoped($0).map { $0.split(separator: "%").first.map(String.init) ?? $0 }
        }))
    }
}
