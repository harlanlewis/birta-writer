import XCTest
@testable import BirtaWriterCore

/// The words the menu bar says on a first run, and the one thing they must
/// never say.
///
/// This is now the FIRST surface that teaches the summon, and the only one:
/// the panel does not open until the chord is pressed, so a sentence naming a
/// chord macOS has already given away sends somebody to press a key that does
/// nothing and conclude the app is broken (MAR-407).
final class FirstRunInvitationTests: XCTestCase {
    /// A chord that is not the default, so an arm reading the wrong one is
    /// visible rather than accidentally right.
    private let taken = try! HotkeyCombo.parse("cmd+shift+k").get()

    func testAChordTheSystemTookShouldBeTheOneDrawnToPress() {
        let invitation = FirstRunInvitation.of(name: "Birta Writer",
                                               combo: .release, refused: nil)

        XCTAssertEqual(invitation.chord, .press(HotkeyCombo.release.symbols))
        XCTAssertEqual(invitation.chordToPress, HotkeyCombo.release.symbols)
        XCTAssertFalse(invitation.isProblem)
    }

    /// The arm the whole type exists for: a refused chord is REPORTED and not
    /// offered.
    ///
    /// Both halves, because either alone is wrong in its own direction.
    /// Drawing it teaches a dead key; leaving it out of the prose as well
    /// leaves somebody with a menu-bar app and no idea why nothing happens.
    func testARefusedChordShouldBeNamedAndNeverDrawnToPress() {
        let invitation = FirstRunInvitation.of(name: "Birta Writer",
                                               combo: .release, refused: taken)

        XCTAssertNil(invitation.chordToPress,
                     "the popover offers a chord macOS refused")
        XCTAssertTrue(invitation.body.contains(taken.symbols),
                      "the popover does not say which chord was taken: \(invitation.body)")
        XCTAssertTrue(invitation.isProblem)
        // The REFUSED chord, not the one that was asked for. Reading `combo`
        // here would name a chord nothing refused, and with the release
        // default on both sides that mistake is invisible.
        XCTAssertFalse(invitation.body.contains(HotkeyCombo.release.symbols),
                       "the popover reports a chord that was not the refused one")
    }

    /// The name is the build's, so a development copy does not tell somebody
    /// they installed the one their notes are in.
    func testEverySentenceShouldCallTheAppWhateverTheBuildIsCalled() {
        for name in ["Birta Writer", "Birta Writer [DEV]"] {
            for refused in [nil, taken] as [HotkeyCombo?] {
                let invitation = FirstRunInvitation.of(name: name, combo: .release,
                                                       refused: refused)
                XCTAssertTrue(invitation.headline.contains(name), invitation.headline)
                // The working arm's sentence is about the keys rather than
                // about the app, so only the headline has to carry the name
                // there; the refusal's does, because it is the sentence that
                // says which app will not open.
                if refused != nil {
                    XCTAssertTrue(invitation.body.contains(name), invitation.body)
                }
            }
        }
    }

    /// There is always a floor under a first run, and it is shorter when there
    /// is no gesture left to wait for.
    ///
    /// Both halves matter. A wait of zero in the working arm takes away the
    /// chance to learn the chord, which is the whole point of the surface; no
    /// wait at all leaves somebody who switched away with an app that never
    /// opened.
    func testThePanelShouldAlwaysOpenEventuallyAndSoonerWhenTheChordIsDead() {
        let alive = FirstRunInvitation.of(name: "Birta Writer", combo: .release, refused: nil)
        let dead = FirstRunInvitation.of(name: "Birta Writer", combo: .release, refused: taken)

        XCTAssertGreaterThan(alive.wait, 0, "nothing would ever open the panel")
        XCTAssertGreaterThan(dead.wait, 0)
        XCTAssertLessThan(dead.wait, alive.wait,
                          "a dead chord is waited on as long as a live one")
    }

    /// The glyph form, not the storage form.
    ///
    /// `HotkeyCombo.spelling` is "cmd+alt+ctrl+j", which is how the setting is
    /// written down and not how a key is printed on a Mac. A popover drawing
    /// the spelling would be asking somebody to press six words.
    func testTheChordShouldBeDrawnInTheGlyphsAMenuUses() {
        let invitation = FirstRunInvitation.of(name: "Birta Writer",
                                               combo: .release, refused: nil)

        XCTAssertEqual(invitation.chordToPress, "⌃⌥⌘J")
        XCTAssertNotEqual(invitation.chordToPress, HotkeyCombo.release.spelling)
    }
}
