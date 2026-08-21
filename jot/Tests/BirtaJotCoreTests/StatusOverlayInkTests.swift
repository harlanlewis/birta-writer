import AppKit
import XCTest

/// The two colour facts `StatusOverlay` depends on, neither of which is ours.
///
/// The status line has no frame, so nothing but the ink and the scrim is
/// holding it up. Both are system colours, and a system colour is exactly the
/// kind of figure that must not be written into a comment as a number: it can
/// move under us in an OS release, in silence, and the line would go back to
/// being unreadable with every test still green.
final class StatusOverlayInkTests: XCTestCase {
    /// WCAG 2.1 relative luminance and contrast ratio. The label roles are
    /// translucent, so each one is composited over the paper before measuring;
    /// reading their alpha alone would overstate every one of them.
    private func contrast(_ ink: NSColor, on paper: NSColor, _ appearance: NSAppearance) -> CGFloat {
        func channel(_ v: CGFloat) -> CGFloat {
            v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        func luminance(_ c: NSColor) -> CGFloat {
            0.2126 * channel(c.redComponent)
                + 0.7152 * channel(c.greenComponent)
                + 0.0722 * channel(c.blueComponent)
        }
        var ratio: CGFloat = 0
        appearance.performAsCurrentDrawingAppearance {
            let ground = paper.usingColorSpace(.sRGB)!
            let raw = ink.usingColorSpace(.sRGB)!
            let composited = NSColor(
                srgbRed: raw.redComponent * raw.alphaComponent + ground.redComponent * (1 - raw.alphaComponent),
                green: raw.greenComponent * raw.alphaComponent + ground.greenComponent * (1 - raw.alphaComponent),
                blue: raw.blueComponent * raw.alphaComponent + ground.blueComponent * (1 - raw.alphaComponent),
                alpha: 1)
            let a = luminance(composited), b = luminance(ground)
            ratio = (max(a, b) + 0.05) / (min(a, b) + 0.05)
        }
        return ratio
    }

    /// AA for text at or below the small system size. The status line is drawn
    /// at `NSFont.smallSystemFontSize`, which is nobody's idea of large text.
    private let floor: CGFloat = 4.5

    func testTheStatusInkShouldClearTheContrastFloorInBothAppearances() {
        for name in [NSAppearance.Name.aqua, .darkAqua] {
            let appearance = NSAppearance(named: name)!
            let measured = contrast(.labelColor, on: .textBackgroundColor, appearance)
            XCTAssertGreaterThanOrEqual(
                measured, floor,
                "\(name.rawValue): labelColor on the page's paper measures \(measured):1, "
                + "below the \(floor):1 floor for small text. StatusOverlay has no frame to fall back on.")
        }
    }

    /// Why the quieter roles were not used, kept as a measurement rather than
    /// an assertion of taste. A failure here is GOOD NEWS: the system has
    /// raised one of them above the floor and `StatusOverlay` could take the
    /// softer ink it would otherwise prefer for something this transient.
    func testTheDimmerLabelRolesShouldStillBeBelowTheFloorOnPaper() {
        for name in [NSAppearance.Name.aqua, .darkAqua] {
            let appearance = NSAppearance(named: name)!
            for (role, ink) in [("tertiaryLabelColor", NSColor.tertiaryLabelColor),
                                ("secondaryLabelColor", NSColor.secondaryLabelColor)] {
                // secondaryLabelColor clears the floor on the dark paper and
                // not on the light one, so only the worse of the two is the
                // claim: one appearance failing is enough to rule a role out.
                if role == "secondaryLabelColor", name == .darkAqua { continue }
                let measured = contrast(ink, on: .textBackgroundColor, appearance)
                XCTAssertLessThan(
                    measured, floor,
                    "\(name.rawValue): \(role) now measures \(measured):1 and clears the floor; "
                    + "StatusOverlay could use it instead of labelColor.")
            }
        }
    }

    /// The scrim is only invisible over empty paper if it is painted in the
    /// same colour the PAGE paints its paper. `Coordinator.applyTheme` hands
    /// the web view `textBackgroundColor`, and the page's own stylesheet names
    /// the value independently, so the two can drift apart with nothing else
    /// noticing. If they do, the scrim stops disappearing and becomes the frame
    /// the overlay is not allowed to have.
    func testTheScrimColourShouldMatchThePagePaperInBothAppearances() {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaJotCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // jot
            .deletingLastPathComponent()  // repo root
        let palette = root.appendingPathComponent("webview/ui/hostPalette.css")
        guard let css = try? String(contentsOf: palette, encoding: .utf8) else {
            // Not a skip. A guard that cannot find its subject has stopped
            // guarding, and that has to be a red rather than a silent pass.
            return XCTFail("could not read \(palette.path); if the host palette moved, this guard must follow it")
        }

        // The dark block is the one the page selects with body.vscode-dark;
        // everything before it is the light default. Match the whole selector
        // rather than the class name, which the file's header comment also
        // mentions, ahead of every declaration.
        let selector = ":root:has(body.vscode-dark)"
        guard let split = css.range(of: selector) else {
            return XCTFail("hostPalette.css no longer has a \(selector) block; this guard needs rewriting")
        }
        let declared: [(NSAppearance.Name, String)] = [
            (.aqua, String(css[css.startIndex..<split.lowerBound])),
            (.darkAqua, String(css[split.upperBound...])),
        ]

        for (name, region) in declared {
            guard let hex = firstEditorBackground(in: region) else {
                return XCTFail("\(name.rawValue): no --vscode-editor-background found in hostPalette.css")
            }
            let appearance = NSAppearance(named: name)!
            var system = ""
            appearance.performAsCurrentDrawingAppearance {
                let c = NSColor.textBackgroundColor.usingColorSpace(.sRGB)!
                system = String(format: "#%02x%02x%02x",
                                Int((c.redComponent * 255).rounded()),
                                Int((c.greenComponent * 255).rounded()),
                                Int((c.blueComponent * 255).rounded()))
            }
            XCTAssertEqual(
                system, hex,
                "\(name.rawValue): the page paints its paper \(hex) but textBackgroundColor is \(system). "
                + "StatusOverlay's scrim is painted with the latter and would now be visible over empty paper.")
        }
    }

    /// The two cases above measure the COLOURS. This one is the only thing
    /// tying those measurements to the view that is supposed to use them.
    ///
    /// `StatusOverlay` lives in the `BirtaJot` app target, which has no test
    /// target: `BirtaJotCore` is deliberately AppKit-free so it can be tested
    /// without a window, and moving these colours there to make them reachable
    /// would import AppKit into Core to win an assertion, which is the wrong
    /// trade. So the guard reads the source instead.
    ///
    /// Without it, setting the ink back to `tertiaryLabelColor` leaves every
    /// other case in this file green, because they measure what the system
    /// says about colours nothing would then be using. That is the whole of
    /// the defect this file exists for, so it has to be the thing pinned.
    func testTheOverlayShouldStillUseTheColoursThisFileMeasures() {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/BirtaJot/StatusOverlay.swift")
        guard let swift = try? String(contentsOf: source, encoding: .utf8) else {
            return XCTFail("could not read \(source.path); if StatusOverlay moved, this guard must follow it")
        }

        // The ink, taken from the assignment rather than from anywhere the
        // name merely appears, so a mention in a comment cannot satisfy it.
        guard let assignment = swift.range(of: "status.textColor = ") else {
            return XCTFail("StatusOverlay no longer assigns status.textColor; this guard needs rewriting")
        }
        let rest = swift[assignment.upperBound...]
        let ink = rest.prefix(while: { !$0.isNewline }).trimmingCharacters(in: .whitespaces)
        XCTAssertEqual(
            ink, ".labelColor",
            "StatusOverlay draws its message in \(ink), but the contrast measured in this file is for "
            + "labelColor. Either restore it, or measure the new one here and move the floor with it.")

        // The scrim, which is only invisible over paper while it is painted in
        // the colour the page paints its own.
        XCTAssertTrue(
            swift.contains("NSColor.textBackgroundColor"),
            "StatusOverlay's scrim no longer uses textBackgroundColor, so the colour this file checks "
            + "against the page's paper is not the colour the scrim is drawn in.")
    }

    private func firstEditorBackground(in css: String) -> String? {
        guard let key = css.range(of: "--vscode-editor-background:") else { return nil }
        let rest = css[key.upperBound...]
        guard let end = rest.firstIndex(of: ";") else { return nil }
        return rest[rest.startIndex..<end].trimmingCharacters(in: .whitespaces).lowercased()
    }
}
