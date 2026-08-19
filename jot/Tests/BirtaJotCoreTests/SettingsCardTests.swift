import AppKit
import XCTest

/// Why Jot's settings cards are not painted with `controlBackgroundColor`.
///
/// The obvious colour for a card on a window is `controlBackgroundColor`, and
/// on this OS it resolves to exactly `windowBackgroundColor` in both
/// appearances, so a card painted with it cannot be seen at all. That is a
/// property of the system rather than of our code, which is why it is asserted
/// here rather than written into a comment as a number: a figure in a comment
/// rots in silence, and this one has a real chance of changing.
///
/// A failure here is GOOD NEWS, not a break. It means the two colours have
/// separated, the system now has a real card ground, and
/// `SettingsWindowController.settingsCard` can go back to the simple answer.
final class SettingsCardTests: XCTestCase {
    private func rgb(_ color: NSColor, _ appearance: NSAppearance) -> [CGFloat] {
        var out: [CGFloat] = []
        appearance.performAsCurrentDrawingAppearance {
            let c = color.usingColorSpace(.sRGB)!
            out = [c.redComponent, c.greenComponent, c.blueComponent]
        }
        return out
    }

    func testControlBackgroundShouldStillBeIndistinguishableFromTheWindowGround() {
        for name in [NSAppearance.Name.aqua, .darkAqua] {
            let appearance = NSAppearance(named: name)!
            let window = rgb(.windowBackgroundColor, appearance)
            let control = rgb(.controlBackgroundColor, appearance)
            XCTAssertEqual(window.count, 3)
            for (w, c) in zip(window, control) {
                XCTAssertEqual(
                    w, c, accuracy: 0.001,
                    "\(name.rawValue): controlBackgroundColor and windowBackgroundColor have separated; "
                    + "settingsCard can go back to controlBackgroundColor")
            }
        }
    }

    /// The lift has to be visible in BOTH appearances, and in opposite
    /// directions: darker on a light window, lighter on a dark one. A single
    /// opaque colour cannot do that, which is the reason the card is defined
    /// as a dynamic translucent one.
    func testTheCardLiftShouldBeVisibleAndOppositeInEachAppearance() {
        func composited(_ fg: CGFloat, _ alpha: CGFloat, over bg: CGFloat) -> CGFloat {
            fg * alpha + bg * (1 - alpha)
        }
        let lightWindow = rgb(.windowBackgroundColor, NSAppearance(named: .aqua)!)[0]
        let darkWindow = rgb(.windowBackgroundColor, NSAppearance(named: .darkAqua)!)[0]
        // The two constants settingsCard uses.
        let lightCard = composited(0, 0.035, over: lightWindow)
        let darkCard = composited(1, 0.06, over: darkWindow)
        XCTAssertLessThan(lightCard, lightWindow, "the light card must settle INTO the window")
        XCTAssertGreaterThan(darkCard, darkWindow, "the dark card must lift OFF the window")
        // Visible, not merely different: a delta under a thousandth is a colour
        // nobody can see and would pass a bare inequality.
        XCTAssertGreaterThan(lightWindow - lightCard, 0.01)
        XCTAssertGreaterThan(darkCard - darkWindow, 0.01)
    }
}
