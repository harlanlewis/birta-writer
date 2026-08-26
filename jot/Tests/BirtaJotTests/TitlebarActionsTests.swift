import AppKit
import XCTest
@testable import BirtaJot
@testable import BirtaJotCore

/// The file buttons the titlebar draws, against a real view that has been laid
/// out.
///
/// Three things here can only be asked of the built view, and each is a way
/// the feature fails while every model-side number stays healthy. The symbols
/// can be absent, because `NSImage(systemSymbolName:)` answers a name the
/// system does not have with nil and an image view holding nil draws nothing
/// and says nothing. The room can move on hover, which is the defect
/// `TitleBarView`'s geometry rule exists for and which no screenshot shows,
/// because both states look correct on their own. And the buttons can be
/// unclickable, because the title's own `hitTest` answers for the whole
/// accessory unless it is told not to.
@MainActor
final class TitlebarActionsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    /// A title bound to a file, laid out, with the real actions wired.
    private func boundTitle(name: String = "Note.md") -> TitleBarView {
        let view = TitleBarView()
        view.setActions(Self.shippedActions)
        view.setTextCeiling(400)
        view.show(url: URL(fileURLWithPath: "/tmp/\(name)"), edited: false)
        view.setFrameSize(NSSize(width: view.frame.width, height: TitleBarView.height))
        view.layoutSubtreeIfNeeded()
        return view
    }

    /// The set the app actually ships, read from the declaration the app reads,
    /// so every check below is about the real strip. It used to be a copy of
    /// that list kept here, which is a corpus that can quietly stop matching
    /// the one under test while every assertion goes on passing.
    private static let shippedActions = TitlebarActionsView.shipped

    // MARK: the symbols exist

    func testEveryButtonShouldResolveASystemSymbol() {
        let view = boundTitle()
        XCTAssertEqual(view.actionsView.buttons.count, Self.shippedActions.count)
        // The arm that stops everything below reporting healthily about
        // buttons that draw nothing.
        XCTAssertEqual(view.actionsForMeasurement(hovered: true).symbols,
                       Self.shippedActions.count,
                       "a system symbol name did not resolve")
    }

    func testEachButtonShouldTakeItsLabelAndChordFromTheMenuRowItRepeats() {
        let view = boundTitle()
        let labels = view.actionsView.buttons.map { $0.accessibilityLabel() ?? "" }
        XCTAssertEqual(labels, ["New Note", "Open…", "Open Recent"])
        // The chord is the menu's, not a literal: a tooltip is a claim about a
        // binding, and this is the only thing holding the two together. Open
        // Recent binds no key, so its tooltip is the title alone rather than a
        // title with a bare modifier string after it.
        let tips = view.actionsView.buttons.compactMap { $0.toolTip }
        XCTAssertEqual(tips.count, 3)
        XCTAssertTrue(tips[0].hasSuffix("⌘N"), tips[0])
        XCTAssertTrue(tips[1].hasSuffix("⌘O"), tips[1])
        XCTAssertEqual(tips[2], "Open Recent")
    }

    func testATooltipShouldSurviveTheLayoutPassesThatFollowIt() {
        // The half the assertion above cannot make, and the half that was
        // wrong for as long as these buttons have existed. `toolTip` is a
        // string this view hands back whatever else happens to it; what
        // DELIVERS the tooltip is a tracking area AppKit installs when the
        // string is set, and `updateTrackingAreas` runs on every layout pass.
        // Sweeping `trackingAreas` there takes that area away with the hover
        // area, and nothing puts it back, so every button had a tooltip and
        // none of them ever showed one.
        //
        // Asserted as a count rather than by reaching for AppKit's own area,
        // which is not identifiable through public API. It pins both
        // directions: the count must not fall (the tooltip was swept) and must
        // not climb (a hover area leaked on every pass).
        let view = boundTitle()
        let button = view.actionsView.buttons[0]
        XCTAssertNotNil(button.toolTip)
        button.updateTrackingAreas()
        let settled = button.trackingAreas.count
        XCTAssertGreaterThan(settled, 1,
                             "only this view's own tracking area is left, so the tooltip's is gone")
        for _ in 0..<3 { button.updateTrackingAreas() }
        XCTAssertEqual(button.trackingAreas.count, settled,
                       "a layout pass changed how many tracking areas the button has")
        XCTAssertNotNil(button.toolTip, "the label itself went missing")
    }

    // MARK: the reservation follows the buttons

    func testTheRoomHeldShouldGrowWithTheNumberOfButtons() {
        // The constant this replaced was a literal `* 2`, which drew a third
        // button correctly and left the drag strip lying over it, because the
        // strip's origin is the accessory's trailing edge. Asserted as the
        // difference one button makes, so it stays true when the box is tuned.
        let two = TitlebarActionsView(actions: Array(Self.shippedActions.prefix(2)))
        let three = TitlebarActionsView(actions: Self.shippedActions)
        XCTAssertGreaterThan(three.room, two.room)
        XCTAssertEqual(three.room - two.room, two.room - TitlebarActionsView(actions: [Self.shippedActions[0]]).room)
        // And the view is BUILT at the room it reports, or its own layout and
        // the window's measurement of it start from different numbers.
        XCTAssertEqual(three.frame.width, three.room)
    }

    // MARK: geometry does not move under the pointer

    func testHoverShouldChangeNoGeometryAtAll() {
        let view = boundTitle(name: "A rather long note name.md")
        let cold = view.actionsForMeasurement(hovered: false)
        let coldWidth = view.frame.width
        let coldLabel = view.labelFrameInWindow()
        let hot = view.actionsForMeasurement(hovered: true)
        XCTAssertFalse(cold.shown)
        XCTAssertTrue(hot.shown)
        // The drag strip starts at this view's maxX and is laid out by the
        // window, not by this view, so a width that moved on hover would leave
        // the strip lying over the buttons it just made room for.
        XCTAssertEqual(view.frame.width, coldWidth)
        XCTAssertEqual(view.labelFrameInWindow(), coldLabel)
        XCTAssertEqual(cold.frames, hot.frames)
        // And the room is genuinely held while nothing is drawn, rather than
        // both states being empty, which is how this check passes for the
        // wrong reason.
        XCTAssertTrue(cold.frames.allSatisfy { $0.width > 0 })
    }

    func testTheTitleAndItsButtonsShouldFitTheBandAtEveryWidth() {
        // What `chromeWidth` is FOR, asked as the property rather than as a
        // sum of the constants that happen to make it up. A literal there
        // restates three private numbers and fails whenever any of them is
        // tuned, while saying nothing about whether the reservation works.
        //
        // The band's arithmetic is `TitlebarBand`'s, and the ceiling it hands
        // back is net of `chromeWidth`; the accessory then sizes itself from
        // that ceiling. Drop the buttons' room out of `chromeWidth` and the
        // ceiling comes back that much too generous at every width, so the
        // accessory runs under the page's controls and the drag strip goes
        // negative. That is what this fails on.
        let originX: CGFloat = 78      // where AppKit puts a leading accessory
        let controls: CGFloat = 90     // what the page's own chrome has taken
        var truncated = 0
        for windowWidth in [CGFloat(360), 480, 640, 900] {
            let ceiling = TitlebarBand.titleTextCeiling(
                windowWidth: windowWidth,
                titleOriginX: originX,
                titleChromeWidth: boundTitle().chromeWidth,
                trailingControlsWidth: controls)
            let view = boundTitle(name: "A deliberately long note name to run past the ceiling.md")
            view.setTextCeiling(ceiling)
            view.layoutSubtreeIfNeeded()
            let frames = view.actionsForMeasurement(hovered: true).frames
            XCTAssertLessThanOrEqual(originX + view.frame.width, windowWidth - controls,
                                     "the accessory runs under the page's controls at \(windowWidth)")
            for frame in frames {
                XCTAssertLessThanOrEqual(originX + frame.maxX, windowWidth - controls,
                                         "a button is under the page's controls at \(windowWidth)")
            }
            if view.currentText.contains("…") { truncated += 1 }
        }
        // The narrow widths have to have actually pressed on the ceiling, or
        // every window here was roomy and the check passed without testing it.
        XCTAssertGreaterThan(truncated, 0, "no width truncated, so the ceiling was never reached")
    }

    func testTheButtonsShouldSitAfterTheNameAndInsideTheView() {
        let view = boundTitle()
        let frames = view.actionsForMeasurement(hovered: true).frames
        let label = view.labelFrameInWindow()
        for frame in frames {
            XCTAssertGreaterThan(frame.minX, label.width, "a button overlaps the name")
            XCTAssertLessThanOrEqual(frame.maxX, view.bounds.width + 0.5,
                                     "a button is drawn outside the accessory")
        }
        XCTAssertEqual(frames.map(\.minX), frames.map(\.minX).sorted(),
                       "the buttons should be drawn in the order the File menu lists them")
    }

    // MARK: clicks

    func testAShownButtonShouldTakeItsOwnClickAndAHiddenOneShouldNot() {
        let view = boundTitle()
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: TitleBarView.height))
        host.addSubview(view)
        let openButton = view.actionsView.buttons[1]
        // In the TITLE view's coordinates, which is what `hitTest` converts
        // from. A button's own `frame` is its parent's, and the two differ by
        // where the actions view starts, which is most of the way across.
        let box = openButton.convert(openButton.bounds, to: view)
        let point = view.convert(NSPoint(x: box.midX, y: box.midY), to: host)

        // Not offered: the reserved room falls through, so the band behind it
        // still drags the window rather than opening the document popover.
        _ = view.actionsForMeasurement(hovered: false)
        XCTAssertNil(view.hitTest(point))

        _ = view.actionsForMeasurement(hovered: true)
        XCTAssertTrue(view.hitTest(point) === openButton)
    }

    func testAClickShouldTravelTheResponderChainToTheMenusOwnSelector() {
        // The claim the hit test cannot make: the button does not merely
        // receive the click, it sends the SAME selector the File menu sends,
        // with no target, so both end at the application's delegate. A closure
        // wired here instead would pass a click test while being a second
        // implementation able to drift from the row it borrows its label from.
        let spy = ActionSpy()
        let previous = NSApp.delegate
        NSApp.delegate = spy
        defer { NSApp.delegate = previous }

        let view = boundTitle()
        for button in view.actionsView.buttons {
            XCTAssertNil(button.target, "a target pins the click to one object and leaves the chain")
            button.performClick(nil)
        }
        XCTAssertEqual(spy.received, ["menuNewNote", "menuOpenDocument", "menuOpenRecent"])
    }

    func testTheNameShouldStillTakeItsOwnClick() {
        let view = boundTitle()
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: TitleBarView.height))
        host.addSubview(view)
        let onTheName = view.convert(NSPoint(x: 12, y: view.bounds.midY), to: host)
        _ = view.actionsForMeasurement(hovered: true)
        XCTAssertTrue(view.hitTest(onTheName) === view)
    }

    // MARK: states with nothing to act on

    func testATitleNamingTheApplicationShouldOfferNoButtons() {
        // The first-run screen, which is the only caller of `showAppName`. New
        // Note and Open are both refused there (`AppDelegate.documentCommands`),
        // and this is the surface that would otherwise still be offering them.
        let view = TitleBarView()
        view.setActions(Self.shippedActions)
        view.setTextCeiling(400)
        view.showAppName("Birta Writer")
        view.layoutSubtreeIfNeeded()
        XCTAssertFalse(view.actionsForMeasurement(hovered: true).shown)
    }

    func testAButtonThatIsNotOfferedShouldBeOutOfReachEntirely() {
        // Zero alpha alone leaves a control that still takes a focus ring
        // under Full Keyboard Access and still answers an accessibility press,
        // with nothing on screen to explain either. Hidden is the state that
        // withdraws it from the key view loop, the accessibility tree and hit
        // testing together, so this asks for the flag rather than for the
        // opacity that merely looks the same.
        let view = boundTitle()
        _ = view.actionsForMeasurement(hovered: false)
        XCTAssertTrue(view.actionsView.buttons.allSatisfy { $0.isHidden },
                      "an invisible button is still reachable")
        _ = view.actionsForMeasurement(hovered: true)
        XCTAssertTrue(view.actionsView.buttons.allSatisfy { !$0.isHidden && $0.alphaValue == 1 })
    }

    func testHoverOnTheBandShouldOfferTheSameButtonsTheNameDoes() {
        // The band reads as one strip, so pointing anywhere along it offers
        // what the strip holds. Asked of a BACKGROUND window, because a key one
        // offers them anyway and the check would pass without the band ever
        // being consulted. Both sources withdraw independently: this is the arm
        // that fails if they are collapsed into one flag.
        let view = boundTitle()
        view.setWindowKey(false, animated: false)
        XCTAssertFalse(view.actionsView.shown, "a background window at rest should offer nothing")
        view.setBandHovered(true)
        XCTAssertTrue(view.actionsView.shown)
        view.setBandHovered(false)
        XCTAssertFalse(view.actionsView.shown)
    }

    func testAKeyWindowShouldOfferTheButtonsWithNoPointerOnItAtAll() {
        // The complaint these earned while they were hover-only: a control
        // nobody can see is a control nobody learns, and its tooltip is never
        // read because resting on a blank stretch of titlebar is not a gesture.
        // A key window offers them; a background window with no pointer on it
        // is the one state that takes them away.
        //
        // The pair is asserted together rather than the first alone, or this
        // passes on a strip that simply never hides.
        let view = boundTitle()
        view.setWindowKey(true, animated: false)
        XCTAssertTrue(view.actionsView.shown, "a key window should draw them with no pointer on it")
        view.setWindowKey(false, animated: false)
        XCTAssertFalse(view.actionsView.shown, "and a background window at rest should not")
    }

    func testTheButtonsShouldTakeNoRoomFromTheNameForBeingDrawnMoreOften() {
        // Showing them whenever the window is key changes WHEN they are drawn
        // and nothing about the geometry, which is the whole reason that change
        // was cheap: the room is reserved either way, so the title's ceiling and
        // the drag strip's origin are the same numbers at rest as awake.
        let view = boundTitle(name: "A rather long note name.md")
        view.setWindowKey(false, animated: false)
        let restingWidth = view.frame.width
        let restingLabel = view.labelFrameInWindow()
        view.setWindowKey(true, animated: false)
        XCTAssertTrue(view.actionsView.shown, "the awake arm never drew anything")
        XCTAssertEqual(view.frame.width, restingWidth)
        XCTAssertEqual(view.labelFrameInWindow(), restingLabel)
    }

    // MARK: one strip with the page's half

    func testTheButtonsShouldBeOneSizeEvenlySpacedAndCentredOnTheBand() {
        // The SHAPE of the row, which is what has to match the page's; the
        // numbers themselves are compared against the live page by
        // jot/scripts/measure.sh, and asserting them here would only restate
        // the constants two lines away.
        //
        // Centred rather than filling the band is the part worth pinning. A
        // button that takes the whole band looks identical while nothing is
        // drawn behind it, so the height was free to be anything until the
        // hover fill made the box visible; nothing here would have said so.
        let view = boundTitle()
        // A band taller than the view was built at, which is what AppKit
        // actually hands a titlebar accessory. Built-height and given-height
        // agreeing is how a centring bug hides.
        view.setFrameSize(NSSize(width: view.frame.width, height: TitleBarView.height + 8))
        view.layoutSubtreeIfNeeded()
        let frames = view.actionsForMeasurement(hovered: true).frames
        XCTAssertGreaterThan(frames.count, 1, "one button cannot show a gap")
        XCTAssertEqual(Set(frames.map(\.width)).count, 1, "the buttons are not one width")
        XCTAssertEqual(Set(frames.map(\.height)).count, 1, "the buttons are not one height")
        XCTAssertLessThan(frames[0].height, view.bounds.height,
                          "the box is still the whole band, so it cannot match the page's")
        let ordered = frames.sorted { $0.minX < $1.minX }
        let gaps = zip(ordered.dropFirst(), ordered).map { $0.minX - $1.maxX }
        XCTAssertEqual(Set(gaps).count, 1, "the air between the buttons is not even")
        XCTAssertGreaterThan(gaps[0], 0, "the buttons sit against each other with nothing between them")
        for frame in ordered {
            XCTAssertEqual(frame.midY, view.bounds.midY, accuracy: 0.5,
                           "a button is not centred on the band")
        }
    }

    func testTheRoomHeldShouldCoverTheAirBetweenTheButtonsToo() {
        // The gap is inside the reservation or it is taken out of the drag
        // strip, which then lies over the last button. The property, not the
        // number: what has to hold is that the buttons END inside the room the
        // view reports, whatever the box and the gap are tuned to.
        let view = TitlebarActionsView(actions: Self.shippedActions)
        view.setFrameSize(NSSize(width: view.room, height: TitleBarView.height))
        view.layoutSubtreeIfNeeded()
        let maxX = view.buttons.map { $0.frame.maxX }.max() ?? 0
        XCTAssertLessThanOrEqual(maxX, view.room + 0.5, "the row runs past the room held for it")
    }

    // MARK: ink

    func testAButtonWithNoWashToDrawShouldBrightenUnderThePointer() {
        // The floor: with the page's palette not yet in hand there is no fill,
        // so the ink is the only channel left and has to carry hover on its
        // own. A control that says nothing under the pointer is what this
        // branch exists to avoid.
        let view = boundTitle()
        let button = view.actionsView.buttons[0]
        XCTAssertNil(button.hoverFillForMeasurement(true), "there is a wash, so this arm tested nothing")
        let resting = button.hoverForMeasurement(false)
        let hovered = button.hoverForMeasurement(true)
        XCTAssertNotEqual(resting, hovered, "the button says nothing when the pointer is on it")
        view.setWindowKey(false)
        XCTAssertEqual(button.hoverForMeasurement(true), NSColor.tertiaryLabelColor,
                       "a background window should draw its chrome quietly")
    }

    func testAButtonGivenThePagesWashShouldWearItAndHoldItsInkStill() {
        // How the page says hover: a rounded fill appears and the ink does not
        // move. Both halves, because a fill that arrived AND an ink that still
        // brightened would be this button saying it twice where the page says
        // it once.
        let view = boundTitle()
        let wash = NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.06)
        view.actionsView.setBandChrome(hoverFill: wash, cornerRadius: 4)
        let button = view.actionsView.buttons[0]
        XCTAssertNil(button.hoverFillForMeasurement(false), "a resting button is wearing a fill")
        XCTAssertNotNil(button.hoverFillForMeasurement(true), "the pointer drew no fill")
        XCTAssertEqual(button.layer?.cornerRadius, 4)
        XCTAssertEqual(button.hoverForMeasurement(false), button.hoverForMeasurement(true),
                       "the ink moved as well as the fill")
        view.setWindowKey(false)
        XCTAssertNil(button.hoverFillForMeasurement(true),
                     "a background window drew a fill for a pointer it does not have")
    }
}

/// Stands in for the application's delegate, so a click that leaves the button
/// can be seen arriving somewhere. Named by selector rather than counted,
/// because "a click arrived" is true of the wrong selector too.
@MainActor
private final class ActionSpy: NSObject, NSApplicationDelegate {
    var received: [String] = []
    @objc func menuNewNote() { received.append("menuNewNote") }
    @objc func menuOpenDocument() { received.append("menuOpenDocument") }
    @objc func menuOpenRecent(_ sender: Any?) { received.append("menuOpenRecent") }
}
