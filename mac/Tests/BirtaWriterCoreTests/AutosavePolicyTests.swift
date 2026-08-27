import XCTest
@testable import BirtaWriterCore

final class AutosavePolicyTests: XCTestCase {
    func testAnEditWithAutosaveOnShouldBeDeferredRatherThanWrittenOnTheKeystroke() {
        XCTAssertEqual(AutosavePolicy.action(for: .edit, autosaveEnabled: true), .deferred)
    }

    func testAnEditWithAutosaveOffShouldNotBeWritten() {
        XCTAssertEqual(AutosavePolicy.action(for: .edit, autosaveEnabled: false), .skip)
    }

    func testWithAutosaveOnEveryNonEditTriggerShouldWriteImmediately() {
        for trigger in [WriteTrigger.explicitSave, .panelHidden, .terminating] {
            XCTAssertEqual(AutosavePolicy.action(for: trigger, autosaveEnabled: true), .now)
        }
    }

    /// Off means what the platform means by it: nothing is written that the
    /// user did not ask for. Hiding the panel is putting a window away in an
    /// application that is still running, so there is nothing to lose and
    /// nothing to ask.
    func testWithAutosaveOffHidingThePanelShouldNotWrite() {
        XCTAssertEqual(AutosavePolicy.action(for: .panelHidden, autosaveEnabled: false), .skip)
    }

    /// Quitting is the end of the buffer, which is the one moment the question
    /// has to be put rather than answered for the user in either direction.
    func testWithAutosaveOffQuittingShouldAsk() {
        XCTAssertEqual(AutosavePolicy.action(for: .terminating, autosaveEnabled: false), .ask)
    }

    /// Cmd+S is the user saying so, so the setting has nothing to say about it.
    func testAnExplicitSaveShouldWriteUnderEitherSetting() {
        for enabled in [true, false] {
            XCTAssertEqual(AutosavePolicy.action(for: .explicitSave, autosaveEnabled: enabled), .now)
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
            var decided = 0
            for trigger in WriteTrigger.allCases {
                // Every trigger has an answer, and no answer is invented: the
                // four cases are the whole of `WriteAction`, so this fails on
                // a fifth rather than passing over it.
                XCTAssertTrue(
                    [.now, .deferred, .skip, .ask]
                        .contains(AutosavePolicy.action(for: trigger, autosaveEnabled: enabled)),
                    "\(trigger) has no verdict with autosave \(enabled)")
                decided += 1
            }
            // A floor on what actually returned a verdict. Without it the loop
            // above passes by running zero times, which is what an
            // enumeration does when the thing it enumerates goes away.
            XCTAssertEqual(decided, WriteTrigger.allCases.count)
        }
    }

    /// Nothing is ever DISCARDED without being asked about.
    ///
    /// The sharp form of the promise, and the one worth a test of its own:
    /// `.skip` is only ever reached where the buffer stays in memory and can
    /// still be saved later. A trigger that ends the buffer must be `.now` or
    /// `.ask`, never `.skip`, whatever the setting says.
    func testATriggerThatEndsTheBufferShouldNeverBeSkipped() {
        for enabled in [true, false] {
            XCTAssertNotEqual(AutosavePolicy.action(for: .terminating, autosaveEnabled: enabled),
                              .skip, "quitting must not drop the buffer silently")
        }
    }

    /// The setting has to discriminate something, or it is decoration; and it
    /// must not discriminate where the user has asked outright.
    func testTheSettingShouldChangeTheAnswerForEveryTriggerButAnExplicitSave() {
        for trigger in [WriteTrigger.edit, .panelHidden, .terminating] {
            XCTAssertNotEqual(
                AutosavePolicy.action(for: trigger, autosaveEnabled: true),
                AutosavePolicy.action(for: trigger, autosaveEnabled: false),
                "the setting decides nothing for \(trigger)")
        }
        XCTAssertEqual(
            AutosavePolicy.action(for: .explicitSave, autosaveEnabled: true),
            AutosavePolicy.action(for: .explicitSave, autosaveEnabled: false))
    }

    /// The panel showing the first-run screen is on screen, which is why a
    /// visibility check alone passes it through. It is still nowhere to put
    /// the question: the write embargo that screen carries means the buffer
    /// and the file can never come back into step behind it, so the answer
    /// would be asked for and never given, and the quit waiting on it never
    /// finishes (MAR-411, reproduced: an Apple Event quit that never returns,
    /// a second one answered -128, and SIGTERM ignored).
    func testTheFirstRunScreenShouldBeNowhereToPutTheQuitQuestion() {
        XCTAssertFalse(AutosavePolicy.canAsk(panelIsUp: true, firstRunScreenIsUp: true,
                                             anotherSheetIsUp: false))
    }

    /// A panel that never came up cannot answer either: a sheet begun on it
    /// never calls back.
    func testAPanelThatIsNotOnScreenShouldBeNowhereToPutTheQuitQuestion() {
        XCTAssertFalse(AutosavePolicy.canAsk(panelIsUp: false, firstRunScreenIsUp: false,
                                             anotherSheetIsUp: false))
    }

    /// And it must still ASK in the ordinary case, or the setting's whole
    /// promise is gone: an answer of false everywhere would keep the bytes
    /// every time and never put the question, which passes both arms above.
    func testAPanelShowingTheDocumentShouldBeAskedTheQuitQuestion() {
        XCTAssertTrue(AutosavePolicy.canAsk(panelIsUp: true, firstRunScreenIsUp: false,
                                            anotherSheetIsUp: false))
    }

    /// A panel already showing a sheet is nowhere to put a SECOND question.
    ///
    /// A window shows one sheet at a time and queues the rest, so this one
    /// would wait behind the other while the quit waits on it, and somebody
    /// who pressed Quit would watch nothing happen. Reachable since the
    /// host-prompt seam gave the page its own sheet on this window (MAR-395):
    /// press Cmd+Q while answering `/help`, with autosave off and unsaved
    /// bytes. It belongs to the seam rather than to `/help`, so every flow
    /// that moves onto it later inherits the arm.
    func testAPanelAlreadyAskingSomethingElseShouldBeNowhereToPutTheQuitQuestion() {
        XCTAssertFalse(AutosavePolicy.canAsk(panelIsUp: true, firstRunScreenIsUp: false,
                                             anotherSheetIsUp: true))
    }

    /// All three inputs, enumerated, so a rule that stopped reading one of
    /// them is a failure rather than a pass. Written as the count of states
    /// that can be asked, which is one of the eight and would move if any
    /// input stopped mattering.
    func testExactlyOneOfTheEightStatesShouldBeAskable() {
        var askable = 0
        for panelIsUp in [true, false] {
            for firstRun in [true, false] {
                for otherSheet in [true, false] {
                    if AutosavePolicy.canAsk(panelIsUp: panelIsUp, firstRunScreenIsUp: firstRun,
                                             anotherSheetIsUp: otherSheet) {
                        askable += 1
                    }
                }
            }
        }
        XCTAssertEqual(askable, 1, "the question is putable in exactly one of the eight states")
    }
}
