import AppKit
import XCTest
@testable import BirtaWriter

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
    private func shown(unsaved: Bool,
                       inTrash: Bool = false,
                       width: CGFloat = 640,
                       height: CGFloat = 400) -> MissingFileScreen {
        let screen = MissingFileScreen()
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        container.addSubview(screen)
        screen.frame = container.bounds
        screen.show(true, hasUnsavedText: unsaved, isInTrash: inTrash)
        screen.layoutSubtreeIfNeeded()
        return screen
    }

    func testItShouldSayWhatIsWrongWithoutNamingTheFile() {
        // A file name is arbitrary length and this is the largest type on the
        // window, so a long one set the width of the whole card and a very long
        // one truncated in the middle of the only sentence saying what had
        // happened. The window's own title bar names the file a few inches
        // above, with a ceiling built for exactly that.
        let state = shown(unsaved: false).stateForMeasurement
        XCTAssertEqual(state.heading, "This file can't be found")
        XCTAssertTrue(state.body.contains("deleted or moved"), state.body)
        // The arm that keeps this from being satisfied by a heading that names
        // a file the test happens not to have given one.
        XCTAssertFalse(state.heading.contains(".md"), state.heading)
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
        // Four buttons wired to four closures is exactly the shape where two
        // end up on one handler and nothing looks wrong. Driven in the state
        // that offers every one of them, so no arm is left unpressed.
        let screen = shown(unsaved: true, inTrash: true)
        var calls: [String] = []
        screen.onPutItBack = { calls.append("putback") }
        screen.onSaveItBack = { calls.append("save") }
        screen.onDiscardAndStartNew = { calls.append("discard") }
        screen.onOpenRecent = { _ in calls.append("recent") }
        for title in screen.stateForMeasurement.buttons {
            let button = screen.buttonForMeasurement(titled: title)
            XCTAssertNotNil(button, title)
            button?.performClick(nil)
        }
        XCTAssertEqual(calls, ["putback", "save", "discard", "recent"])
    }

    // MARK: the file is in the Trash, which is a different thing to say

    /// The card used to guess ("deleted or moved") at a state the app can
    /// often name. A move is followed live (`NoteWatcher`), so a window reaches
    /// this screen because the file went, and when the app watched it go it
    /// knows the Trash is where.
    func testAFileInTheTrashShouldBeNamedRatherThanGuessedAt() {
        let state = shown(unsaved: false, inTrash: true).stateForMeasurement
        XCTAssertEqual(state.heading, "This file is in the Trash")
        XCTAssertFalse(state.body.contains("deleted or moved"), state.body)
    }

    /// The case that used to offer no way back to the file at all: it is in
    /// the Trash, nothing is unsaved, and the card's only options were to
    /// abandon it. Put It Back is a real restore, and it is the whole answer
    /// here.
    func testWithNothingUnsavedAndTheFileInTheTrashItShouldOfferToFetchIt() {
        let state = shown(unsaved: false, inTrash: true).stateForMeasurement
        XCTAssertEqual(state.buttons, ["Put It Back", "New Note", "Open Recent…"])
    }

    /// Both offers, because they are different promises and they compose: put
    /// the file back, then save over it, and neither copy is lost.
    func testWithUnsavedTextAndTheFileInTheTrashItShouldOfferBoth() {
        let state = shown(unsaved: true, inTrash: true).stateForMeasurement
        XCTAssertEqual(state.buttons,
                       ["Put It Back", "Save It Back", "Discard and Start New", "Open Recent…"])
        XCTAssertTrue(state.body.contains("not saved anywhere else"), state.body)
    }

    /// With nowhere to put it back FROM, the button is absent rather than
    /// disabled: a control that cannot act is a question the reader has to
    /// answer about their own file system.
    func testWithNoKnownTrashPathThereShouldBeNoPutItBackButton() {
        for unsaved in [true, false] {
            let state = shown(unsaved: unsaved, inTrash: false).stateForMeasurement
            XCTAssertFalse(state.buttons.contains("Put It Back"), "unsaved=\(unsaved)")
            XCTAssertEqual(state.heading, "This file can't be found")
        }
    }

    /// The trashed-and-nothing-unsaved card says one thing once. A body
    /// repeating the heading is a sentence nobody reads twice, and the card is
    /// sized from what it says, so an empty one would leave a gap.
    func testTheTrashedCardWithNothingAtStakeShouldNotRepeatItsHeading() {
        XCTAssertEqual(shown(unsaved: false, inTrash: true).stateForMeasurement.body, "")
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
        screen.show(true, hasUnsavedText: true)
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
    /// pair is compared against the LIVE chip in `mac/scripts/measure.sh`;
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
    /// 360 by 208 is the panel's minimum (`AppPanel.minSize`, less the
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
    /// `__birtaSnapshot` uses, and a picture cannot tell that apart from a row
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

    /// Every line of the card says all of what it says, at every width the
    /// panel can be.
    ///
    /// A narrow window is where this breaks and it breaks silently. The body
    /// wraps, so it runs out of HEIGHT: an `NSTextField` reports its height for
    /// whatever measure it was given, and a measure wider than the box it is
    /// drawn in reports the line count of a wider line, so the last line is
    /// drawn outside the field and the card is the right size for a sentence
    /// that is not the one on screen. The heading is one line, so it runs out
    /// of WIDTH and truncates instead. Both, because a fix for either alone
    /// leaves the card saying half of something.
    ///
    /// 360 is the panel's own minimum width (`AppPanel.minSize`), so this is
    /// the narrowest the card ever has to be rather than a width picked to
    /// fail. The wide case is here too, because a fix that simply let the text
    /// run edge to edge would pass the narrow one alone.
    func testEveryLineShouldFitTheCardAtEveryWidthThePanelCanBe() {
        for width in [360.0, 480.0, 640.0, 1200.0] as [CGFloat] {
            let screen = shown(unsaved: true, width: width)
            let card = screen.cardRect
            let lines = screen.labelFitsForMeasurement
            // A sweep that reached no label passes every assertion inside it.
            XCTAssertEqual(lines.count, 2, "at \(width)pt the card drew \(lines.count) lines")
            for (name, box, needs) in lines {
                XCTAssertGreaterThanOrEqual(box.height, needs.height,
                                            "at \(width)pt the \(name) is \(box.height)pt tall and needs \(needs.height)")
                XCTAssertGreaterThanOrEqual(box.width.rounded(), needs.width.rounded(),
                                            "at \(width)pt the \(name) is \(box.width)pt wide and needs \(needs.width)")
                XCTAssertTrue(card.contains(box),
                              "at \(width)pt the \(name) runs outside the card: \(box) in \(card)")
            }
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


