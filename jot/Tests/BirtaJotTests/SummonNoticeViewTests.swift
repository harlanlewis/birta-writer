import AppKit
import BirtaJotCore
import Carbon.HIToolbox
import XCTest
@testable import BirtaJot

/// The drawing half of `SummonNotice`, plus the one exchange the notice has
/// with macOS.
///
/// `SummonNoticeTests` decides what the sentences ARE; nothing there can tell
/// you whether either of them reaches a label, or whether pressing a
/// combination in the recorder asks for it and reports the answer. This builds
/// the real view, lays it out, and reads the labels back.
@MainActor
final class SummonNoticeViewTests: XCTestCase {
    private let refused = HotkeyCombo.release
    private let replacement = try! HotkeyCombo.parse("cmd+ctrl+k").get()

    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    /// The view, laid out, plus the combinations it asked macOS for.
    private func make(_ answer: @escaping (HotkeyCombo) -> OSStatus)
        -> (view: SummonNoticeView, asked: () -> [HotkeyCombo]) {
        var asked: [HotkeyCombo] = []
        let view = SummonNoticeView(refused: refused, appName: "Birta Writer") { combo in
            asked.append(combo)
            return answer(combo)
        }
        view.view.layoutSubtreeIfNeeded()
        return (view, { asked })
    }

    func testTheNoticeShouldOpenNamingTheRefusedCombinationAndTheWayIn() {
        let (view, _) = make { _ in noErr }

        XCTAssertEqual(view.titleLabel.stringValue,
                       SummonNotice.refused(refused, appName: "Birta Writer").title)
        XCTAssertEqual(view.detailLabel.stringValue,
                       SummonNotice.refused(refused, appName: "Birta Writer").detail)
    }

    /// The recorder starts on the combination that failed, not empty. An empty
    /// field would be asking the user to remember what they had just been told.
    func testTheRecorderShouldOpenOnTheRefusedCombination() {
        let (view, _) = make { _ in noErr }

        XCTAssertEqual(view.recorder.combo, refused)
    }

    func testAnAcceptedCombinationShouldBeAskedForAndReported() {
        let (view, asked) = make { _ in noErr }

        view.chooseForTesting(replacement)

        XCTAssertEqual(asked(), [replacement], "the notice has to actually ask macOS for it")
        XCTAssertEqual(view.notice, .accepted(replacement, appName: "Birta Writer"))
        XCTAssertEqual(view.titleLabel.stringValue,
                       SummonNotice.accepted(replacement, appName: "Birta Writer").title)
    }

    /// The discriminating case. A notice that swapped to the accepted sentence
    /// on any press would pass the test above and tell somebody a dead key
    /// works, which is the exact failure this whole notice exists to end.
    func testASecondRefusalShouldNameTheSecondCombination() {
        let (view, _) = make { _ in OSStatus(eventHotKeyExistsErr) }

        view.chooseForTesting(replacement)

        XCTAssertEqual(view.notice, .refused(replacement, appName: "Birta Writer"))
        XCTAssertTrue(view.titleLabel.stringValue.contains(replacement.symbols))
        XCTAssertFalse(view.titleLabel.stringValue.contains(refused.symbols),
                       "the answer is about the key just pressed, not the one before it")
    }
}
