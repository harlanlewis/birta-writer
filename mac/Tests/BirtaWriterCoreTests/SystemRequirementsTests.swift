import XCTest
@testable import BirtaWriterCore

/// Whether a Mac can run a build of the app, decided before that build replaces
/// the one somebody is using.
///
/// The cases worth having are the ones no machine here can produce: a floor
/// above the running system, and an Apple Silicon binary offered to an Intel
/// Mac. Both are refusals, and a refusal that fails open costs the app rather
/// than a version, because the update paths have already quit the running copy
/// by the time macOS gets to say no.
final class SystemRequirementsTests: XCTestCase {
    private typealias Arch = SystemRequirements.Architecture

    // MARK: - Version comparison

    func testAVersionAtTheFloorShouldMeetIt() {
        XCTAssertTrue(SystemRequirements.meets(minimum: "14.0", running: "14.0"))
        // The floor written three ways is one floor.
        XCTAssertTrue(SystemRequirements.meets(minimum: "14", running: "14.0.0"))
        XCTAssertTrue(SystemRequirements.meets(minimum: "14.0.0", running: "14"))
    }

    func testAVersionBelowTheFloorShouldNotMeetIt() {
        XCTAssertFalse(SystemRequirements.meets(minimum: "14.0", running: "13.7.2"))
        XCTAssertFalse(SystemRequirements.meets(minimum: "14.1", running: "14.0.3"))
        XCTAssertFalse(SystemRequirements.meets(minimum: "15.0", running: "14.99"))
    }

    func testComponentsShouldCompareAsNumbersAndNotAsText() {
        // The whole reason this is not a string comparison. Every pair here is
        // ordered the wrong way round as text, and two of them are versions
        // macOS has actually shipped.
        XCTAssertTrue(SystemRequirements.meets(minimum: "14.9", running: "14.10"))
        XCTAssertFalse(SystemRequirements.meets(minimum: "14.10", running: "14.9"))
        XCTAssertTrue(SystemRequirements.meets(minimum: "9.0", running: "26.0"))
        XCTAssertFalse(SystemRequirements.meets(minimum: "26.0", running: "9.0"))
    }

    func testAVersionCarryingSomethingUnparseableShouldNotReadAsTheLowestPossible() {
        // A component that is not a number becomes zero, and the components
        // around it still count. Were the walk to stop instead, "14.0" would
        // compare as empty and meet every floor there is.
        XCTAssertTrue(SystemRequirements.meets(minimum: "14.0", running: "14.0-beta"))
        XCTAssertFalse(SystemRequirements.meets(minimum: "14.0", running: "13.x"))
        XCTAssertFalse(SystemRequirements.meets(minimum: "14.0", running: ""))
    }

    // MARK: - The verdict

    func testAMachineMeetingBothAxesShouldBeCompatible() {
        XCTAssertEqual(
            SystemRequirements.verdict(
                declaredMinimum: "14.0", builtFor: [.arm64], running: "15.2", machine: "arm64"),
            .compatible)
    }

    func testAFloorAboveTheRunningSystemShouldRefuse() {
        XCTAssertEqual(
            SystemRequirements.verdict(
                declaredMinimum: "15.0", builtFor: [.arm64], running: "14.7", machine: "arm64"),
            .systemTooOld(needs: "15.0", running: "14.7"))
    }

    func testAnAppleSiliconBuildShouldRefuseAnIntelMac() {
        // The case the release currently produces: `swift build` with no
        // --arch builds for the runner, and the runner is Apple Silicon.
        XCTAssertEqual(
            SystemRequirements.verdict(
                declaredMinimum: "14.0", builtFor: [.arm64], running: "14.7", machine: "x86_64"),
            .wrongArchitecture(built: [.arm64], machine: "x86_64"))
    }

    func testAUniversalBuildShouldSuitEitherMachine() {
        for machine in ["arm64", "x86_64"] {
            XCTAssertEqual(
                SystemRequirements.verdict(
                    declaredMinimum: "14.0", builtFor: [.arm64, .x86_64],
                    running: "14.7", machine: machine),
                .compatible,
                "a universal build should suit \(machine)")
        }
    }

    func testAnIntelOnlyBuildShouldRefuseAppleSiliconRatherThanCountOnRosetta() {
        // Rosetta could run it, and is deliberately not counted: it may not be
        // installed, and the cost of guessing wrong is somebody's app replaced
        // by one that will not open.
        XCTAssertEqual(
            SystemRequirements.verdict(
                declaredMinimum: "14.0", builtFor: [.x86_64], running: "14.7", machine: "arm64"),
            .wrongArchitecture(built: [.x86_64], machine: "arm64"))
    }

