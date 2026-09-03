import XCTest
@testable import BirtaWriterCore

/// Which Space a window belongs to, decided without a window.
///
/// The AppKit half, and the flags this must never produce, are
/// `PanelWindowPolicyTests`. What is here is the decision: that the Dock
/// setting is what picks, and that it picks differently in the two directions.
final class WindowPolicyTests: XCTestCase {
    func testAnAppWithADockIconShouldKeepItsWindowOnOneSpace() {
        XCTAssertEqual(WindowPolicy.membership(showInDock: true), .ownSpace)
    }

    func testAnAppReachedOnlyByItsHotkeyShouldBringItsWindowToTheReader() {
        XCTAssertEqual(WindowPolicy.membership(showInDock: false), .followsReader)
    }

    /// The setting DISCRIMINATES, which neither case above says on its own: a
    /// function answering the same thing for both inputs satisfies one of them
    /// and is the whole failure worth pinning here.
    func testTheTwoSettingsShouldNotGetTheSameAnswer() {
        XCTAssertNotEqual(WindowPolicy.membership(showInDock: true),
                          WindowPolicy.membership(showInDock: false))
    }

    /// Every answer the type has is one the rule can reach. A case nothing
    /// returns is a case no reader of this file can act on, and a mapping in
    /// `AppPanel` would carry a branch for it forever.
    func testEveryMembershipShouldBeReachable() {
        let reached = Set([true, false].map(WindowPolicy.membership(showInDock:)))
        XCTAssertEqual(reached, Set(WindowPolicy.SpaceMembership.allCases))
    }
}
