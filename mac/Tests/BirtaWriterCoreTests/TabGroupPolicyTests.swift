import XCTest
@testable import BirtaWriterCore

/// The tab rules with no window: grouping, closing, the band split, and the
/// chords.
final class TabGroupPolicyTests: XCTestCase {
    private func cmd(_ characters: String, shift: Bool = false, option: Bool = false, control: Bool = false) -> TabGroupPolicy.Chord {
        TabGroupPolicy.Chord(characters: characters, command: true, shift: shift, option: option, control: control)
    }

    // MARK: grouping

    func testLooseFilesShareOneIdentifierAndADirectoryGetsItsOwn() {
        let notes = TabGroupPolicy.tabbingIdentifier(bundleID: "b", root: nil)
        let folder = TabGroupPolicy.tabbingIdentifier(bundleID: "b", root: "/notes")
        let other = TabGroupPolicy.tabbingIdentifier(bundleID: "b", root: "/other")
        XCTAssertEqual(notes, "b.notes")
        XCTAssertNotEqual(folder, notes, "a folder's tabs never merge with loose notes")
        XCTAssertNotEqual(folder, other, "two folders never merge with each other")
        XCTAssertNotEqual(TabGroupPolicy.tabbingIdentifier(bundleID: "dev", root: nil), notes,
                          "a development build never offers to merge with the release")
    }

    // MARK: closing

    func testCloseTakesTheTabUnlessItIsTheLastWindow() {
        XCTAssertEqual(TabGroupPolicy.whatCloseDoes(windows: 3), .closeTab)
        XCTAssertEqual(TabGroupPolicy.whatCloseDoes(windows: 1), .hideAll)
    }

    func testCloseWindowTakesEveryTabUnlessThatIsEveryWindow() {
        XCTAssertEqual(TabGroupPolicy.whatCloseWindowDoes(tabsInWindow: 2, windows: 5), .closeWindow)
        XCTAssertEqual(TabGroupPolicy.whatCloseWindowDoes(tabsInWindow: 3, windows: 3), .hideAll)
        XCTAssertEqual(TabGroupPolicy.whatCloseWindowDoes(tabsInWindow: 1, windows: 1), .hideAll)
    }

    // MARK: the band

    func testTheBandSplitsIntoTitleRowAndTabBar() {
        let split = TabGroupPolicy.bandSplit(band: 68, tabBar: 36)
        XCTAssertEqual(split.titleRow, 32)
        XCTAssertEqual(split.tabBar, 36)
    }

    func testNoTabBarLeavesTheWholeBandAsTheTitleRow() {
        let split = TabGroupPolicy.bandSplit(band: 32, tabBar: 0)
        XCTAssertEqual(split.titleRow, 32)
        XCTAssertEqual(split.tabBar, 0)
    }

    func testATabBarTallerThanTheBandCannotMakeTheTitleRowNegative() {
        let split = TabGroupPolicy.bandSplit(band: 20, tabBar: 36)
        XCTAssertEqual(split.titleRow, 0)
        XCTAssertEqual(split.tabBar, 20)
    }

    // MARK: chords

    func testCmdDigitPicksThatTabAndCmdNinePicksTheLast() {
        XCTAssertEqual(TabGroupPolicy.tabSelection(for: cmd("1"), count: 4, selected: 2), 0)
        XCTAssertEqual(TabGroupPolicy.tabSelection(for: cmd("3"), count: 4, selected: 0), 2)
        XCTAssertEqual(TabGroupPolicy.tabSelection(for: cmd("9"), count: 4, selected: 0), 3,
                       "nine is the last tab whatever its number")
        XCTAssertNil(TabGroupPolicy.tabSelection(for: cmd("7"), count: 4, selected: 0),
                     "a digit past the end selects nothing rather than another tab")
    }

    func testShiftCmdBracketsStepWithWraparoundInEitherSpelling() {
        XCTAssertEqual(TabGroupPolicy.tabSelection(for: cmd("]", shift: true), count: 3, selected: 2), 0)
        XCTAssertEqual(TabGroupPolicy.tabSelection(for: cmd("}", shift: true), count: 3, selected: 0), 1)
        XCTAssertEqual(TabGroupPolicy.tabSelection(for: cmd("[", shift: true), count: 3, selected: 0), 2)
        XCTAssertEqual(TabGroupPolicy.tabSelection(for: cmd("{", shift: true), count: 3, selected: 1), 0)
    }

    func testAChordThatIsNotATabChordSelectsNothing() {
        XCTAssertNil(TabGroupPolicy.tabSelection(for: cmd("1"), count: 1, selected: 0), "one tab: nothing to select")
        XCTAssertNil(TabGroupPolicy.tabSelection(for: cmd("1", option: true), count: 3, selected: 0),
                     "Cmd+Option+1 is Heading 1's chord and must reach the page")
        XCTAssertNil(TabGroupPolicy.tabSelection(for: cmd("1", control: true), count: 3, selected: 0))
        XCTAssertNil(TabGroupPolicy.tabSelection(for: cmd("]"), count: 3, selected: 0),
                     "Cmd+] without Shift is Indent and must reach the page")
        XCTAssertNil(TabGroupPolicy.tabSelection(for: cmd("0"), count: 3, selected: 0), "Cmd+0 is Actual Size")
        XCTAssertNil(TabGroupPolicy.tabSelection(
            for: TabGroupPolicy.Chord(characters: "1", command: false), count: 3, selected: 0))
    }
}