    func testAPointerAuthenticationMacShouldReadAsAppleSilicon() {
        // Some Macs report arm64e. They run ordinary arm64 code, so reading
        // the name literally would refuse every build on the machines that
        // report it.
        XCTAssertEqual(
            SystemRequirements.verdict(
                declaredMinimum: "14.0", builtFor: [.arm64], running: "14.7", machine: "arm64e"),
            .compatible)
    }

    func testABundleDeclaringNoFloorShouldPassTheVersionAxis() {
        // LSMinimumSystemVersion is the only thing that makes macOS decline to
        // launch an app, so a bundle without one is a bundle macOS opens.
        // Refusing here would block an update over a fact nobody asserted.
        XCTAssertEqual(
            SystemRequirements.verdict(
                declaredMinimum: nil, builtFor: [.arm64], running: "10.15", machine: "arm64"),
            .compatible)
    }

    func testABinaryThatCouldNotBeReadShouldRefuseRatherThanPass() {
        // An empty set is "the header did not parse", not "it runs anywhere".
        XCTAssertEqual(
            SystemRequirements.verdict(
                declaredMinimum: "14.0", builtFor: [], running: "14.7", machine: "arm64"),
            .unreadable)
    }

    func testAnUnrecognisedMachineShouldRefuseRatherThanGuess() {
        XCTAssertEqual(
            SystemRequirements.verdict(
                declaredMinimum: "14.0", builtFor: [.arm64], running: "14.7", machine: "ppc"),
            .wrongArchitecture(built: [.arm64], machine: "ppc"))
    }

    func testTheVersionAxisShouldBeAnsweredBeforeTheArchitectureOne() {
        // Both wrong reports the floor, because that is the one the person can
        // do something about.
        XCTAssertEqual(
            SystemRequirements.verdict(
                declaredMinimum: "15.0", builtFor: [.arm64], running: "14.7", machine: "x86_64"),
            .systemTooOld(needs: "15.0", running: "14.7"))
    }

    // MARK: - The sentence

    func testOnlyACompatibleVerdictShouldHaveNothingToSay() {
        // Every refusal has to produce a message, or a path that refuses
        // silently leaves somebody with an Update button that does nothing.
        // Derived from the cases rather than listed, so a new one joins it.
        let refusals: [SystemRequirements.Verdict] = [
            .systemTooOld(needs: "15.0", running: "14.7"),
            .wrongArchitecture(built: [.arm64], machine: "x86_64"),
            .unreadable,
        ]
        XCTAssertNil(SystemRequirements.refusal(.compatible, productName: "Birta Writer"))
        for verdict in refusals {
            let message = SystemRequirements.refusal(verdict, productName: "Birta Writer")
            XCTAssertNotNil(message, "\(verdict) should say something")
            XCTAssertTrue(message!.contains("Birta Writer"), "\(verdict) should name the product")
            XCTAssertTrue(
                message!.contains("Nothing was installed") || message!.contains("nothing was installed"),
                "\(verdict) should say the working copy was left alone")
        }
    }

    func testTheRefusalShouldNameBothTheBuildAndTheMachine() {
        let tooOld = SystemRequirements.refusal(
            .systemTooOld(needs: "15.0", running: "14.7"), productName: "Birta Writer")
        XCTAssertTrue(tooOld!.contains("15.0"))
        XCTAssertTrue(tooOld!.contains("14.7"))
        let wrongArch = SystemRequirements.refusal(
            .wrongArchitecture(built: [.arm64, .x86_64], machine: "ppc"), productName: "Birta Writer")
        XCTAssertTrue(wrongArch!.contains("arm64"))
        XCTAssertTrue(wrongArch!.contains("x86_64"))
        XCTAssertTrue(wrongArch!.contains("ppc"))
    }

    // MARK: - Reading a Mach-O header

    /// A thin 64-bit image's first eight bytes: magic then cputype.
    private func thin(_ arch: Arch, bigEndian: Bool = false) -> Data {
        var bytes: [UInt8] = bigEndian ? [0xFE, 0xED, 0xFA, 0xCF] : [0xCF, 0xFA, 0xED, 0xFE]
        let cpu = arch.cpuType
        let word: [UInt8] = [
            UInt8((cpu >> 24) & 0xFF), UInt8((cpu >> 16) & 0xFF),
            UInt8((cpu >> 8) & 0xFF), UInt8(cpu & 0xFF),
        ]
        // `Array(...)` on both arms: a ternary needs one type, and
        // `reversed()` on an Array is a ReversedCollection rather than one.
        bytes += bigEndian ? word : Array(word.reversed())
        return Data(bytes)
    }

