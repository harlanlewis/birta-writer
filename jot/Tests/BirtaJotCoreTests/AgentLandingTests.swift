import XCTest
@testable import BirtaJotCore

/// Where a finished `/ai` run's edit lands, over every arrangement of the
/// three strings that decide it.
///
/// `handoff` is what the agent opened, `onDisk` what it left, `buffer` what
/// the panel holds. Only two comparisons matter, so the space is small enough
/// to enumerate rather than sample: whether the file moved, and whether the
/// panel did.
final class AgentLandingTests: XCTestCase {
    private let opened = "# Note\n\nOriginal body.\n"
    private let agentWrote = "# Note\n\nRewritten body.\n"
    private let typed = "# Note\n\nOriginal body. And a sentence I typed.\n"

    func testAFileTheRunLeftAloneShouldSettleWhateverThePanelHolds() {
        XCTAssertEqual(
            AgentLandingPolicy.landing(handoff: opened, onDisk: opened, buffer: opened), .settle)
        XCTAssertEqual(
            AgentLandingPolicy.landing(handoff: opened, onDisk: opened, buffer: typed), .settle,
            "there is nothing to bring in, so the panel is not read over either")
    }

    func testAPanelInStepWithTheHandoffShouldReload() {
        XCTAssertEqual(
            AgentLandingPolicy.landing(handoff: opened, onDisk: agentWrote, buffer: opened),
            .reload)
    }

    func testAPanelChangedDuringTheRunShouldMergeTheFilesBytes() {
        XCTAssertEqual(
            AgentLandingPolicy.landing(handoff: opened, onDisk: agentWrote, buffer: typed),
            .merge(diskText: agentWrote))
    }

    /// The case the whole policy exists for, stated as the invariant rather
    /// than as one arrangement: whenever the panel holds something the run
    /// never saw, the buffer is not read over.
    func testNoLandingShouldReadOverAPanelTheRunNeverSaw() {
        let files = ["", opened, agentWrote, typed]
        var checked = 0
        for onDisk in files where onDisk != opened {
            for buffer in files where buffer != opened {
                let landing = AgentLandingPolicy.landing(
                    handoff: opened, onDisk: onDisk, buffer: buffer)
                XCTAssertFalse(landing.reloadsBuffer,
                               "onDisk=\(onDisk.count) buffer=\(buffer.count) would discard the panel")
                checked += 1
            }
        }
        XCTAssertEqual(checked, 9, "the sweep reached every arrangement it claims to have")
    }

    func testOnlyAMergeShouldGiveThePageText() {
        XCTAssertNil(AgentLanding.settle.pageText)
        XCTAssertNil(AgentLanding.reload.pageText)
        XCTAssertEqual(AgentLanding.merge(diskText: agentWrote).pageText, agentWrote)
    }

    func testOnlyAReloadShouldTakeTheFileIntoTheBuffer() {
        XCTAssertFalse(AgentLanding.settle.reloadsBuffer)
        XCTAssertTrue(AgentLanding.reload.reloadsBuffer)
        XCTAssertFalse(AgentLanding.merge(diskText: agentWrote).reloadsBuffer)
    }

    /// The two answers are exclusive: a landing never both replaces the buffer
    /// and asks the page to merge, which would be two writes racing.
    func testALandingShouldNeverBothReloadAndMerge() {
        for landing: AgentLanding in [.settle, .reload, .merge(diskText: agentWrote)] {
            XCTAssertFalse(landing.reloadsBuffer && landing.pageText != nil, "\(landing)")
        }
    }
}
