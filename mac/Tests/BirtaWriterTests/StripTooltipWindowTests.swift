import AppKit
import XCTest
@testable import BirtaWriter
@testable import BirtaWriterCore

/// The chip as AppKit ends up holding it: where it lands on screen, and the
/// things a window must not do while it is pretending to be a tooltip.
@MainActor
final class StripTooltipWindowTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    /// A window wholly inside the screen's visible area, whichever screen the
    /// suite is on. AppKit keeps every window, the chip's borderless panel
    /// included, inside that area, so a fixture hanging past its top (a small
    /// runner display) would have the chip pushed down by the overhang and the
    /// geometry below would be measuring the screen rather than the code.
    private func parent() -> NSWindow {
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1024, height: 700)
        let content = NSRect(x: visible.minX + 20, y: visible.minY + 20,
                             width: min(800, visible.width - 40), height: min(400, visible.height - 80))
        let window = NSWindow(contentRect: content,
                              styleMask: [.titled, .fullSizeContentView],
                              backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        return window
    }

    private let sample = StripTooltip(
        text: "Open…  ⌘O",
        anchor: CGRect(x: 300, y: 5, width: 26, height: 24),
        gap: 6,
        style: .init(background: CSSColor(red: 0, green: 0, blue: 0),
                     ink: CSSColor(red: 1, green: 1, blue: 1),
                     fontSize: 12, radius: 5, padX: 8, padY: 4))

    func testTheChipShouldLandUnderItsControlInScreenCoordinates() throws {
        let window = parent()
        defer { window.close() }
        let chip = StripTooltipWindow()
        chip.show(sample, over: window)
        defer { chip.hide() }
        let frame = try XCTUnwrap(chip.frameForMeasurement)
        // The page's y grows downward from the window's top edge; the screen's
        // grows upward. The chip's TOP is the anchor's bottom plus the gap.
        XCTAssertEqual(frame.maxY, window.frame.maxY - (5 + 24 + 6))
        XCTAssertEqual(frame.midX, window.frame.minX + 313, accuracy: 1)
        XCTAssertEqual(frame.height, ceil(12 * StripTooltipWindow.lineHeight) + 8)
        XCTAssertGreaterThan(frame.width, 16, "padding alone: the words were not measured")
    }

    func testTheChipShouldNeverActLikeAWindow() throws {
        let window = parent()
        defer { window.close() }
        let chip = StripTooltipWindow()
        chip.show(sample, over: window)
        defer { chip.hide() }
        let made = try XCTUnwrap(chip.windowForMeasurement)
        XCTAssertTrue(made.ignoresMouseEvents, "a click meant for a tab under the chip must reach the tab")
        XCTAssertEqual(made.tabbingMode, .disallowed, "or macOS offers it a place in the tab group it is drawn over")
        XCTAssertTrue(made.isExcludedFromWindowsMenu)
        XCTAssertFalse(made.canBecomeKey)
        XCTAssertTrue(made.parent === window, "a child window travels with its parent; a loose one is left behind by a drag")
    }

    func testShownOverATabbedWindowTheChipShouldStayOutOfTheTabGroup() throws {
        // The case the chip exists for: its parent HAS a tab bar. A window made
        // and ordered in while its parent is tabbed is what macOS offers a tab
        // to, and a tooltip that became a tab would be the worst available
        // outcome, so the group is counted before and after.
        let first = parent()
        let second = parent()
        first.tabbingMode = .preferred
        second.tabbingMode = .preferred
        first.addTabbedWindow(second, ordered: .above)
        defer { second.close(); first.close() }
        let before = try XCTUnwrap(first.tabGroup?.windows.count)
        XCTAssertEqual(before, 2, "the fixture is not a tabbed window, so this would pass for no reason")

        let chip = StripTooltipWindow()
        chip.show(sample, over: first)
        defer { chip.hide() }
        let made = try XCTUnwrap(chip.windowForMeasurement)
        XCTAssertEqual(first.tabGroup?.windows.count, before)
        XCTAssertFalse(first.tabGroup?.windows.contains(made) ?? true)
        XCTAssertNil(made.tabGroup?.windows.first { $0 !== made },
                     "the chip has joined a tab group of its own with some other window in it")
    }

    func testTakingItAwayShouldLeaveNothingAttached() {
        let window = parent()
        defer { window.close() }
        let chip = StripTooltipWindow()
        chip.show(sample, over: window)
        chip.show(nil, over: window)
        XCTAssertNil(chip.frameForMeasurement)
        XCTAssertTrue((window.childWindows ?? []).isEmpty)
    }

    func testTearingDownShouldLeaveNoWindowBehind() {
        let window = parent()
        defer { window.close() }
        let chip = StripTooltipWindow()
        weak var made: NSWindow?
        // Inside a pool of its own, because AppKit autoreleases a window it
        // has just ordered around, and a reference held until the end of the
        // test's own turn would report a leak that is not there.
        autoreleasepool {
            chip.show(sample, over: window)
            made = chip.windowForMeasurement
            XCTAssertNotNil(made, "the fixture never made a panel, so nothing below is measured")
            chip.tearDown()
            XCTAssertNil(chip.windowForMeasurement)
            XCTAssertTrue((window.childWindows ?? []).isEmpty)
        }
        // Nothing holds it once the chip lets go: `isReleasedWhenClosed` is
        // off, so this is the one owner and the panel goes with it.
        XCTAssertNil(made, "the panel outlived the window it served")
    }

    func testTheLineBoxShouldBeTheStylesheets() throws {
        // The one number about the chip's look that does not travel with the
        // request. Read out of the rule rather than restated, and the rule is
        // asserted to have been FOUND, so a renamed class fails here instead
        // of comparing against nothing.
        let css = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .deletingLastPathComponent()  // repo
            .appendingPathComponent("webview/style.css"), encoding: .utf8)
        let rule = try XCTUnwrap(css.range(of: "\n.custom-tooltip {"), "the chip's rule has moved")
        let body = css[rule.upperBound...].prefix { $0 != "}" }
        let declared = try XCTUnwrap(body.range(of: "line-height:"), "the chip's rule sets no line height")
        let value = body[declared.upperBound...].prefix { $0 != ";" }.trimmingCharacters(in: .whitespaces)
        XCTAssertEqual(Double(value).map { CGFloat($0) }, StripTooltipWindow.lineHeight)
    }
}