    /// A fat header carrying `arches`, with each entry's remaining fields zero.
    private func fat(_ arches: [Arch], sixtyFourBit: Bool = false) -> Data {
        let entrySize = sixtyFourBit ? 32 : 20
        var bytes: [UInt8] = sixtyFourBit
            ? [0xCA, 0xFE, 0xBA, 0xBF]
            : [0xCA, 0xFE, 0xBA, 0xBE]
        let count = UInt32(arches.count)
        bytes += [
            UInt8((count >> 24) & 0xFF), UInt8((count >> 16) & 0xFF),
            UInt8((count >> 8) & 0xFF), UInt8(count & 0xFF),
        ]
        for arch in arches {
            let cpu = arch.cpuType
            bytes += [
                UInt8((cpu >> 24) & 0xFF), UInt8((cpu >> 16) & 0xFF),
                UInt8((cpu >> 8) & 0xFF), UInt8(cpu & 0xFF),
            ]
            bytes += [UInt8](repeating: 0, count: entrySize - 4)
        }
        return Data(bytes)
    }

    func testAThinImageShouldReportItsOneArchitecture() {
        // Both fixtures are asserted, so a reader that happened to return the
        // same answer for every input could not pass this.
        XCTAssertEqual(SystemRequirements.architectures(machO: thin(.arm64)), [.arm64])
        XCTAssertEqual(SystemRequirements.architectures(machO: thin(.x86_64)), [.x86_64])
    }

    func testAnImageStoredTheOtherWayRoundShouldStillBeRead() {
        XCTAssertEqual(SystemRequirements.architectures(machO: thin(.arm64, bigEndian: true)), [.arm64])
    }

    func testAFatArchiveShouldReportEverySliceItCarries() {
        XCTAssertEqual(SystemRequirements.architectures(machO: fat([.arm64, .x86_64])), [.arm64, .x86_64])
        XCTAssertEqual(SystemRequirements.architectures(machO: fat([.arm64])), [.arm64])
        // The 64-bit fat format has wider entries, so a reader that assumed
        // one stride would find the second slice's cputype in the wrong place.
        XCTAssertEqual(
            SystemRequirements.architectures(machO: fat([.arm64, .x86_64], sixtyFourBit: true)),
            [.arm64, .x86_64])
    }

    func testSomethingThatIsNotMachOShouldReadAsNothing() {
        XCTAssertEqual(SystemRequirements.architectures(machO: Data()), [])
        XCTAssertEqual(SystemRequirements.architectures(machO: Data([0x00, 0x01, 0x02])), [])
        XCTAssertEqual(SystemRequirements.architectures(machO: Data("#!/bin/sh\n".utf8)), [])
    }

    func testATruncatedHeaderShouldStopRatherThanTrap() {
        // A count read out of a file is untrusted input. `Data` traps on an
        // out-of-range subscript, so a header claiming more slices than it
        // carries has to end the walk and not the process.
        var lying = fat([.arm64, .x86_64])
        lying[4] = 0xFF
        lying[5] = 0xFF
        lying[6] = 0xFF
        lying[7] = 0xFF
        XCTAssertEqual(SystemRequirements.architectures(machO: lying), [.arm64, .x86_64])
        // And a header cut off mid-entry gives up what it has.
        let cut = fat([.arm64, .x86_64]).prefix(30)
        XCTAssertEqual(SystemRequirements.architectures(machO: Data(cut)), [.arm64])
    }

    func testASliceForSomeOtherArchitectureShouldBeIgnoredRatherThanCountedAsAMatch() {
        var mixed = fat([.arm64])
        // Rewrite the one slice's cputype to PowerPC, which no case names.
        mixed[8] = 0x00
        mixed[9] = 0x00
        mixed[10] = 0x00
        mixed[11] = 0x12
        XCTAssertEqual(SystemRequirements.architectures(machO: mixed), [])
    }

    func testAPrefixOfARealBundleShouldBeEnoughToDecide() {
        // The caller reads a header-sized prefix rather than a binary that
        // runs to tens of megabytes, so the reader must not need the rest.
        var whole = thin(.arm64)
        whole.append(Data([UInt8](repeating: 0xAB, count: 4096)))
        XCTAssertEqual(SystemRequirements.architectures(machO: whole.prefix(8)), [.arm64])
    }

    func testASlicedDataShouldBeReadFromItsOwnStart() {
        // A `Data` sliced out of a file keeps the parent's indices, so a
        // reader indexing from zero reads the wrong bytes or traps.
        let padded = Data([0xDE, 0xAD]) + thin(.x86_64)
        XCTAssertEqual(SystemRequirements.architectures(machO: padded.dropFirst(2)), [.x86_64])
    }
}
