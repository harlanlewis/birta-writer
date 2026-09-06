import AppKit
import XCTest
@testable import BirtaWriter
@testable import BirtaWriterCore

/// The sheet that answers a check somebody asked for, built and read back
/// without a window and without anything appearing on screen.
///
/// What it must hold is the other half of `UpdatePromptTests`: that one
/// checks the unasked offer arrives with its buttons DEAD, and this checks
/// the asked-for answer arrives with them live, every button reachable, and
/// the keys where a Mac puts them.
@MainActor
final class UpdateCheckPromptTests: XCTestCase {
    private func report(_ answer: UpdatePolicy.CheckAnswer) -> UpdatePolicy.CheckReport {
        UpdatePolicy.checkReport(answer, appName: "Birta Writer", current: "2026.826.0")
    }

    func testAFindShouldOfferBothWaysInAndAWayOutAllLive() {
        let alert = UpdateCheckPrompt.build(report(.found(latest: "v2026.905.0", staged: false)))
        XCTAssertEqual(alert.buttons.map(\.title),
                       [UpdatePolicy.installNowTitle, UpdatePolicy.installOnQuitTitle,
                        UpdatePolicy.notNowTitle])
        XCTAssertTrue(alert.buttons.allSatisfy(\.isEnabled), "an asked-for answer arrives live")
    }

    func testReturnShouldTakeTheFirstButtonAndEscapeTheLast() {
        let alert = UpdateCheckPrompt.build(report(.found(latest: "v2026.905.0", staged: true)))
        XCTAssertEqual(alert.buttons.first?.keyEquivalent, "\r")
        XCTAssertEqual(alert.buttons.last?.keyEquivalent, "\u{1b}")
        // And nothing in the middle answers to a key: Install on Next Launch
        // one keystroke from a dismissal is a swap nobody meant to arm.
        XCTAssertEqual(alert.buttons[1].keyEquivalent, "")
    }

    func testAnAnswerWithNothingToOfferShouldHaveOneButtonReturnTakes() {
        for answer in [UpdatePolicy.CheckAnswer.upToDate, .unreachable, .busy, .notThisBuild] {
            let alert = UpdateCheckPrompt.build(report(answer))
            XCTAssertEqual(alert.buttons.count, 1, "\(answer)")
            XCTAssertEqual(alert.buttons.first?.keyEquivalent, "\r", "\(answer)")
        }
    }

    func testEveryButtonShouldRouteToTheChoiceItNames() {
        let found = report(.found(latest: "v2026.905.0", staged: false))
        let first = NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        XCTAssertEqual(UpdateCheckPrompt.choice(for: found, response: .init(first)), .installNow)
        XCTAssertEqual(UpdateCheckPrompt.choice(for: found, response: .init(first + 1)), .installOnQuit)
        XCTAssertEqual(UpdateCheckPrompt.choice(for: found, response: .init(first + 2)), .dismiss)
        let armed = report(.armed(latest: "v2026.905.0"))
        XCTAssertEqual(UpdateCheckPrompt.choice(for: armed, response: .init(first)), .restartNow)
        XCTAssertEqual(UpdateCheckPrompt.choice(for: armed, response: .init(first + 1)), .dismiss)
        // A response the sheet never produced, or the sheet going away with
        // no button, is a dismissal and never an install.
        XCTAssertEqual(UpdateCheckPrompt.choice(for: found, response: .init(first + 9)), .dismiss)
        XCTAssertEqual(UpdateCheckPrompt.choice(for: report(.upToDate), response: .init(first)), .dismiss)
    }

    func testTheSheetShouldSayTheReportsOwnWords() {
        let made = report(.found(latest: "v2026.905.0", staged: false))
        let alert = UpdateCheckPrompt.build(made)
        XCTAssertEqual(alert.messageText, made.title)
        XCTAssertEqual(alert.informativeText, made.detail)
    }
}
