import XCTest
@testable import BirtaJotCore

final class ReleaseFeedTests: XCTestCase {
    private func json(tag: String, assets: [String]) -> Data {
        let list = assets.map {
            #"{"name": "\#($0)", "browser_download_url": "https://example.test/\#($0)"}"#
        }.joined(separator: ",")
        return Data(#"{"tag_name": "\#(tag)", "assets": [\#(list)]}"#.utf8)
    }

    // MARK: which asset

    func testTheAppArchiveAndItsChecksumShouldBothBeFound() {
        let release = ReleaseFeed.parse(json(tag: "v2026.820.0",
                                             assets: ["BirtaJot-2026.820.0.zip",
                                                      "BirtaJot-2026.820.0.zip.sha256"]))
        XCTAssertEqual(release?.tag, "v2026.820.0")
        XCTAssertEqual(release?.appURL.lastPathComponent, "BirtaJot-2026.820.0.zip")
        XCTAssertEqual(release?.checksumURL?.lastPathComponent, "BirtaJot-2026.820.0.zip.sha256")
    }

    /// The trap the shell version documents: a match for the archive also
    /// matches the leading part of the checksum's name, and the truncated
    /// result happens to be the right URL. Correct by accident is what this
    /// rules out, so the order of the assets must not decide the answer.
    func testTheChecksumShouldNeverBeMistakenForTheArchive() {
        let checksumFirst = ReleaseFeed.parse(json(tag: "v1.0.0",
                                                   assets: ["BirtaJot-1.0.0.zip.sha256",
                                                            "BirtaJot-1.0.0.zip"]))
        XCTAssertEqual(checksumFirst?.appURL.lastPathComponent, "BirtaJot-1.0.0.zip")
        XCTAssertEqual(checksumFirst?.checksumURL?.lastPathComponent, "BirtaJot-1.0.0.zip.sha256")
    }

    func testAReleaseWithNoAppAttachedShouldBeNothingRatherThanAGuess() {
        XCTAssertNil(ReleaseFeed.parse(json(tag: "v1.0.0", assets: ["notes.txt"])))
        XCTAssertNil(ReleaseFeed.parse(json(tag: "v1.0.0", assets: [])))
    }

    func testAnArchiveWithNoChecksumShouldStillBeUsable() {
        let release = ReleaseFeed.parse(json(tag: "v1.0.0", assets: ["BirtaJot-1.0.0.zip"]))
        XCTAssertNotNil(release)
        XCTAssertNil(release?.checksumURL)
    }

    func testRubbishShouldParseToNothing() {
        XCTAssertNil(ReleaseFeed.parse(Data("not json".utf8)))
        XCTAssertNil(ReleaseFeed.parse(Data("{}".utf8)))
        XCTAssertNil(ReleaseFeed.parse(Data()))
    }

    // MARK: which is newer

    func testALaterVersionShouldBeNewer() {
        XCTAssertTrue(ReleaseFeed.isNewer("2026.821.0", than: "2026.820.0"))
        XCTAssertTrue(ReleaseFeed.isNewer("2027.1.0", than: "2026.820.0"))
        XCTAssertTrue(ReleaseFeed.isNewer("2026.820.1", than: "2026.820.0"))
    }

    func testTheSameVersionShouldNotBeNewer() {
        XCTAssertFalse(ReleaseFeed.isNewer("2026.820.0", than: "2026.820.0"))
        XCTAssertFalse(ReleaseFeed.isNewer("v2026.820.0", than: "2026.820.0"))
    }

    func testAnEarlierVersionShouldNotBeNewer() {
        XCTAssertFalse(ReleaseFeed.isNewer("2026.819.0", than: "2026.820.0"))
        XCTAssertFalse(ReleaseFeed.isNewer("2025.1.0", than: "2026.820.0"))
    }

    /// The reason this compares numbers rather than strings, and the case a
    /// string comparison gets exactly backwards: `2026.9.0` sorts after
    /// `2026.820.0` as text and is nine months older.
    func testAVersionThatSortsLaterAsTextShouldStillBeOlder() {
        XCTAssertFalse(ReleaseFeed.isNewer("2026.9.0", than: "2026.820.0"))
        XCTAssertTrue(ReleaseFeed.isNewer("2026.820.0", than: "2026.9.0"))
    }

    func testAVersionWithFewerFieldsShouldCompareAsIfPaddedWithZeroes() {
        XCTAssertTrue(ReleaseFeed.isNewer("2026.821", than: "2026.820.9"))
        XCTAssertFalse(ReleaseFeed.isNewer("2026.820", than: "2026.820.0"))
        XCTAssertTrue(ReleaseFeed.isNewer("2026.820.1", than: "2026.820"))
    }

    /// A build from a checkout reports `0.0.0`, and every real release is
    /// newer than that. The flavour is what actually stops a development
    /// build replacing itself; this only says the comparison is not the thing
    /// protecting it.
    func testEveryRealReleaseShouldBeNewerThanAnUnstampedBuild() {
        XCTAssertTrue(ReleaseFeed.isNewer("2026.820.0", than: "0.0.0"))
    }

    /// A version that cannot be read is never newer, in either position. An
    /// unreadable remote version offering itself as an upgrade is the failure
    /// that matters: it would hand somebody an archive on the strength of a
    /// string nobody could parse.
    func testAnUnreadableVersionShouldNeverBeNewer() {
        for bad in ["", "v", "latest", "2026.x.0", "2026..0", "-1.0.0", "2026.820.0-beta"] {
            XCTAssertFalse(ReleaseFeed.isNewer(bad, than: "2026.820.0"), bad)
            XCTAssertFalse(ReleaseFeed.isNewer("2026.821.0", than: bad), bad)
        }
    }

    func testAnUnrelatedArchiveListedFirstShouldNotBeTakenForTheApp() {
        // A release is free to carry a second .zip. Selecting "the first zip
        // that is not a checksum" would download that one and then verify it
        // against the app's checksum, which fails on a good release and is
        // indistinguishable from a corrupt download.
        let release = ReleaseFeed.parse(json(tag: "v2026.820.0",
                                             assets: ["source-bundle.zip",
                                                      "BirtaJot-2026.820.0.zip",
                                                      "BirtaJot-2026.820.0.zip.sha256"]))
        XCTAssertEqual(release?.appURL.lastPathComponent, "BirtaJot-2026.820.0.zip")
        XCTAssertEqual(release?.checksumURL?.lastPathComponent, "BirtaJot-2026.820.0.zip.sha256")
    }

    func testAReleaseCarryingNoAppArchiveShouldNotResolveToSomeOtherZip() {
        XCTAssertNil(ReleaseFeed.parse(json(tag: "v1.0.0", assets: ["source-bundle.zip"])))
    }

    func testTheAssetPrefixShouldBeTheOneEveryAssetNameStartsWith() {
        // The floor for the two above: they prove nothing if the prefix is
        // empty, because every name starts with "".
        XCTAssertFalse(ReleaseFeed.assetPrefix.isEmpty)
    }
}
