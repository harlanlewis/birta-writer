import XCTest
@testable import BirtaWriter

/// That the first run is actually WIRED, in the shipping app.
///
/// `FirstRunTests` holds the decision, `FirstRunInvitationTests` holds the
/// words and `FirstRunPopoverTests` holds the drawing, and every one of them
/// would stay green with the launch path cut: the rule would answer
/// `.invitation` and nothing would act on it, the popover would build and
/// never be shown, and a fresh install would open on an empty panel with no
/// tour and nothing in the menu bar. That is the shape AGENTS.md names, a
/// guard that is ABSENT rather than wrong, and it is invisible to every green
/// run.
///
/// A source-text guard rather than a live one, in the shape and for the reason
/// `WindowLifetimeTests` and `SummonRefusalWiringTests` give: reaching the
/// launch path means building a real `WindowSet` and `Coordinator`, which
/// builds a `WKWebView` and the WebKit helpers behind it, and nothing in this
/// suite starts WebKit today.
@MainActor
final class FirstRunWiringTests: XCTestCase {
    private func source(_ file: String) -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Sources/BirtaWriter/\(file)")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            XCTFail("could not read \(url.path); if \(file) moved, this guard must follow it")
            return ""
        }
        return text
    }

    /// Every hop from the launch to the three things a first run does, named.
    ///
    /// Each is a place the chain can be cut, and cutting any of them is
    /// silent. Enumerated so each names what its absence would cost, and the
    /// reach is `source`'s own guard: a file it cannot read fails, so a sweep
    /// over nothing cannot pass.
    func testEveryHopFromTheLaunchToTheFirstRunShouldBeWired() {
        let hops: [(file: String, needle: String, what: String)] = [
            ("App.swift", "if opening == .invitation { Self.seedFirstRunNote(isFirstRun: firstLaunch) }",
             "a fresh install opens on an empty panel with no tour in it"),
            ("App.swift", "Prefs.applyOnboardingDefaults(firstLaunch: launchWasFirst)",
             "the login item gates on a reading taken after the launch stored keys, and never registers"),
            ("App.swift", "guard let button = statusItem?.button else {",
             "with no menu bar item the invitation has no surface and the wait waits on nothing"),
            ("App.swift", "case .invitation: beginFirstRun(on: firstWindow)",
             "nothing acts on the decision, so the menu bar says nothing"),
            ("App.swift", "coordinator.onDidShow = { [weak self] in self?.finishFirstRun() }",
             "the panel coming up never ends the first run, so the popover stays "
                + "and the invitation is offered again on the next launch"),
            // The MAR-407 hop: this is the surface that teaches the chord, so
            // a chord macOS refused has to reach it here.
            ("App.swift", "refused: windows.refusedSummonCombo",
             "the popover teaches a chord macOS may already have refused"),
            ("Coordinator.swift", "onDidShow?()",
             "the panel never reports that it came up"),
        ]

        XCTAssertGreaterThan(hops.count, 5, "the list of hops is the subject; a shorter one dropped a hop")
        for hop in hops {
            XCTAssertTrue(source(hop.file).contains(hop.needle),
                          "\(hop.file) no longer carries `\(hop.needle)`, so \(hop.what)")
        }
    }

    /// The tour is written BEFORE the windows are made.
    ///
    /// The ordering is the whole of why the seed works: a launch reads its
    /// note off disk, so a tour written afterwards would have to be pushed
    /// into a page already holding the empty file, and the two writes would
    /// race. Both lines can be present in the wrong order and every needle
    /// above still passes.
    func testTheTourShouldBeWrittenBeforeTheWindowsAreMade() {
        let text = source("App.swift")
        guard let seed = text.range(of: "Self.seedFirstRunNote(isFirstRun:"),
              let open = text.range(of: "windows.openAtLaunch(") else {
            return XCTFail("the launch path no longer seeds or no longer opens windows")
        }
        XCTAssertLessThan(seed.lowerBound, open.lowerBound,
                          "the tour is written after the panel has already mounted the note")
    }

    /// Whether this is a first launch is read before the launch stores
    /// anything. The notes-folder offer records its derivation on every arm,
    /// and `Prefs.isFirstLaunch` is the absence of every key, so a reading
    /// taken after the offer calls every first launch an existing install:
    /// no login item, no tour, and nothing red anywhere, because the only
    /// runs that can reach the path are refused it by `isUserStore`.
    func testFirstLaunchShouldBeReadBeforeTheNotesOfferStoresAnything() {
        let text = source("App.swift")
        guard let read = text.range(of: "let firstLaunch = Prefs.isFirstLaunch"),
              let offer = text.range(of: "NotesMoveOffer.offerAtLaunch()") else {
            return XCTFail("the launch no longer reads first-launch into a local, or no longer offers the move")
        }
        XCTAssertLessThan(read.lowerBound, offer.lowerBound,
                          "first-launch is read after the notes offer has stored keys, so it is never true")
        XCTAssertFalse(text.contains("isFirstRun: Prefs.isFirstLaunch"),
                       "the seed reads first-launch live, after the launch has stored keys")
    }

    /// `hasSeenWelcome` is spent when the panel comes up, never at launch.
    ///
    /// A crash between the two would otherwise spend the one chance to offer
    /// this on a run where nobody saw anything, and in a release build nothing
    /// gives it back.
    func testTheOfferShouldBeSpentWhenThePanelComesUpRatherThanAtLaunch() {
        let text = source("App.swift")
        let lines = text.components(separatedBy: "\n")
        let writers = lines.enumerated().filter { $0.element.contains("Prefs.hasSeenWelcome = ") }
        XCTAssertEqual(writers.count, 1,
                       "the app spends the first run \(writers.count) times: "
                       + writers.map(\.element).joined(separator: " | "))
        // Guarded rather than subscripted straight away: a count of zero is a
        // real failure mode here, and an index crash reports it as the suite
        // dying rather than as this claim going red.
        guard let writer = writers.first else { return }
        guard let start = lines.firstIndex(where: { $0.contains("private func finishFirstRun()") }),
              let end = lines[(start + 1)...].firstIndex(where: { $0 == "    }" }) else {
            return XCTFail("finishFirstRun is gone; this guard needs rewriting")
        }
        XCTAssertTrue((start...end).contains(writer.offset),
                      "the offer is spent outside finishFirstRun, so a crash before the "
                      + "panel came up would spend it on a run nobody saw")
    }
}
