import AppKit
import XCTest
@testable import BirtaWriter
@testable import BirtaWriterCore

/// The page as it is SERVED, which is the only place three of the panel's boot
/// facts exist.
///
/// The CSP, the outline panel's width and its side are template placeholders
/// rather than anything the boot script sets, because the page reads all three
/// while it mounts. That makes the template the seam, and a placeholder is the
/// kind of thing that fails silently: an unfilled `{{ROOT_STYLE}}` is not an
/// error anywhere, it is a line of nonsense in the page's stylesheet that the
/// browser drops, and everything downstream goes on looking correct.
@MainActor
final class WebHostPageTests: XCTestCase {
    /// The real template, so this is about the page that ships rather than a
    /// string written here. A stub would pass with the placeholder deleted from
    /// the file, which is exactly the change this exists to catch.
    private func template() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Resources/index.html")
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func handler() -> BirtaSchemeHandler {
        BirtaSchemeHandler(webRoot: URL(fileURLWithPath: "/tmp"), documentDirectory: nil)
    }

    func testTheServedPageShouldCarryNoUnfilledPlaceholder() throws {
        let source = try template()
        // The template really does have placeholders left to fill, or the
        // assertion below is about a string with nothing in it.
        XCTAssertTrue(source.contains("{{"), "the template has no placeholders; this checks nothing")
        let page = handler().renderPage(source)
        XCTAssertFalse(page.contains("{{"), "a placeholder reached the page unfilled")
    }

    func testAnUntouchedPanelShouldLeaveTheWidthRuleOutRatherThanWriteADefault() throws {
        let page = handler().renderPage(try template())
        XCTAssertFalse(page.contains("--toc-width"),
                       "a width nobody set would override the page's own default")
    }

    func testARememberedWidthShouldReachThePageAsARuleOnTheRootElement() throws {
        let subject = handler()
        subject.tocRootStyle = BootConfig(tocWidth: 320).tocRootStyle
        let page = subject.renderPage(try template())
        XCTAssertTrue(page.contains(":root { --toc-width: 320px; }"), page)
    }

    func testTheDockSideShouldRideTheBodyTagBesideTheThemeClass() throws {
        // Both classes, in one attribute: the theme is still applied, which is
        // what a naive replacement of the whole attribute would lose.
        let source = try template()
        let subject = handler()
        subject.themeClass = "vscode-dark"
        XCTAssertTrue(subject.renderPage(source).contains(#"<body class="vscode-dark toc-right">"#))
    }

    // MARK: - The content-security-policy

    /// Every directive's value, keyed by name, out of the served policy itself
    /// rather than out of `csp()`: the policy only does anything from inside
    /// the page, so the string that reaches the template is the subject.
    private func servedDirectives(networkEnabled: Bool) throws -> [String: String] {
        let subject = handler()
        subject.networkEnabled = networkEnabled
        let page = subject.renderPage(try template())
        guard let open = page.range(of: #"<meta http-equiv="Content-Security-Policy" content=""#),
              let close = page.range(of: "\">", range: open.upperBound..<page.endIndex) else {
            XCTFail("the served page carries no content-security-policy")
            return [:]
        }
        let policy = String(page[open.upperBound..<close.lowerBound])
        var directives: [String: String] = [:]
        for part in policy.split(separator: ";") {
            let fields = part.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            guard let name = fields.first else { continue }
            directives[name] = fields.dropFirst().joined(separator: " ")
        }
        // The parse reached something, or every assertion below is about an
        // empty dictionary and passes by looking at nothing.
        XCTAssertEqual(directives["default-src"], "'none'", policy)
        return directives
    }

    /// A pin on the off state rather than a test of the pinned lists: this one
    /// passes against the policy before the lists existed too, because with
    /// the switch off that policy granted nothing remote either. Said out loud
    /// because a green here is not evidence about the grants, and the two
    /// tests below are what carry that.
    func testTheNetworkSwitchOffShouldLeaveNoRemoteGrantAtAll() throws {
        let directives = try servedDirectives(networkEnabled: false)
        XCTAssertEqual(directives["frame-src"], "'none'")
        for (name, value) in directives {
            XCTAssertFalse(value.contains("http"), "\(name) grants \(value) with the network off")
        }
    }

    func testTheNetworkSwitchOnShouldGrantTheProviderHostsAndNothingWider() throws {
        let directives = try servedDirectives(networkEnabled: true)

        // The lists are not empty, or the equalities below hold for a
        // directive that grants nothing and this checks nothing.
        XCTAssertFalse(EmbedHosts.frameSrc.isEmpty)
        XCTAssertFalse(EmbedHosts.imgSrc.isEmpty)

        // Exactly the pinned hosts: an extra one fails here too, which a
        // per-host `contains` check would not catch.
        XCTAssertEqual(directives["frame-src"], EmbedHosts.frameSrc.joined(separator: " "))
        XCTAssertEqual(directives["img-src"],
                       "'self' data: blob: " + EmbedHosts.imgSrc.joined(separator: " "))

        // The bare scheme is what a pinned list exists instead of. Asked of
        // every directive rather than the two that widen, because the whole
        // point is that no OTHER directive quietly grows one.
        for (name, value) in directives {
            XCTAssertFalse(value.split(separator: " ").contains("https:"),
                           "\(name) grants the whole of https:")
        }
    }

    func testTheDirectivesNothingAsksForShouldNotMoveWithTheNetworkSwitch() throws {
        // The page issues no request of its own on any surface, so these two
        // read the same with the switch either way. They were widened with the
        // rest before anything checked whether they were used.
        for networkEnabled in [false, true] {
            let directives = try servedDirectives(networkEnabled: networkEnabled)
            XCTAssertEqual(directives["connect-src"], "'self'", "network \(networkEnabled)")
            XCTAssertEqual(directives["media-src"], "'self' data:", "network \(networkEnabled)")
        }
    }

    func testTheDockSideShouldBeTheTrailingEdgeWhateverTheTheme() throws {
        // A macOS sidebar is on the trailing edge, and nothing here may put it
        // anywhere else: the page's flip button and the Swap Sides command are
        // both withdrawn (`fixedTocSide`), so a side that could still come back
        // left would leave the reader with a sidebar on the wrong edge and no
        // control to move it. Asked of BOTH themes, because the side rides the
        // same attribute the theme does, and a replacement that dropped one of
        // them would be visible in only one theme.
        let source = try template()
        for theme in ["vscode-light", "vscode-dark"] {
            let subject = handler()
            subject.themeClass = theme
            let page = subject.renderPage(source)
            XCTAssertTrue(page.contains("<body class=\"\(theme) toc-right\">"), page)
        }
    }
}
