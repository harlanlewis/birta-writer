import BirtaWriterCore
import XCTest
@testable import BirtaWriter

/// The one word the `bwr` command and the app have to agree on.
///
/// A launch from a shell with a file to open summons on the file's own
/// account. A launch with none has nothing to open and still has to show, so
/// the command says so in the app's `argv`, and this is the app's half of
/// that. The two are separate programs and neither can see the other's
/// spelling, which is why the word has one definition and why the wire form is
/// asserted literally here and in `mac/scripts/check-cli.sh`: a rename that
/// reached only one end would otherwise leave every test green and a bare
/// `bwr` launching the app hidden.
@MainActor
final class CommandLaunchTests: XCTestCase {
    func testTheWordTheCommandSendsShouldBeRead() {
        XCTAssertTrue(AppDelegate.summonedFromShell([CliInvocation.summonArgument]))
    }

    /// The wire form, spelled out. `check-cli.sh` asserts the command emits
    /// this same word.
    func testTheWireFormShouldBeTheOneTheCommandPrints() {
        XCTAssertEqual(CliInvocation.summonArgument, "--summon")
        XCTAssertTrue(AppDelegate.summonedFromShell(["--summon"]))
    }

    /// An ordinary launch, and one carrying the arguments AppKit adds of its
    /// own, neither of which is a summon.
    func testAnythingElseShouldNotSummon() {
        XCTAssertFalse(AppDelegate.summonedFromShell(["/Applications/Birta Writer.app/Contents/MacOS/BirtaWriter"]))
        XCTAssertFalse(AppDelegate.summonedFromShell(["-NSDocumentRevisionsDebugMode", "YES"]))
    }
}
