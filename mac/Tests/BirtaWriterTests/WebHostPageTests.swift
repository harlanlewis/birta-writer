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
