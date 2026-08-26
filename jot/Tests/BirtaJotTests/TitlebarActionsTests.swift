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

    /// The set the app actually ships, named once so every check below is
    /// about the real strip rather than about a pair invented here.
    private static let shippedActions: [TitlebarActionsView.Action] = [
        .init(selector: #selector(AppDelegate.menuNewNote), symbol: "square.and.pencil"),
        .init(selector: #selector(AppDelegate.menuOpenDocument), symbol: "folder"),
        .init(selector: #selector(AppDelegate.menuOpenRecent(_:)), symbol: "clock"),
    ]

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

    // MARK: ink

    func testAButtonShouldBrightenUnderThePointerAndDimInABackgroundWindow() {
        let view = boundTitle()
        let button = view.actionsView.buttons[0]
        let resting = button.hoverForMeasurement(false)
        let hovered = button.hoverForMeasurement(true)
        XCTAssertNotEqual(resting, hovered, "the button says nothing when the pointer is on it")
        view.setWindowKey(false)
        XCTAssertEqual(button.hoverForMeasurement(true), NSColor.tertiaryLabelColor,
                       "a background window should draw its chrome quietly")
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
