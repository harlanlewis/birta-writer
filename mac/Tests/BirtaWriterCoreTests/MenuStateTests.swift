import XCTest
@testable import BirtaWriterCore

/// What a menu row draws of the state it toggles, decided without a menu.
final class MenuStateTests: XCTestCase {
    func testAnOptionTheReaderNeverTouchedShouldReadAsOn() {
        // The host stores only what was CHANGED, and every proofreading option
        // ships on. Reading an absent answer as off is the failure this pins:
        // it would draw a menu of unchecked rows over a document being checked,
        // and the reader's fix for that is to flip the row twice.
        let state = MenuState(proofreadOptions: ["spellCheck": false])
        XCTAssertFalse(state.isOn(.proofread("spellCheck")))
        XCTAssertTrue(state.isOn(.proofread("grammarCheck")))
        XCTAssertTrue(state.isOn(.proofread("styleCheck")))
        XCTAssertTrue(state.isOn(.proofread("proofreading")))
        XCTAssertTrue(state.isOn(.proofread("fillers")))
    }

    func testTheNoteHighlightShouldAnswerFromItsOwnFieldAndNotTheProofreadOptions() {
        // Sibling of the proofreading gate, not a child: an option map that
        // happened to hold the word must not decide it.
        let off = MenuState(proofreadOptions: ["noteHighlight": true], noteHighlight: false)
        XCTAssertFalse(off.isOn(.noteHighlight))
        XCTAssertTrue(MenuState(noteHighlight: true).isOn(.noteHighlight))
    }

    func testTheOutlinePanelShouldAnswerFromWhetherItIsOut() {
        XCTAssertTrue(MenuState(tocShown: true).isOn(.tocShown))
        XCTAssertFalse(MenuState(tocShown: false).isOn(.tocShown))
    }

    func testTheDefaultsShouldBeWhatAFirstLaunchSees() {
        // A window that has never been told anything: proofreading on,
        // markers on, outline shut. The panel's first launch is exactly this,
        // and a default that disagreed with the page would draw a menu that
        // was wrong before the reader had touched a thing.
        let fresh = MenuState()
        XCTAssertTrue(fresh.isOn(.proofread("proofreading")))
        XCTAssertTrue(fresh.isOn(.noteHighlight))
        XCTAssertFalse(fresh.isOn(.tocShown))
    }

    // MARK: - Recording what a window's page reports

    /// Every toggle the menus DRAW.
    ///
    /// The style rows are DERIVED from `StyleCategory.allCases`, which is the
    /// same registry `AppMenu.styleOptionRows` builds them from, so a fifteenth
    /// category joins this sweep the day it lands rather than the day somebody
    /// remembers. Written out by hand it sampled one of the fourteen and the
    /// count assertion below could only have failed if an entry were deleted,
    /// which is a list a new case never joins.
    ///
    /// The six above them are written out because they are in no enum: four
    /// gate keys the page owns (`ProofreadOptionKey` in shared/messages.ts) and
    /// the two toggles that are not proofreading options at all.
    private static let everyToggle: [MenuToggle] =
        [.proofread("proofreading"), .proofread("spellCheck"),
         .proofread("grammarCheck"), .proofread("styleCheck"),
         .noteHighlight, .tocShown]
        + StyleCategory.allCases.map { MenuToggle.proofread($0.rawValue) }

    func testEveryToggleTheMenusDrawShouldAlsoBeOneTheyCanRecord() {
        // The failure this rules out: a toggle that `isOn` answers and `record`
        // silently drops would draw a checkmark that never changed, and the row
        // would then invert whatever it claimed. Asserted over the same
        // vocabulary both halves read, in both directions.
        // Against the registry, not against the literal: this fails when a new
        // category stops being swept, which a floor on the literal's own length
        // never could.
        XCTAssertEqual(Self.everyToggle.count, StyleCategory.allCases.count + 6)
        XCTAssertGreaterThan(StyleCategory.allCases.count, 10)
        for toggle in Self.everyToggle {
            var state = MenuState()
            state.record(toggle, on: false)
            XCTAssertFalse(state.isOn(toggle), "\(toggle) did not record off")
            state.record(toggle, on: true)
            XCTAssertTrue(state.isOn(toggle), "\(toggle) did not record on")
        }
    }

    func testRecordingOneToggleShouldLeaveTheOthersAlone() {
        // A window's state is several independent answers, so a recorder that
        // reset its neighbours would make the menu bar report the last row
        // touched rather than the window.
        var state = MenuState()
        state.record(.proofread("spellCheck"), on: false)
        XCTAssertFalse(state.isOn(.proofread("spellCheck")))
        XCTAssertTrue(state.isOn(.proofread("grammarCheck")))
        XCTAssertTrue(state.isOn(.noteHighlight))
        XCTAssertFalse(state.isOn(.tocShown))
    }

    func testTwoStatesShouldNotShareStorage() {
        // The whole point of putting this on a value per window: one window's
        // flip must not reach another's menus. A reference type here would make
        // the multi-window bug this replaced unfixable.
        var a = MenuState()
        var b = a
        a.record(.proofread("spellCheck"), on: false)
        b.record(.tocShown, on: true)
        XCTAssertTrue(b.isOn(.proofread("spellCheck")), "a window's flip reached another window")
        XCTAssertFalse(a.isOn(.tocShown), "a window's flip reached another window")
    }

}
