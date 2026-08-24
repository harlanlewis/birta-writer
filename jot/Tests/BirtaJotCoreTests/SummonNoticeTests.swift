import XCTest
@testable import BirtaJotCore

/// What the refused-hotkey notice has to say.
///
/// Two obligations, and the second is the one the app spent a long time not
/// meeting: name the combination that was refused, so the reader knows which
/// key they have been pressing for nothing, and name the way in that still
/// works, because an `LSUIElement` app whose hotkey does nothing is
/// indistinguishable from an app that did not launch.
final class SummonNoticeTests: XCTestCase {
    private let combo = HotkeyCombo.release
    private let other = try! HotkeyCombo.parse("cmd+ctrl+k").get()

    func testARefusalShouldNameTheCombinationItIsAbout() {
        let notice = SummonNotice.refused(combo, appName: "Birta Writer")

        XCTAssertTrue(notice.title.contains(combo.symbols),
                      "the reader cannot tell which key is dead without seeing it named: \(notice.title)")
    }

    /// The discriminating half of the one above: a title hardcoding one
    /// combination would pass that test and fail this one.
    func testTwoRefusedCombinationsShouldReadDifferently() {
        let first = SummonNotice.refused(combo, appName: "Birta Writer")
        let second = SummonNotice.refused(other, appName: "Birta Writer")

        XCTAssertNotEqual(first, second)
        XCTAssertTrue(second.title.contains(other.symbols))
        XCTAssertFalse(second.title.contains(combo.symbols))
    }

    func testARefusalShouldNameTheMenuBarIconAsTheWayIn() {
        let notice = SummonNotice.refused(combo, appName: "Birta Writer")

        XCTAssertTrue(notice.detail.contains("menu bar"),
                      "the fallback is the whole point of saying anything: \(notice.detail)")
        XCTAssertTrue(notice.detail.contains("Birta Writer"))
    }

    /// The heading specifically, and not the notice as a whole. A popover is
    /// scanned from the top, so an accepted combination whose TITLE still read
    /// as a refusal would tell somebody their new key is dead while the small
    /// print underneath said otherwise, and comparing the two whole notices
    /// would call that a pass on the strength of the small print.
    func testAnAcceptedCombinationShouldNotReadAsARefusal() {
        let notice = SummonNotice.accepted(other, appName: "Birta Writer")

        XCTAssertTrue(notice.title.contains(other.symbols))
        XCTAssertNotEqual(notice.title, SummonNotice.refused(other, appName: "Birta Writer").title,
                          "a hotkey that works and one that does nothing must not read the same")
        XCTAssertNotEqual(notice.detail, SummonNotice.refused(other, appName: "Birta Writer").detail)
    }

    /// The app names itself from its flavour, so a development build's notice
    /// must say what a development build is called.
    func testTheNoticeShouldUseTheNameItIsGiven() {
        let notice = SummonNotice.refused(combo, appName: "Birta Writer [DEV]")

        XCTAssertTrue(notice.detail.contains("Birta Writer [DEV]"))
    }
}
