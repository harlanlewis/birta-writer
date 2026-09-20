import AppKit
import BirtaWriterCore
import XCTest
@testable import BirtaWriter

/// What the first thing a new install shows actually draws.
///
/// The popover itself cannot be shown here, for the reason
/// `AppDelegate.applyMenuBarPresence` gives: this suite builds views and never
/// shows them, and asking for a status item puts an icon in the menu bar of
/// whoever is running the tests. So the VIEW is what is read back, which is
/// where every claim this surface makes lives anyway.
@MainActor
final class FirstRunPopoverTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    private func text(in view: NSView) -> [String] {
        var found: [String] = []
        if let field = view as? NSTextField { found.append(field.stringValue) }
        for subview in view.subviews { found += text(in: subview) }
        return found
    }

    private func buttons(in view: NSView) -> [NSButton] {
        var found: [NSButton] = []
        if let button = view as? NSButton { found.append(button) }
        for subview in view.subviews { found += buttons(in: subview) }
        return found
    }

    private func build(refused: HotkeyCombo?) -> FirstRunPopoverView {
        let view = FirstRunPopoverView(FirstRunInvitation.of(
            name: "Birta Writer", combo: .release, refused: refused))
        view.layoutSubtreeIfNeeded()
        return view
    }

    /// The chord is drawn on its own, which is the whole of what the surface
    /// is for.
    func testItShouldDrawWhereTheAppIsAndTheChordToPress() {
        let drawn = text(in: build(refused: nil))

        XCTAssertTrue(drawn.contains(where: { $0.contains("lives up here") }),
                      "the popover does not say where the app is: \(drawn)")
        XCTAssertTrue(drawn.contains(HotkeyCombo.release.symbols),
                      "the chord is not drawn on a line of its own: \(drawn)")
    }

    /// No buttons.
    ///
    /// The only thing to do here is press the chord, and a button beside it is
    /// a second route that makes the first one optional, which is how the
    /// gesture stops being learned. Checked as an ABSENCE, so the walk's own
    /// reach is asserted first: a sweep that found nothing would report a
    /// screen with no buttons on it either way.
    func testItShouldOfferNothingToClick() {
        let view = build(refused: nil)

        XCTAssertFalse(text(in: view).isEmpty,
                       "the walk read nothing, so it cannot say anything about buttons")
        XCTAssertEqual(buttons(in: view).map(\.title), [],
                       "the first thing this app shows has something to dismiss")
    }

    /// A refused chord is reported and never drawn to press, which is the same
    /// promise `FirstRunInvitationTests` holds of the words, read off the real
    /// view instead of off the rule.
    ///
    /// The two are not the same claim. The rule can answer `nil` for the chord
    /// and the view can go on drawing one from somewhere else, and on the
    /// build where the refused chord IS the default that mistake looks correct.
    func testARefusedChordShouldBeSaidInRedAndNotDrawnToPress() {
        let taken = try! HotkeyCombo.parse("cmd+shift+k").get()
        let view = build(refused: taken)
        let drawn = text(in: view)

        XCTAssertNil(view.chord, "the popover draws a chord macOS refused")
        XCTAssertFalse(drawn.contains(taken.symbols),
                       "the refused chord is drawn on a line of its own: \(drawn)")
        XCTAssertTrue(drawn.contains(where: { $0.contains(taken.symbols) }),
                      "nothing says which chord was taken: \(drawn)")
        XCTAssertEqual(view.body.textColor, .systemRed)
    }

    /// And the red means something, or the arm above would pass on a view that
    /// drew every sentence in red.
    func testAWorkingChordShouldNotBeDrawnAsAProblem() {
        let view = build(refused: nil)

        XCTAssertNotNil(view.chord)
        XCTAssertNotEqual(view.body.textColor, .systemRed)
    }
}
