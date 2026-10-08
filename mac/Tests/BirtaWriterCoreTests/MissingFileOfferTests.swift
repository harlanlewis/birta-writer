import XCTest
@testable import BirtaWriterCore

/// What a window with no file it can write says, and which ways out it offers.
final class MissingFileOfferTests: XCTestCase {
    private func actions(_ state: MissingFileOffer.State) -> [MissingFileOffer.Action] {
        MissingFileOffer(state).actions
    }

    func testTheEmptyStateShouldOfferToOpenSomethingAndNothingElse() {
        let offer = MissingFileOffer(.noFile)
        XCTAssertEqual(offer.heading, "No File Open")
        XCTAssertEqual(offer.body, "")
        XCTAssertEqual(offer.actions, [.browse, .openRecent])
    }

    /// The Trash holds every byte the file had, and Restore leaves the buffer
    /// on screen, so it is the whole answer whether or not the reader typed
    /// since: Save It Back beside it would be a second button for one outcome.
    func testAFileInTheTrashShouldOfferRestoreAndNeverSaveItBack() {
        for atRisk in [false, true] {
            XCTAssertEqual(actions(.gone(inTrash: true, textAtRisk: atRisk)), [.restore, .browse, .openRecent],
                           "atRisk=\(atRisk)")
        }
        XCTAssertEqual(MissingFileOffer(.gone(inTrash: true, textAtRisk: false)).body, "",
                       "nothing at stake, so nothing to say beyond the heading")
        XCTAssertEqual(MissingFileOffer(.gone(inTrash: true, textAtRisk: true)).body,
                       MissingFileOffer.restoreKeepsSentence)
    }

    /// Gone with nothing to restore from: the screen is the only copy, so
    /// saving it is offered first, and only when there is something to save.
    func testAFileGoneForGoodShouldOfferSaveItBackOnlyWithTextOnScreen() {
        XCTAssertEqual(actions(.gone(inTrash: false, textAtRisk: true)), [.saveItBack, .browse, .openRecent])
        XCTAssertEqual(actions(.gone(inTrash: false, textAtRisk: false)), [.browse, .openRecent])
        XCTAssertTrue(MissingFileOffer(.gone(inTrash: false, textAtRisk: true)).body
            .contains(MissingFileOffer.atRiskSentence))
        XCTAssertFalse(MissingFileOffer(.gone(inTrash: false, textAtRisk: false)).body
            .contains(MissingFileOffer.atRiskSentence))
    }

    /// Restore is offered only where there is a trashed copy to move back: a
    /// control that cannot act is a question about the reader's file system.
    func testRestoreShouldNeedATrashedCopy() {
        for atRisk in [false, true] {
            XCTAssertFalse(actions(.gone(inTrash: false, textAtRisk: atRisk)).contains(.restore))
            XCTAssertFalse(actions(.noFile).contains(.restore))
        }
    }

    /// Every state offers a way to another file, and none offers to throw the
    /// buffer away: Discard and Start New is not a button any more.
    func testEveryStateShouldOfferAWayElsewhereAndNoneADiscard() {
        let states: [MissingFileOffer.State] = [
            .noFile,
            .gone(inTrash: true, textAtRisk: false), .gone(inTrash: true, textAtRisk: true),
            .gone(inTrash: false, textAtRisk: false), .gone(inTrash: false, textAtRisk: true),
        ]
        XCTAssertEqual(states.count, 5)
        for state in states {
            let offer = MissingFileOffer(state)
            XCTAssertEqual(Array(offer.actions.suffix(2)), [.browse, .openRecent], "\(state)")
            XCTAssertFalse(offer.heading.contains(".md"))
        }
    }
}
