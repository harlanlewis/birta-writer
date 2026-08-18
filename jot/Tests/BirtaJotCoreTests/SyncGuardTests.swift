import XCTest
@testable import BirtaJotCore

final class SyncGuardTests: XCTestCase {
    func testAdmitsMonotonicSeqAtCurrentVersion() {
        var g = SyncGuard()
        XCTAssertEqual(g.judge(baseSyncVersion: 0, seq: 1), .admit)
        XCTAssertEqual(g.judge(baseSyncVersion: 0, seq: 2), .admit)
        XCTAssertEqual(g.appliedSeq, 2)
    }

    func testStaleSeqIsDroppedAndDoesNotMoveTheMark() {
        var g = SyncGuard()
        _ = g.judge(baseSyncVersion: 0, seq: 5)
        XCTAssertEqual(g.judge(baseSyncVersion: 0, seq: 3), .staleSeq)
        XCTAssertEqual(g.judge(baseSyncVersion: 0, seq: 5), .staleSeq)
        XCTAssertEqual(g.appliedSeq, 5)
    }

    func testOldBaseAfterExternalUpdateIsRepushedNotApplied() {
        var g = SyncGuard()
        _ = g.judge(baseSyncVersion: 0, seq: 1)
        XCTAssertEqual(g.bumpVersion(), 1)
        // An update serialized before the externalUpdate landed carries base 0.
        XCTAssertEqual(g.judge(baseSyncVersion: 0, seq: 2), .repush)
        // The mark did not move: seq 2 is admissible once the page re-bases.
        XCTAssertEqual(g.judge(baseSyncVersion: 1, seq: 2), .admit)
    }

    func testBaseIsCheckedBeforeSeqLikeTheExtension() {
        var g = SyncGuard()
        _ = g.judge(baseSyncVersion: 0, seq: 5)
        _ = g.bumpVersion()
        // Wrong base AND stale seq: the verdict is the base one, matching
        // src/MarkdownEditorProvider.ts, which asks isAdmissibleBase first.
        XCTAssertEqual(g.judge(baseSyncVersion: 0, seq: 3), .repush)
    }

    func testReadyResetsBothCounters() {
        var g = SyncGuard()
        _ = g.judge(baseSyncVersion: 0, seq: 9)
        _ = g.bumpVersion()
        g.resetForReady()
        XCTAssertEqual(g, SyncGuard())
        // A reloaded page numbers from 1 again and must not read as stale.
        XCTAssertEqual(g.judge(baseSyncVersion: 0, seq: 1), .admit)
    }
}
