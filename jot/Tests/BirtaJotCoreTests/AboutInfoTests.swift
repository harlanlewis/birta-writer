import XCTest
@testable import BirtaJotCore

/// What the About window says, checked where it is decided.
///
/// The window itself is checked by `AboutWindowTests`, which reads the drawn
/// hierarchy; this is the half that has rules rather than a layout: a version
/// line that must not present an unstamped build as a release, a copyright
/// that is allowed to be absent, and links that must keep naming the
/// repository this app is published from.
final class AboutInfoTests: XCTestCase {
    func testAStampedBuildShouldNameItsVersion() {
        XCTAssertEqual(AboutInfo.versionLine(shortVersion: "2026.821.0"), "Version 2026.821.0")
    }

    /// Every build but a released one carries `0.0.0`, and a line reading
    /// "Version 0.0.0" invites somebody to quote a number that identifies no
    /// release. The absent and empty arms are the bundle-less process, which
    /// is every test host and `swift run`.
    func testAnUnstampedBuildShouldSayThereIsNoVersionRatherThanQuoteOne() {
        for version in [AboutInfo.unstampedVersion, "", nil] {
            let line = AboutInfo.versionLine(shortVersion: version)
            XCTAssertEqual(line, "Development build", String(describing: version))
            XCTAssertFalse(line.contains(AboutInfo.unstampedVersion), String(describing: version))
        }
    }

    /// The window draws the copyright only when there is one, so an unset key
    /// and a key set to nothing have to arrive as the same absence: a plist
    /// with an empty string in it would otherwise reserve a blank line.
    func testACopyrightThatIsNotThereShouldBeAbsentRatherThanEmpty() {
        for copyright in ["", nil] {
            XCTAssertNil(AboutInfo(name: "Jot", shortVersion: nil, copyright: copyright).copyright,
                         String(describing: copyright))
        }
        XCTAssertEqual(AboutInfo(name: "Jot", shortVersion: nil, copyright: "© Somebody").copyright,
                       "© Somebody")
    }

    /// Enumerated from the type, so a link added later is covered without this
    /// file being touched, and the floor is what makes a sweep that reached
    /// nothing fail rather than pass.
    func testEveryLinkShouldBeADistinctHttpsUrlWithATitle() {
        XCTAssertGreaterThanOrEqual(AboutLink.allCases.count, 3)
        for link in AboutLink.allCases {
            XCTAssertFalse(link.title.isEmpty, link.address)
            XCTAssertEqual(link.url.scheme, "https", link.address)
            XCTAssertEqual(link.url.absoluteString, link.address, "the URL is not what the string says")
        }
        XCTAssertEqual(Set(AboutLink.allCases.map(\.address)).count, AboutLink.allCases.count)
        XCTAssertEqual(Set(AboutLink.allCases.map(\.title)).count, AboutLink.allCases.count)
    }

    /// The two GitHub links are derived from one repository string, which is
    /// also what `Updater` polls for releases. Asserting they contain it is
    /// what keeps a hand-written second spelling from creeping into either.
    func testTheGitHubLinksShouldNameTheRepositoryTheUpdaterPolls() {
        XCTAssertEqual(AboutLink.source.address, "https://github.com/\(AboutInfo.repository)")
        XCTAssertEqual(AboutLink.issues.address, AboutLink.source.address + "/issues")
        XCTAssertEqual(AboutLink.website.url.host, "www.birtalabs.com")
    }

    /// A local build says what it is on both lines it has to say something on.
    func testThisBuildShouldDescribeItselfWithoutABundleAroundIt() {
        let info = AboutInfo.current
        XCTAssertFalse(info.name.isEmpty)
        XCTAssertFalse(info.versionLine.isEmpty)
    }
}
