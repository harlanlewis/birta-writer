import AppKit
import XCTest
@testable import BirtaWriter

/// The hotkey field's ground, in the appearance the field is actually drawn in.
///
/// `NSColor.textBackgroundColor` is dynamic and `.cgColor` resolves it once,
/// against whatever appearance is current on the thread rather than against the
/// view's own. A layer fill written outside a drawing appearance is therefore
/// frozen at the app's appearance, and a field inside a window with an
/// appearance of its own keeps the wrong ground: the reported symptom was a
/// black field in a light Settings window.
///
/// `MissingFileScreen` records the same trap and answers it by drawing rather than
/// filling a layer; `StatusOverlay` answers it by resolving inside
/// `performAsCurrentDrawingAppearance`. This holds the third site to one of
/// those answers.
@MainActor
final class HotkeyRecorderAppearanceTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    /// The ground `NSColor.textBackgroundColor` has in `name`.
    private func expectedGround(_ name: NSAppearance.Name) -> [CGFloat] {
        var rgb: [CGFloat] = []
        NSAppearance(named: name)!.performAsCurrentDrawingAppearance {
            let resolved = NSColor.textBackgroundColor.usingColorSpace(.sRGB)!
            rgb = [resolved.redComponent, resolved.greenComponent, resolved.blueComponent]
        }
        return rgb
    }

    private func ground(of view: NSView) -> [CGFloat] {
        let color = NSColor(cgColor: view.layer!.backgroundColor!)!.usingColorSpace(.sRGB)!
        return [color.redComponent, color.greenComponent, color.blueComponent]
    }

    private func assertGround(_ view: NSView, matches name: NSAppearance.Name,
                              _ message: String, file: StaticString = #filePath, line: UInt = #line) {
        let want = expectedGround(name)
        let got = ground(of: view)
        for (a, b) in zip(want, got) {
            XCTAssertEqual(a, b, accuracy: 0.01, message, file: file, line: line)
        }
    }

    /// The reported defect: the field is built while one appearance is current
    /// and then lives in a window with the other, and keeps the ground it was
    /// built with.
    func testAFieldBuiltUnderDarkShouldTakeTheLightGroundInALightWindow() {
        var recorder: HotkeyRecorderView!
        NSAppearance(named: .darkAqua)!.performAsCurrentDrawingAppearance {
            recorder = HotkeyRecorderView(combo: nil)
        }

        recorder.appearance = NSAppearance(named: .aqua)
        recorder.layoutSubtreeIfNeeded()

        assertGround(recorder, matches: .aqua,
                     "a field in a light window is drawing the dark ground")
    }

    /// The same in the other direction, so a fix that hardcodes one appearance
    /// cannot pass.
    func testAFieldBuiltUnderLightShouldTakeTheDarkGroundInADarkWindow() {
        var recorder: HotkeyRecorderView!
        NSAppearance(named: .aqua)!.performAsCurrentDrawingAppearance {
            recorder = HotkeyRecorderView(combo: nil)
        }

        recorder.appearance = NSAppearance(named: .darkAqua)
        recorder.layoutSubtreeIfNeeded()

        assertGround(recorder, matches: .darkAqua,
                     "a field in a dark window is drawing the light ground")
    }

    /// The discriminating half: the two grounds must actually differ, or both
    /// assertions above hold for a field that ignores appearance entirely.
    func testTheTwoGroundsShouldDiffer() {
        XCTAssertNotEqual(expectedGround(.aqua), expectedGround(.darkAqua))
    }
}
