import AppKit
import XCTest
@testable import BirtaJot

/// What the panel says and offers when the file it was editing is gone.
///
/// The state has two shapes and only one of them is dangerous, so the whole of
/// this file is about telling them apart. With text in the buffer, that buffer
/// is the only copy of somebody's note and the screen has to say so and offer
/// to write it. With nothing in the buffer there is nothing to save and
/// nothing to discard, and offering either is offering a choice about nothing.
///
/// Read off the built view rather than the model, because what is wrong with a
/// screen like this is never the flag: it is a button that says one thing and
/// costs another, or an offer that is still on screen after it stopped
/// applying.
@MainActor
final class MissingFileScreenTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    private func shown(name: String = "Note.md", unsaved: Bool) -> MissingFileScreen {
        let screen = MissingFileScreen()
        screen.setFrameSize(NSSize(width: 640, height: 400))
        screen.show(true, name: name, hasUnsavedText: unsaved)
        screen.layoutSubtreeIfNeeded()
        return screen
    }

    func testItShouldNameTheFileAndSayItIsGone() {
        // The name is in the heading because somebody with several notes needs
        // to know which one this is about, and the titlebar is still showing a
        // file that is no longer there.
        let state = shown(unsaved: false).stateForMeasurement
        XCTAssertEqual(state.heading, "Note.md doesn't exist")
        XCTAssertTrue(state.body.contains("deleted or moved"), state.body)
    }

    func testWithTextInTheBufferItShouldOfferToSaveItAndSayWhatIsAtStake() {
        // The dangerous shape. The buffer is the only copy, so saving it is
        // the first thing offered, and the button that throws it away is named
        // for what it costs rather than for what it makes.
        let state = shown(unsaved: true).stateForMeasurement
        XCTAssertEqual(state.buttons, ["Save It Back", "Discard and Start New", "Open Recent…"])
        XCTAssertTrue(state.body.contains("not saved anywhere else"), state.body)
    }

    func testWithNothingToLoseItShouldOfferNeitherSavingNorDiscarding() {
        // An offer to save an empty buffer writes an empty file, and a warning
        // about discarding nothing is a warning people learn to click through.
        let state = shown(unsaved: false).stateForMeasurement
        XCTAssertEqual(state.buttons, ["New Note", "Open Recent…"])
        XCTAssertFalse(state.body.contains("not saved anywhere else"), state.body)
    }

    func testTheTwoShapesShouldDifferInWhatTheyOfferRatherThanOnlyInWording() {
        // The arm that stops both cases being one screen with two sentences.
        // A version that always drew three buttons would pass every wording
        // check above.
        XCTAssertNotEqual(shown(unsaved: true).stateForMeasurement.buttons,
                          shown(unsaved: false).stateForMeasurement.buttons)
    }

    func testEachButtonShouldReportTheGestureItNames() {
        // Three buttons wired to three closures is exactly the shape where two
        // end up on one handler and nothing looks wrong.
        let screen = shown(unsaved: true)
        var calls: [String] = []
        screen.onSaveItBack = { calls.append("save") }
        screen.onDiscardAndStartNew = { calls.append("discard") }
        screen.onOpenRecent = { _ in calls.append("recent") }
        for title in screen.stateForMeasurement.buttons {
            let button = screen.buttonForMeasurement(titled: title)
            XCTAssertNotNil(button, title)
            button?.performClick(nil)
        }
        XCTAssertEqual(calls, ["save", "discard", "recent"])
    }

    func testAHiddenScreenShouldTakeNoClicksAtAll() {
        // It sits over a live editor. A hidden one that still hit-tests is a
        // sheet nobody can see swallowing every click on the note.
        let screen = MissingFileScreen()
        screen.setFrameSize(NSSize(width: 640, height: 400))
        screen.show(false)
        XCTAssertNil(screen.hitTest(NSPoint(x: 320, y: 200)))
        screen.show(true, name: "Note.md", hasUnsavedText: true)
        XCTAssertNotNil(screen.hitTest(NSPoint(x: 320, y: 200)))
    }

    func testNoButtonShouldTakeTheReturnKey() {
        // `performKeyEquivalent` walks the key window's whole content view
        // before a key reaches the first responder, and this screen lives in
        // that hierarchy above a live editor. A default button here would
        // swallow every Return typed into the note behind it, in the one state
        // where the buffer is the only copy of that note.
        let screen = shown(unsaved: true)
        for title in screen.stateForMeasurement.buttons {
            XCTAssertEqual(screen.buttonForMeasurement(titled: title)?.keyEquivalent, "",
                           "\(title) took a key equivalent")
        }
    }
}
