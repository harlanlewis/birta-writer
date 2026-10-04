import XCTest
@testable import BirtaWriterCore

/// Which channel delivered this build, read off the sandbox, and what each
/// channel takes away. The shape follows `AppFlavorTests`: the discriminator
/// is asked directly, and every fact is enumerated from the type so a channel
/// added later has to answer each rather than be forgotten here.
final class DistributionTests: XCTestCase {
    func testASandboxedProcessShouldBeTheAppStoreBuild() {
        XCTAssertEqual(Distribution.forSandbox(true), .appStore)
        XCTAssertEqual(Distribution.forSandbox(false), .direct)
    }

    /// Presence is the test. The value is the container's id, which varies
    /// per install, and an empty value is still a sandboxed process.
    func testTheSandboxShouldBeReadOffTheVariablesPresence() {
        XCTAssertFalse(Distribution.isSandboxed([:]))
        XCTAssertFalse(Distribution.isSandboxed(["HOME": "/Users/somebody"]))
        XCTAssertTrue(Distribution.isSandboxed([Distribution.sandboxContainerVariable: "com.birtalabs.birta-writer"]))
        XCTAssertTrue(Distribution.isSandboxed([Distribution.sandboxContainerVariable: ""]))
    }

    /// The test process is never sandboxed, so this is the one arm `current`
    /// can be asked about here; the other is reached through `forSandbox`.
    /// It also pins the fact every shipped build relies on today: nothing in
    /// the tree builds a sandboxed copy yet, so the seam is inert everywhere.
    func testTheTestProcessShouldBeTheDirectBuild() {
        XCTAssertEqual(Distribution.current, .direct)
    }

    /// Every fact the sandbox takes away, and only the direct build has them.
    func testEveryFactShouldBeOfferedByTheDirectBuildAlone() {
        XCTAssertEqual(Distribution.allCases.count, 2)
        for distribution in Distribution.allCases {
            let direct = distribution == .direct
            XCTAssertEqual(distribution.offersAgent, direct, distribution.rawValue)
            XCTAssertEqual(distribution.offersTerminalCommand, direct, distribution.rawValue)
            XCTAssertEqual(distribution.updatesItself, direct, distribution.rawValue)
            XCTAssertEqual(distribution.readsInstalledEditorThemes, direct, distribution.rawValue)
        }
    }

    /// Self-update needs both answers, and the resolver is the only place the
    /// conjunction is written: a release on the store does not, and a
    /// development build downloaded directly does not either.
    func testOnlyADirectReleaseShouldUpdateItself() {
        for distribution in Distribution.allCases {
            for flavour in AppFlavor.allCases {
                XCTAssertEqual(distribution.updatesItself(flavour: flavour),
                               distribution == .direct && flavour == .release,
                               "\(distribution.rawValue) \(flavour.rawValue)")
            }
        }
    }
}
