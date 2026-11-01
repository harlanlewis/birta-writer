import XCTest
@testable import BirtaWriterCore

final class NoteModelTests: XCTestCase {
    // MARK: NoteHome

    /// The switch is the branch, and the stored path is what the OFF branch
    /// holds rather than an override of the switch.
    ///
    /// The pair is the whole claim: the same stored path resolves two
    /// different ways depending on the switch alone, which is what lets a
    /// folder somebody named be remembered through a trip to iCloud and back
    /// instead of being thrown away to keep the switch honest.
    func testTheSwitchShouldDecideAndAChosenFolderShouldBeTheOffBranchsValue() {
        XCTAssertEqual(NoteHome.inForce(preferICloud: true, hasChosenPath: true, iCloudAvailable: true), .iCloud)
        XCTAssertEqual(NoteHome.inForce(preferICloud: false, hasChosenPath: true, iCloudAvailable: true), .chosen)
        XCTAssertEqual(NoteHome.inForce(preferICloud: false, hasChosenPath: true, iCloudAvailable: false), .chosen)
    }

    /// Asking for iCloud on a machine without it lands on the folder they last
    /// named, not on the one under Documents. The branch that is left is the
    /// user's own, and its value is the one they set.
    func testPreferringICloudWithoutTheServiceShouldFallBackToTheChosenFolder() {
        XCTAssertEqual(NoteHome.inForce(preferICloud: true, hasChosenPath: true, iCloudAvailable: false), .chosen)
    }

    func testPreferringICloudOnAMachineThatHasItShouldLandInICloud() {
        XCTAssertEqual(NoteHome.inForce(preferICloud: true, hasChosenPath: false, iCloudAvailable: true), .iCloud)
    }

    /// The silent half of the old pairing, kept: a machine with iCloud Drive
    /// switched off falls back rather than failing. The row is what says so.
    func testPreferringICloudWithoutTheServiceShouldFallBackToDocuments() {
        XCTAssertEqual(NoteHome.inForce(preferICloud: true, hasChosenPath: false, iCloudAvailable: false), .documents)
    }

    func testNotPreferringICloudShouldLandInDocumentsWhateverTheMachineOffers() {
        XCTAssertEqual(NoteHome.inForce(preferICloud: false, hasChosenPath: false, iCloudAvailable: true), .documents)
        XCTAssertEqual(NoteHome.inForce(preferICloud: false, hasChosenPath: false, iCloudAvailable: false), .documents)
    }

    /// Enumerated rather than sampled: three booleans is eight states, and a
    /// resolver that ignored one of its inputs would still satisfy any hand
    /// picked subset of them.
    func testEveryCombinationOfTheThreeInputsShouldResolveToExactlyOneHome() {
        var seen: [NoteHome: Int] = [:]
        var count = 0
        for prefer in [true, false] {
            for chosen in [true, false] {
                for available in [true, false] {
                    let home = NoteHome.inForce(preferICloud: prefer, hasChosenPath: chosen,
                                                iCloudAvailable: available)
                    seen[home, default: 0] += 1
                    count += 1
                }
            }
        }
        XCTAssertEqual(count, 8)
        // All three reachable, so no option is dead in the popup.
        XCTAssertEqual(Set(seen.keys), Set(NoteHome.allCases))
    }

    // MARK: NoteMode

    func testEveryModeShouldBeNamedForTheMenuThatListsThem() {
        for mode in NoteMode.allCases {
            XCTAssertFalse(mode.title.isEmpty, String(describing: mode))
        }
        XCTAssertEqual(Set(NoteMode.allCases.map(\.title)).count, NoteMode.allCases.count)
    }

    /// A file from outside every open folder opens in a window of its own
    /// unless the reader chose tabs; the folder's own files are tabs of its
    /// window either way (OpenRoutingTests).
    func testAFileFromOutsideEveryFolderShouldOpenInAWindowByDefault() {
        XCTAssertEqual(FileOpenTarget.default, .window)
    }
}
