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

    /// In a container, because `hitTest` takes its point in the SUPERVIEW's
    /// coordinates and a screen with no superview cannot tell a conversion
    /// that works from one that is a no-op standing in for it.
    private func shown(name: String = "Note.md",
                       unsaved: Bool,
                       width: CGFloat = 640,
                       height: CGFloat = 400) -> MissingFileScreen {
        let screen = MissingFileScreen()
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        container.addSubview(screen)
        screen.frame = container.bounds
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
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 400))
        container.addSubview(screen)
        screen.frame = container.bounds
        screen.show(false)
        XCTAssertNil(screen.hitTest(NSPoint(x: 320, y: 200)))
        screen.show(true, name: "Note.md", hasUnsavedText: true)
        screen.layoutSubtreeIfNeeded()
        XCTAssertNotNil(screen.hitTest(NSPoint(x: 320, y: 200)))
    }

    // MARK: the card, and the two lanes it must not enter

    /// The lane under the titlebar band, where the page draws the chip naming
    /// whichever titlebar button the pointer is on.
    ///
    /// This is the check the shape exists for. An opaque view starting at the
    /// band hides every one of those labels, the Settings gear's included, and
    /// on a panel with no Dock icon that gear is the way to preferences. The
    /// pair is compared against the LIVE chip in `jot/scripts/measure.sh`;
    /// what is held here is that the clearance is there at all.
    func testTheCardShouldLeaveTheTooltipLaneUnderTheBandClear() {
        for unsaved in [false, true] {
            let screen = shown(unsaved: unsaved)
            let card = screen.cardRect
            XCTAssertFalse(card.isEmpty, "no card drawn (unsaved: \(unsaved))")
            XCTAssertLessThanOrEqual(card.maxY,
                                     screen.bounds.height - MissingFileScreen.topLane,
                                     "the card reaches into the tooltip lane (unsaved: \(unsaved))")
        }
    }

    /// The status line floats over the trailing bottom corner, and a message
    /// arriving under a card that is already there is one crowded block.
    func testTheCardShouldLeaveTheStatusLineCornerClear() {
        for unsaved in [false, true] {
            let card = shown(unsaved: unsaved).cardRect
            XCTAssertGreaterThanOrEqual(card.minY, MissingFileScreen.bottomLane,
                                        "the card reaches the status corner (unsaved: \(unsaved))")
        }
    }

    /// At the panel's own minimum size, the card gives up both lanes rather
    /// than any part of itself.
    ///
    /// The ranking's top entry, and the one the other two exist under: every
    /// button on this card is a way out of the state, so one drawn past the
    /// window's edge is one nobody can press and nobody knows to resize for.
    /// A crowded titlebar or a crowded corner is recoverable by looking; a
    /// button that is not there is not.
    ///
    /// 360 by 208 is the panel's minimum (`JotPanel.minSize`, less the
    /// titlebar band), so this is the tightest the card is ever asked to be
    /// rather than a size picked to fail.
    func testAtThePanelsMinimumSizeTheCardShouldStayWhollyOnScreen() {
        let screen = shown(unsaved: true, width: 360, height: 208)
        let card = screen.cardRect
        XCTAssertFalse(card.isEmpty)
        XCTAssertTrue(screen.bounds.contains(card),
                      "the card is drawn outside the window: \(card) in \(screen.bounds)")
        // ...and the case really is the squeezed one, or the assertion above
        // held for a window with room to spare and proved nothing.
        let roomy = card.maxY <= screen.bounds.height - MissingFileScreen.topLane
            && card.minY >= MissingFileScreen.bottomLane
        XCTAssertFalse(roomy, "the panel's minimum size had room for both lanes, so nothing was ranked here")
    }

    /// The card is the stack plus its air, rather than a size written down, so
    /// the two shapes are two different heights: the body wraps to a second
    /// line only when there is text to lose.
    func testTheCardShouldBeSizedFromWhatItIsSaying() {
        XCTAssertGreaterThan(shown(unsaved: true).cardRect.height,
                             shown(unsaved: false).cardRect.height)
    }

    /// Every offered button has a box, inside the card.
    ///
    /// Asked because a snapshot of this state draws the card and the words and
    /// nothing where the buttons are: a bezeled `NSButton` is hosted rather
    /// than drawn on recent macOS, so it contributes nothing to the PDF path
    /// `__jotSnapshot` uses, and a picture cannot tell that apart from a row
    /// that laid out to no width at all. `performClick` cannot tell them apart
    /// either, which is what every other check in this file reaches for.
    func testEveryOfferedButtonShouldHaveABoxInsideTheCard() throws {
        let screen = shown(unsaved: true)
        let card = screen.cardRect
        for title in screen.stateForMeasurement.buttons {
            let button = try XCTUnwrap(screen.buttonForMeasurement(titled: title))
            let box = button.convert(button.bounds, to: screen)
            XCTAssertGreaterThan(box.width, 0, "\(title) laid out to no width")
            XCTAssertGreaterThan(box.height, 0, "\(title) laid out to no height")
            XCTAssertTrue(card.contains(box), "\(title) is drawn outside the card at \(box)")
        }
    }

    /// The body says all of what it says, at every width the panel can be.
    ///
    /// A narrow window is where this breaks and it breaks silently: an
    /// `NSTextField` reports its height for whatever measure it was given, so a
    /// measure wider than the box it is drawn in reports the line count of a
    /// wider line, the last line is drawn outside the field, and the card is
    /// the right size for a sentence that is not the one on screen. Nothing
    /// about the field's own frame says a line is missing.
    ///
    /// 360 is the panel's own minimum width (`JotPanel.minSize`), so this is
    /// the narrowest the card ever has to be rather than a width picked to
    /// fail. The wide case is here too, because a fix that simply let the text
    /// run edge to edge would pass the narrow one alone.
    func testTheBodyShouldFitTheCardAtEveryWidthThePanelCanBe() {
        for width in [360.0, 480.0, 640.0, 1200.0] as [CGFloat] {
            let screen = shown(unsaved: true, width: width)
            let (box, needs) = screen.bodyFitForMeasurement
            XCTAssertGreaterThanOrEqual(box.height, needs,
                                        "at \(width)pt the body is drawn \(box.height)pt tall and needs \(needs)")
            XCTAssertTrue(screen.cardRect.contains(box),
                          "at \(width)pt the body runs outside the card: \(box) in \(screen.cardRect)")
        }
    }

    /// Everything around the card falls through to the page.
    ///
    /// The point of the shape: the reader can select and copy the text they
    /// have just been told is their only copy, and the page's own controls go
    /// on answering. Four directions, because a hit test that took only the
    /// card's own box would still be wrong if it took the whole row or the
    /// whole column it sits in.
    func testAClickOutsideTheCardShouldReachThePageBehindIt() {
        let screen = shown(unsaved: true)
        let card = screen.cardRect
        let outside: [(String, NSPoint)] = [
            ("the tooltip lane", NSPoint(x: card.midX, y: screen.bounds.maxY - 8)),
            ("the status corner", NSPoint(x: card.midX, y: 8)),
            ("left of the card", NSPoint(x: card.minX - 8, y: card.midY)),
            ("right of the card", NSPoint(x: card.maxX + 8, y: card.midY)),
        ]
        for (where_, point) in outside {
            XCTAssertNil(screen.hitTest(point), "the card swallowed a click in \(where_)")
        }
        XCTAssertNotNil(screen.hitTest(NSPoint(x: card.midX, y: card.midY)),
                        "the card itself takes no clicks either, so the sweep proved nothing")
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

