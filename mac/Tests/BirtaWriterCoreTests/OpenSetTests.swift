import XCTest
@testable import BirtaWriterCore

/// The launch rules over a recorded set of windows, with no disk and no
/// window server: every case injects its own existence and blankness
/// predicates, so nothing here depends on what is in /tmp.
final class OpenSetTests: XCTestCase {
    private let a = "/notes/A.md"
    private let b = "/notes/B.md"
    private let c = "/notes/C.md"
    private let blank = "/notes/Blank.md"
    private let pad = "/notes/Birta Writer.md"

    private let all: (String) -> Bool = { _ in true }
    private let none: (String) -> Bool = { _ in false }

    private func set(_ paths: [String], frames: [String?]? = nil) -> OpenSet {
        OpenSet(groups: paths.enumerated().map { index, path in
            OpenSet.Group(tabs: [path], frame: frames?[index] ?? nil)
        })
    }

    /// The plan with every knob at its quiet setting, so a case names only the
    /// knob it is about.
    private func plan(_ stored: OpenSet,
                      exists: ((String) -> Bool)? = nil,
                      isBlank: ((String) -> Bool)? = nil,
                      recents: [String] = [],
                      openToBlankNote: Bool = false,
                      launchedWith: String? = nil) -> OpenSet.LaunchPlan {
        OpenSet.launchPlan(stored: stored,
                           exists: exists ?? all,
                           isBlank: isBlank ?? none,
                           recents: recents,
                           fallback: pad,
                           openToBlankNote: openToBlankNote,
                           launchedWith: launchedWith)
    }

    // MARK: pruning

    func testATabWhoseFileIsGoneShouldBeDroppedAndItsEmptyGroupWithIt() {
        let stored = OpenSet(groups: [
            OpenSet.Group(tabs: [a, b], selected: 1),
            OpenSet.Group(tabs: [c]),
        ])
        let pruned = stored.pruned(exists: { $0 != b && $0 != c })
        XCTAssertEqual(pruned.groups.map(\.tabs), [[a]])
        XCTAssertEqual(pruned.groups[0].selected, 0, "the selection clamps into what is left")
    }

    /// B was showing at index 1; with A gone it sits at index 0, and a prune
    /// that only clamped the index would land on C. The tab that was showing
    /// is what stays selected, not the number.
    func testPruningShouldKeepTheTabThatWasShowingSelected() {
        let stored = OpenSet(groups: [OpenSet.Group(tabs: [a, b, c], selected: 1)])
        let gone = a
        let pruned = stored.pruned(exists: { $0 != gone })
        XCTAssertEqual(pruned.groups[0].selectedTab, b)
        XCTAssertEqual(pruned.groups[0].selected, 0)
    }

    func testSelectedTabShouldClampARecordingMadeWithMoreTabs() {
        XCTAssertEqual(OpenSet.Group(tabs: [a], selected: 4).selectedTab, a)
        XCTAssertNil(OpenSet.Group(tabs: [], selected: 0).selectedTab)
    }

    // MARK: restoring

    func testARecordedSetShouldComeBackInItsOrderWithItsFrames() {
        let stored = set([a, b, c], frames: ["{{0, 0}, {800, 600}}", nil, "{{40, 40}, {800, 600}}"])
        let restored = plan(stored)
        XCTAssertEqual(restored.groups.map(\.tabs), [[a], [b], [c]], "back to front, C in front")
        XCTAssertEqual(restored.groups.map(\.frame), ["{{0, 0}, {800, 600}}", nil, "{{40, 40}, {800, 600}}"])
        XCTAssertFalse(restored.opensBlankNote)
    }

    func testAnEmptyRecordingShouldOpenTheMostRecentlyUsedFileThatExists() {
        let gone = a
        let restored = plan(OpenSet(), exists: { $0 != gone }, recents: [a, b, c])
        XCTAssertEqual(restored.groups.map(\.tabs), [[b]], "A is gone, so B is the most recent that exists")
        XCTAssertFalse(restored.opensBlankNote)
    }

    func testAnEmptyRecordingWithNoRecentsShouldOpenWhatTheSettingsName() {
        let restored = plan(OpenSet(), exists: none, recents: [a])
        XCTAssertEqual(restored.groups.map(\.tabs), [[pad]])
    }

