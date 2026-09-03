import AppKit
import BirtaWriterCore
import XCTest
@testable import BirtaWriter

/// How the window sits among other applications' windows, read off a built one.
///
/// `BirtaWriterCore.WindowPolicy` decides which Space a window belongs to and
/// says why; this is the half that file cannot see, and it is the half where
/// the defect was. What went wrong is an ABSENCE: `.fullScreenAuxiliary` drew
/// this window over whatever anybody went full screen into, and no check
/// written over a decision function can notice a flag nobody decided. So the
/// assertions below are about flags that must NOT be on a real
/// `NSWindow.CollectionBehavior`, swept over every answer the policy has.
///
/// Nothing is shown. A panel reports its own level and collection behaviour
/// with no order-front, which is what lets this run with no window server
/// gesture at all. The live app is read by `mac/scripts/measure.sh`, which
/// covers what a built-and-never-shown window cannot: that AppKit kept what it
/// was given once the window was on screen.
@MainActor
final class PanelWindowPolicyTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    /// `remembersFrame: false` throughout, for the reason `PanelCloseTests`
    /// gives: a panel that names itself writes the frame autosave into the
    /// app's standard defaults whatever the throwaway suite says.
    private func panel() -> AppPanel { AppPanel(remembersFrame: false) }

    /// The two flags this window must never carry, whatever else it does.
    ///
    /// Swept over `SpaceMembership.allCases` rather than over the one the
    /// machine running the suite happens to have set, because both are shipped
    /// configurations and the rule is the same in both. Derived from the enum,
    /// so a third answer is covered the day it lands, and the sweep asserts its
    /// own size: one that reached nothing would pass having checked nothing.
    func testNoAnswerShouldPutTheWindowOverAnotherAppsFullScreen() {
        var swept = 0
        for membership in WindowPolicy.SpaceMembership.allCases {
            let behavior = AppPanel.collectionBehavior(for: membership)
            XCTAssertFalse(behavior.contains(.fullScreenAuxiliary),
                           "\(membership.rawValue) accompanies another window's full screen")
            XCTAssertFalse(behavior.contains(.canJoinAllSpaces),
                           "\(membership.rawValue) draws the window on every Space at once")
            XCTAssertTrue(behavior.contains(.fullScreenPrimary),
                          "\(membership.rawValue) cannot take a full screen of its own")
            swept += 1
        }
        XCTAssertEqual(swept, WindowPolicy.SpaceMembership.allCases.count)
        XCTAssertGreaterThan(swept, 0)
    }

    /// The one flag that is not the same in both answers.
    ///
    /// Asserted in both directions, because a mapping that returned
    /// `.moveToActiveSpace` for everything satisfies the sweep above and is the
    /// exact thing the Dock setting is meant to decide.
    func testOnlyTheDocklessAnswerShouldFollowTheReaderBetweenSpaces() {
        XCTAssertFalse(AppPanel.collectionBehavior(for: .ownSpace).contains(.moveToActiveSpace))
        XCTAssertTrue(AppPanel.collectionBehavior(for: .followsReader).contains(.moveToActiveSpace))
    }

    /// A built window carries what the policy answered for the setting as it
    /// stands, and re-reads it when told to.
    ///
    /// The wiring, which is what `collectionBehavior(for:)` on its own cannot
    /// claim: a mapping decided correctly and never assigned is invisible to
    /// every check above. Both settings are exercised through the real
    /// property, and the pref is put back whatever the assertions do.
    func testTheWindowShouldTakeAndRetakeThePolicyTheDockSettingImplies() {
        let restore = Prefs.showInDock
        defer { Prefs.showInDock = restore }

        Prefs.showInDock = true
        let window = panel()
        XCTAssertEqual(window.collectionBehavior,
                       AppPanel.collectionBehavior(for: .ownSpace))

        Prefs.showInDock = false
        XCTAssertEqual(window.collectionBehavior,
                       AppPanel.collectionBehavior(for: .ownSpace),
                       "the window followed the setting with nobody telling it to")
        window.applyWindowPolicy()
        XCTAssertEqual(window.collectionBehavior,
                       AppPanel.collectionBehavior(for: .followsReader))
    }

    /// The two assignments beside the collection behaviour.
    ///
    /// `hidesOnDeactivate` is the one that overrides an `NSPanel` default, and
    /// the second arm is what says so: a bare panel of the same shape carries
    /// the opposite answer, so the assignment is doing work rather than
    /// restating what AppKit already did. The level is not such a case and this
    /// does not pretend it is; it is asserted because it is what shipped wrong,
    /// and `isFloatingPanel` can raise it from a line that never says `level`.
    func testTheWindowShouldSitAtTheOrdinaryLevelAndStayPutWhenTheAppGoesBehind() {
        let window = panel()
        XCTAssertEqual(window.level, .normal)
        XCTAssertFalse(window.hidesOnDeactivate)
        let bare = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 10, height: 10),
                           styleMask: [.titled], backing: .buffered, defer: true)
        XCTAssertTrue(bare.hidesOnDeactivate,
                      "an NSPanel no longer hides on deactivation, so that assignment is now a restatement")
        // And the level really is raised by the property, which is the whole
        // reason a level nobody wrote down cannot be read off the source.
        bare.isFloatingPanel = true
        XCTAssertEqual(bare.level, .floating)
    }
}
