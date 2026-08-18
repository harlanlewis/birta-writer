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

    /// The enumeration asserts its own size: a new trigger has to be decided
    /// here rather than inheriting whatever the last `case` happened to be.
    func testEveryTriggerShouldBeDecidedUnderBothSettings() {
        let triggers: [WriteTrigger] = [.edit, .explicitSave, .panelHidden, .terminating]
        XCTAssertEqual(triggers.count, 4)
        for enabled in [true, false] {
            let actions = triggers.map { AutosavePolicy.action(for: $0, autosaveEnabled: enabled) }
            XCTAssertEqual(actions.count, 4)
            // Only the edit trigger may ever be anything but `.now`, which is
            // what makes the setting safe to expose at all.
            for (trigger, action) in zip(triggers, actions) where trigger != .edit {
                XCTAssertEqual(action, .now)
            }
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