    // MARK: the file the launch was asked to open

    func testAFileTheLaunchWasAskedToOpenShouldBeInFrontOfTheRestoredSet() {
        let restored = plan(set([a, b]), launchedWith: c)
        XCTAssertEqual(restored.groups.map(\.tabs), [[a], [b], [c]])
        XCTAssertFalse(restored.opensBlankNote)
    }

    func testAFileAlreadyOpenShouldBeFrontedRatherThanOpenedAgain() {
        let stored = OpenSet(groups: [OpenSet.Group(tabs: [a, b], selected: 1), OpenSet.Group(tabs: [c])])
        let restored = plan(stored, launchedWith: a)
        XCTAssertEqual(restored.groups.map(\.tabs), [[c], [a, b]], "A's group moved to the front")
        XCTAssertEqual(restored.groups.last?.selectedTab, a, "and A is the tab showing")
    }

    /// Two spellings of one file are one file, and the caller says how: the
    /// plan must front the recorded window rather than open a second one over
    /// the same bytes, which is the two-writers hazard the Open gesture refuses.
    func testAFileRecordedUnderAnotherSpellingShouldBeFrontedNotOpenedAgain() {
        let viaLink = "/Users/me/notes/A.md"
        let restored = OpenSet.launchPlan(stored: set([a, b]),
                                          exists: all, isBlank: none, recents: [], fallback: pad,
                                          openToBlankNote: false,
                                          launchedWith: viaLink,
                                          sameFile: { $0.hasSuffix("/A.md") && $1.hasSuffix("/A.md") || $0 == $1 })
        XCTAssertEqual(restored.groups.map(\.tabs), [[b], [a]], "A's own group fronted; no group for the other spelling")
    }

    func testAFileTheLaunchWasAskedToOpenShouldOutrankTheBlankNoteSetting() {
        let restored = plan(set([a]), openToBlankNote: true, launchedWith: b)
        XCTAssertEqual(restored.groups.map(\.tabs), [[a], [b]])
        XCTAssertFalse(restored.opensBlankNote, "somebody who double-clicked a file did not ask for a blank note")
    }

    // MARK: the blank-note setting

    func testTheBlankNoteSettingShouldAddANoteInFrontRatherThanDropTheSet() {
        let restored = plan(set([a, b]), openToBlankNote: true)
        XCTAssertEqual(restored.groups.map(\.tabs), [[a], [b]], "the arrangement comes back")
        XCTAssertTrue(restored.opensBlankNote, "and a fresh note goes in front of it")
    }

    func testABlankNoteAlreadyOpenShouldBeFrontedRatherThanJoinedByAnother() {
        let empty = blank
        let restored = plan(set([blank, a]), isBlank: { $0 == empty }, openToBlankNote: true)
        XCTAssertEqual(restored.groups.map(\.tabs), [[a], [blank]], "the blank one moves to the front")
        XCTAssertFalse(restored.opensBlankNote, "a second empty note would accumulate on every launch")
    }

    func testTheBlankNoteSettingOverAnEmptyRecordingShouldOpenOnlyTheBlankNote() {
        let restored = plan(OpenSet(), recents: [a], openToBlankNote: true)
        XCTAssertTrue(restored.groups.isEmpty, "nothing to restore, and the recents rule is not consulted")
        XCTAssertTrue(restored.opensBlankNote)
    }

    // MARK: storage

    func testTheSetShouldSurviveARoundTripThroughItsStoredForm() throws {
        let stored = OpenSet(groups: [
            OpenSet.Group(root: "/notes", tabs: [a, b], selected: 1, frame: "{{1, 2}, {3, 4}}"),
            OpenSet.Group(tabs: [c]),
        ])
        let back = OpenSet.decoded(try stored.encoded())
        XCTAssertEqual(back, stored)
    }

    func testBytesThatAreNotASetShouldDecodeToNothingRatherThanThrow() {
        XCTAssertNil(OpenSet.decoded(Data("not json".utf8)))
        XCTAssertNil(OpenSet.decoded(Data("{\"groups\": 3}".utf8)))
    }

    func testFrontingAPathNoGroupHoldsShouldAnswerNil() {
        XCTAssertNil(set([a]).fronting(b))
    }
}
