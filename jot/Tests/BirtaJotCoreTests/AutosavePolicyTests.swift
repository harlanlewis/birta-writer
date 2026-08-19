import XCTest
@testable import BirtaJotCore

final class AutosavePolicyTests: XCTestCase {
    func testAnEditWithAutosaveOnShouldBeDeferredRatherThanWrittenOnTheKeystroke() {
        XCTAssertEqual(AutosavePolicy.action(for: .edit, autosaveEnabled: true), .deferred)
    }

    func testAnEditWithAutosaveOffShouldNotBeWritten() {
        XCTAssertEqual(AutosavePolicy.action(for: .edit, autosaveEnabled: false), .skip)
    }

    /// The rule the whole type exists for. Autosave off means "stop writing
    /// while I type", never "discard the buffer when the panel closes or the
    /// app quits", and every one of these paths is a last chance to keep bytes
    /// that exist nowhere else.
    func testWithAutosaveOffEveryNonEditTriggerShouldStillWriteImmediately() {
        for trigger in [WriteTrigger.explicitSave, .panelHidden, .terminating] {
            XCTAssertEqual(
                AutosavePolicy.action(for: trigger, autosaveEnabled: false), .now,
                "\(trigger) must write even with autosave off")
        }
    }

    func testWithAutosaveOnEveryNonEditTriggerShouldAlsoWriteImmediately() {
        for trigger in [WriteTrigger.explicitSave, .panelHidden, .terminating] {
            XCTAssertEqual(AutosavePolicy.action(for: trigger, autosaveEnabled: true), .now)
        }
    }

    /// Over `allCases`, not a hand-written list, and that is the whole point.
    /// A list written here is a list that a fifth trigger never joins, so the
    /// sweep would go on passing having enumerated four of five. Deriving it
    /// from the enum makes the count below a real assertion about the type
    /// rather than a restatement of the line above it.
    func testEveryTriggerShouldBeDecidedUnderBothSettings() {
        XCTAssertEqual(WriteTrigger.allCases.count, 4, "a new trigger has to be decided here")
        for enabled in [true, false] {
            // Only the edit trigger may ever be anything but `.now`, which is
            // what makes the setting safe to expose at all.
            var decided = 0
            for trigger in WriteTrigger.allCases where trigger != .edit {
                XCTAssertEqual(AutosavePolicy.action(for: trigger, autosaveEnabled: enabled), .now)
                decided += 1
            }
            // A floor on what actually returned a verdict. Without it the loop
            // above passes by running zero times, which is what a filtered
            // enumeration does when the filter stops matching.
            XCTAssertEqual(decided, WriteTrigger.allCases.count - 1)
        }
    }

    /// The setting has to discriminate something, or it is decoration.
    func testTheSettingShouldChangeTheAnswerForAnEditAndForNothingElse() {
        XCTAssertNotEqual(
            AutosavePolicy.action(for: .edit, autosaveEnabled: true),
            AutosavePolicy.action(for: .edit, autosaveEnabled: false))
        for trigger in [WriteTrigger.explicitSave, .panelHidden, .terminating] {
            XCTAssertEqual(
                AutosavePolicy.action(for: trigger, autosaveEnabled: true),
                AutosavePolicy.action(for: trigger, autosaveEnabled: false))
        }
    }
}
