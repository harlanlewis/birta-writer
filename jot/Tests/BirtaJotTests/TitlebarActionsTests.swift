import AppKit
import XCTest
@testable import BirtaJot
@testable import BirtaJotCore

/// The two file buttons the titlebar draws, against a real view that has been
/// laid out.
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
        view.setActions([
            .init(selector: #selector(AppDelegate.menuNewNote), symbol: "square.and.pencil"),
            .init(selector: #selector(AppDelegate.menuOpenDocument), symbol: "folder"),
        ])
        view.setTextCeiling(400)
        view.show(url: URL(fileURLWithPath: "/tmp/\(name)"), edited: false)
        view.setFrameSize(NSSize(width: view.frame.width, height: TitleBarView.height))
        view.layoutSubtreeIfNeeded()
        return view
    }

    // MARK: the symbols exist

    func testBothButtonsShouldResolveASystemSymbol() {
        let view = boundTitle()
        XCTAssertEqual(view.actionsView.buttons.count, 2)
        // The arm that stops everything below reporting healthily about
        // buttons that draw nothing.
        XCTAssertEqual(view.actionsForMeasurement(hovered: true).symbols, 2,
                       "a system symbol name did not resolve")
    }

    func testEachButtonShouldTakeItsLabelAndChordFromTheMenuRowItRepeats() {
        let view = boundTitle()
        let labels = view.actionsView.buttons.map { $0.accessibilityLabel() ?? "" }
        XCTAssertEqual(labels, ["New Note", "Open…"])
        // The chord is the menu's, not a literal: a tooltip is a claim about a
        // binding, and this is the only thing holding the two together.
        let tips = view.actionsView.buttons.compactMap { $0.toolTip }
        XCTAssertEqual(tips.count, 2)
        XCTAssertTrue(tips[0].hasSuffix("⌘N"), tips[0])
        XCTAssertTrue(tips[1].hasSuffix("⌘O"), tips[1])
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
                titleChromeWidth: TitleBarView.chromeWidth,
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
        XCTAssertLessThan(frames[0].minX, frames[1].minX, "New Note should come first, as it does in the File menu")
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
        XCTAssertEqual(spy.received, ["menuNewNote", "menuOpenDocument"])
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
        view.setActions([
            .init(selector: #selector(AppDelegate.menuNewNote), symbol: "square.and.pencil"),
            .init(selector: #selector(AppDelegate.menuOpenDocument), symbol: "folder"),
        ])
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
        // what the strip holds. Both sources withdraw independently: this is
        // the arm that fails if the two are collapsed into one flag.
        let view = boundTitle()
        view.setBandHovered(true)
        XCTAssertTrue(view.actionsView.shown)
        view.setBandHovered(false)
        XCTAssertFalse(view.actionsView.shown)
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
}
