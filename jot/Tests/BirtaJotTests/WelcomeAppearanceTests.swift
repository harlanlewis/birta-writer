import AppKit
import BirtaJotCore
import XCTest
@testable import BirtaJot

/// How the first-run screen LOOKS, for the two things about it that are
/// decidable rather than a matter of taste.
///
/// `WelcomeScreenTests` asserts which rows are drawn. This asserts the two
/// claims that were reported as defects and could not be caught by a row list:
/// the screen has a ground in both appearances, and the gaps between its cards
/// are equal.
///
/// The spacing one is worth the file on its own. The bug it pins was a rule
/// copied from Settings, where a heading and a card alternate down the pane and
/// every second gap starts a new section. This screen draws no headings, so
/// every arranged view is a card, and the same rule put one gap at 8 and the
/// next at 18: three groups, two gaps, visibly unequal. Nothing about that is
/// visible in a list of rows, and nothing about it is visible in a number
/// unless the number is the one compared here.
@MainActor
final class WelcomeAppearanceTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    private func made() -> WelcomeView {
        let welcome = WelcomeView(onHotkeyChange: { 0 })
        welcome.frame = NSRect(x: 0, y: 0, width: 520, height: 720)
        welcome.layoutSubtreeIfNeeded()
        return welcome
    }

    /// The stack holding the group cards: the one vertical stack whose
    /// arranged views are all `NSBox`. Found by shape rather than by walking a
    /// fixed number of superviews, so a container added around it does not
    /// silently make this test measure something else.
    private func cardStack(in view: NSView) -> NSStackView? {
        if let stack = view as? NSStackView, stack.orientation == .vertical,
           stack.arrangedSubviews.count >= 2,
           stack.arrangedSubviews.allSatisfy({ $0 is NSBox }) {
            return stack
        }
        for subview in view.subviews {
            if let found = cardStack(in: subview) { return found }
        }
        return nil
    }

    func testTheGapsBetweenTheGroupsShouldBeEqual() {
        let welcome = made()
        guard let stack = cardStack(in: welcome) else {
            return XCTFail("no stack of group cards found on the first-run screen")
        }
        // A floor, so this cannot pass by finding a stack with one gap in it.
        XCTAssertGreaterThanOrEqual(stack.arrangedSubviews.count, 3,
                                    "the first-run screen no longer has three groups to compare")
        let cards = stack.arrangedSubviews.sorted { $0.frame.minY < $1.frame.minY }
        let gaps = zip(cards, cards.dropFirst()).map { $1.frame.minY - $0.frame.maxY }
        XCTAssertEqual(gaps.count, cards.count - 1)
        for gap in gaps {
            XCTAssertGreaterThan(gap, 0, "two group cards are touching or overlapping")
            XCTAssertEqual(gap, gaps[0], accuracy: 0.5,
                           "the gaps between the groups are unequal: "
                           + gaps.map { String(format: "%.1f", $0) }.joined(separator: ", "))
        }
    }

    /// The screen paints its own ground, and a DIFFERENT one in each
    /// appearance.
    ///
    /// Both halves matter. A screen that paints nothing shows whatever is
    /// behind it, and a screen that paints one colour in both appearances is
    /// the cream-in-dark-mode complaint this changed.
    func testTheBrandPaperShouldDifferBetweenLightAndDark() {
        let light = paper(.aqua)
        let dark = paper(.darkAqua)
        XCTAssertNotEqual(light, dark, "the first-run screen paints one ground in both appearances")
        // The mark's own grounds, taken from the artwork rather than chosen to
        // go with it. Asserted as values because they are what makes the join
        // between the squircle and the page invisible.
        XCTAssertEqual(light.hex, "F3EFE3")
        XCTAssertEqual(dark.hex, "373D34")
    }

    private func paper(_ name: NSAppearance.Name) -> NSColor {
        var resolved = NSColor.clear
        NSAppearance(named: name)!.performAsCurrentDrawingAppearance {
            resolved = WelcomeView.brandPaperForTesting.usingColorSpace(.sRGB) ?? .clear
        }
        return resolved
    }

    /// Renders both appearances to `/tmp` when asked, for a person to look at.
    ///
    /// Off unless `BIRTA_JOT_WRITE_SHOTS=1`, because writing files is not what
    /// a test run is for. `screencapture` needs a Screen Recording grant this
    /// repository's checks do not have, so asking the view to draw itself is
    /// the only way to get the image at all. Bezeled controls come out blank
    /// through this path, which is a limit of the drawing and not a missing
    /// control: the row list is what says a control is present.
    func testWriteAppearanceShots() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["BIRTA_JOT_WRITE_SHOTS"] == "1")
        for (name, label) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
            let welcome = made()
            welcome.appearance = NSAppearance(named: name)
            welcome.layoutSubtreeIfNeeded()
            let bounds = welcome.bounds
            var data: Data?
            NSAppearance(named: name)!.performAsCurrentDrawingAppearance {
                let pdf = welcome.dataWithPDF(inside: bounds)
                guard let image = NSImage(data: pdf) else { return }
                let rendered = NSImage(size: bounds.size)
                rendered.lockFocus()
                image.draw(in: bounds)
                rendered.unlockFocus()
                data = rendered.tiffRepresentation
                    .flatMap { NSBitmapImageRep(data: $0) }
                    .flatMap { $0.representation(using: .png, properties: [:]) }
            }
            try XCTUnwrap(data).write(to: URL(fileURLWithPath: "/tmp/jot-welcome-\(label).png"))
        }
    }
}

private extension NSColor {
    /// `RRGGBB`, for an assertion that reads as the colour it is about.
    var hex: String {
        let srgb = usingColorSpace(.sRGB) ?? self
        return String(format: "%02X%02X%02X",
                      Int((srgb.redComponent * 255).rounded()),
                      Int((srgb.greenComponent * 255).rounded()),
                      Int((srgb.blueComponent * 255).rounded()))
    }
}
