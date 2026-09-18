import XCTest
@testable import BirtaWriterCore

/// The handed-over tooltip with no window: what a request means, what colour a
/// computed-style string is, and where the chip goes.
final class StripTooltipTests: XCTestCase {
    private func request(text: Any? = "Open…  ⌘O",
                         anchor: [String: Any]? = ["x": 100, "y": 5, "width": 26, "height": 24],
                         style: [String: Any]? = ["background": "rgb(30, 30, 30)",
                                                  "color": "rgb(255, 255, 255)",
                                                  "fontSize": 12, "radius": 5,
                                                  "padX": 8, "padY": 4],
                         gap: Any? = 6) -> [String: Any] {
        var dict: [String: Any] = ["type": "stripTooltip"]
        dict["text"] = text
        dict["anchor"] = anchor
        dict["style"] = style
        dict["gap"] = gap
        return dict
    }

    // MARK: the request

    func testAWholeRequestShouldParseEveryField() throws {
        let tooltip = try XCTUnwrap(StripTooltip.parse(request()))
        XCTAssertEqual(tooltip.text, "Open…  ⌘O")
        XCTAssertEqual(tooltip.anchor, CGRect(x: 100, y: 5, width: 26, height: 24))
        XCTAssertEqual(tooltip.gap, 6)
        XCTAssertEqual(tooltip.style.background, CSSColor(red: 30 / 255, green: 30 / 255, blue: 30 / 255))
        XCTAssertEqual(tooltip.style.ink, CSSColor(red: 1, green: 1, blue: 1))
        XCTAssertEqual(tooltip.style.fontSize, 12)
        XCTAssertEqual(tooltip.style.radius, 5)
        XCTAssertEqual(tooltip.style.padX, 8)
        XCTAssertEqual(tooltip.style.padY, 4)
    }

    func testANullTextShouldMeanTakeItAway() {
        XCTAssertNil(StripTooltip.parse(request(text: NSNull())))
        XCTAssertNil(StripTooltip.parse(request(text: "")))
    }

    func testARequestThatCannotBeDrawnShouldTakeTheChipAwayRatherThanKeepTheLast() {
        // Each of these is a request with nothing to draw from, and the answer
        // to all of them has to be the same as a null text: a chip left up
        // from the request before would be naming the wrong control.
        XCTAssertNil(StripTooltip.parse(request(anchor: nil)))
        XCTAssertNil(StripTooltip.parse(request(anchor: ["x": 1, "y": 2, "width": 3])))
        XCTAssertNil(StripTooltip.parse(request(style: nil)))
        var unparsed = request()
        unparsed["style"] = ["background": "papayawhip", "color": "rgb(0, 0, 0)", "fontSize": 12]
        XCTAssertNil(StripTooltip.parse(unparsed), "a colour that did not parse must not be drawn as black")
        var sizeless = request()
        sizeless["style"] = ["background": "rgb(0, 0, 0)", "color": "rgb(0, 0, 0)", "fontSize": 0]
        XCTAssertNil(StripTooltip.parse(sizeless))
    }

    func testTheMessageShouldReachTheBridgeAsItsOwnCase() {
        let live = #"{"type":"stripTooltip","text":"Find","anchor":{"x":1,"y":2,"width":3,"height":4},"gap":6,"style":{"background":"rgb(0, 0, 0)","color":"rgb(255, 255, 255)","fontSize":12,"radius":5,"padX":8,"padY":4}}"#
        guard case let .stripTooltip(tooltip)? = WebviewMessage.parse(live) else {
            return XCTFail("the request did not arrive as a stripTooltip")
        }
        XCTAssertEqual(tooltip?.text, "Find")
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"stripTooltip","text":null}"#), .stripTooltip(nil))
    }

    // MARK: colours, in the three spellings a computed style uses

    func testEverySpellingAComputedStyleUsesShouldParse() {
        XCTAssertEqual(CSSColor(css: "rgb(255, 0, 51)"), CSSColor(red: 1, green: 0, blue: 0.2))
        XCTAssertEqual(CSSColor(css: "rgba(0, 0, 0, 0.5)"), CSSColor(red: 0, green: 0, blue: 0, alpha: 0.5))
        XCTAssertEqual(CSSColor(css: "rgb(0 0 0 / 50%)"), CSSColor(red: 0, green: 0, blue: 0, alpha: 0.5))
        XCTAssertEqual(CSSColor(css: "color(srgb 0.25 0.5 1)"), CSSColor(red: 0.25, green: 0.5, blue: 1))
        XCTAssertEqual(CSSColor(css: "color(srgb 0.25 0.5 1 / 0.75)"),
                       CSSColor(red: 0.25, green: 0.5, blue: 1, alpha: 0.75))
    }

    func testAnythingElseShouldBeRefusedRatherThanGuessed() {
        for css in ["", "red", "#ff0000", "rgb(1, 2)", "rgb(a, b, c)", "color(display-p3 1 0 0)", "rgb(1, 2, 3"] {
            XCTAssertNil(CSSColor(css: css), css)
        }
    }

    // MARK: where the chip goes

    private func tooltip(anchorX: CGFloat) throws -> StripTooltip {
        try XCTUnwrap(StripTooltip.parse(request(anchor: ["x": anchorX, "y": 5, "width": 26, "height": 24])))
    }

    func testTheChipShouldSitCentredUnderItsControlAtThePagesGap() throws {
        let origin = try tooltip(anchorX: 100).origin(chip: CGSize(width: 80, height: 25), viewportWidth: 800)
        XCTAssertEqual(origin.x, 100 + 13 - 40)
        XCTAssertEqual(origin.y, 5 + 24 + 6, "against the control, which is the whole point of the handover")
    }

    func testTheChipShouldBeHeldInsideTheWindowOnBothSides() throws {
        let size = CGSize(width: 80, height: 25)
        XCTAssertEqual(try tooltip(anchorX: 0).origin(chip: size, viewportWidth: 800).x, StripTooltip.edgeInset)
        XCTAssertEqual(try tooltip(anchorX: 790).origin(chip: size, viewportWidth: 800).x,
                       800 - 80 - StripTooltip.edgeInset)
    }
}
