import Foundation

/// Whether a Mac can run a build of the app, decided from the build itself.
///
/// Two facts make a `.app` refuse to launch, and both are readable from the
/// bundle before anything is installed: the macOS floor `Info.plist` declares
/// in `LSMinimumSystemVersion`, and the CPU architectures its Mach-O binary
/// actually carries. Nothing here holds a floor of its own, which is the
/// point: the answer comes from the bundle being asked about, so a release
/// that raises the floor is judged against its own number rather than against
/// one this build was compiled with.
///
/// It exists for the update paths. `Updater` and `mac/scripts/update.sh`
/// both quit the running app and replace it, and their swap scripts are built
/// around never leaving somebody with no app at all. An update the machine
/// cannot launch defeats that from outside: the move succeeds, the old copy is
/// gone, and the app never opens again. Asking these two questions first is
/// the only place that case can be caught, because macOS reports it as a
/// dialog after the working copy has already been replaced.
///
/// Pure, and therefore in Core: every input is a value read off a bundle, so
/// the cases that matter most are the ones no test machine can reach, an
/// Apple Silicon build on an Intel Mac and a floor above the running system.
public enum SystemRequirements {
    /// A CPU architecture a Mac runs and a Mach-O binary can be built for.
    ///
    /// The two that exist for macOS on this side of the PowerPC line, and the
    /// enumeration is closed on purpose: a `cputype` this does not name is a
    /// binary the app was not built to produce, and reading it as "some other
    /// architecture" would let it pass a check that is about matching.
    public enum Architecture: String, Sendable, CaseIterable {
        case arm64
        case x86_64

        /// The `cputype` field a Mach-O header carries for it.
        var cpuType: UInt32 {
            switch self {
            case .arm64: return 0x0100_000C  // CPU_TYPE_ARM | CPU_ARCH_ABI64
            case .x86_64: return 0x0100_0007 // CPU_TYPE_X86 | CPU_ARCH_ABI64
            }
        }

        /// What `uname -m` calls this machine, mapped back.
        public init?(machineName: String) {
            // `arm64e` is the pointer-authentication variant the kernel and
            // some system binaries are built for. A Mac reporting it runs
            // ordinary `arm64` code, so it is the same answer to the only
            // question asked here.
            let name = machineName == "arm64e" ? "arm64" : machineName
            guard let arch = Architecture(rawValue: name) else { return nil }
            self = arch
        }
    }

    /// Why a build was refused, or that it was not.
    public enum Verdict: Equatable, Sendable {
        case compatible
        /// The bundle declares a floor above the running system.
        case systemTooOld(needs: String, running: String)
        /// The binary carries no code this machine can execute.
        case wrongArchitecture(built: [Architecture], machine: String)
        /// The bundle's binary could not be read as Mach-O at all.
        case unreadable
    }

    /// The whole question, for a bundle that has been unpacked but not installed.
    ///
    /// `declaredMinimum` is nil when the bundle names no `LSMinimumSystemVersion`,
    /// and that is NOT a refusal. That key is the only thing that makes macOS
    /// itself decline to launch an app, so a bundle without one is a bundle
    /// macOS will open, and refusing it here would block an update over a fact
    /// nobody asserted. The architecture axis has no such gap: the binary
    /// either carries this machine's code or it does not.
    public static func verdict(
        declaredMinimum: String?,
        builtFor: Set<Architecture>,
        running: String,
        machine: String
    ) -> Verdict {
        if let declaredMinimum, !meets(minimum: declaredMinimum, running: running) {
            return .systemTooOld(needs: declaredMinimum, running: running)
        }
        guard !builtFor.isEmpty else { return .unreadable }
        guard let mine = Architecture(machineName: machine) else {
            // A machine calling itself something neither case names is not a
            // Mac this build was made for either way, and guessing which side
            // of the check it falls on would be inventing an answer.
            return .wrongArchitecture(built: sorted(builtFor), machine: machine)
        }
        // Rosetta is deliberately not counted. It would let an Intel-only
        // build through on Apple Silicon, and this project has never shipped
        // one, so the only thing counting it could do here is turn a refusal
        // that costs somebody a version into an install that costs them the
        // app. The bias is the swap script's: never leave a working copy
        // replaced by one that will not open.
        guard builtFor.contains(mine) else {
            return .wrongArchitecture(built: sorted(builtFor), machine: machine)
        }
        return .compatible
    }

    /// A sentence for the person who is being told no.
    ///
    /// It says what their machine is as well as what the build wants, because
    /// the refusal arrives with no other context: somebody who clicked Update
    /// and got "needs macOS 15" has no way to check what they are on without
    /// leaving the app, and the number they would find is the one already here.
    public static func refusal(_ verdict: Verdict, productName: String) -> String? {
        switch verdict {
        case .compatible:
            return nil
        case let .systemTooOld(needs, running):
            return "That version of \(productName) needs macOS \(needs) and this Mac runs \(running). Nothing was installed."
        case let .wrongArchitecture(built, machine):
            let names = built.map(\.rawValue).joined(separator: ", ")
            return "That version of \(productName) is built for \(names) and this Mac is \(machine). Nothing was installed."
        case .unreadable:
            return "That version of \(productName) could not be read, so nothing was installed."
        }
    }

    // MARK: - Version comparison

    /// Whether `running` is at least `minimum`, both dotted release numbers.
    ///
    /// Compared component by component as integers, never as strings: macOS
    /// 14.10 is newer than 14.9 and sorts before it as text, and the same trap
    /// swallows 26.0 against 9.0. A missing component reads as zero, so "14"
    /// and "14.0.0" are the same floor.
    public static func meets(minimum: String, running: String) -> Bool {
        return compare(running, minimum) >= 0
    }

    /// -1, 0 or 1 for `a` against `b`.
    static func compare(_ a: String, _ b: String) -> Int {
        let left = components(a)
        let right = components(b)
        for index in 0..<max(left.count, right.count) {
            let l = index < left.count ? left[index] : 0
            let r = index < right.count ? right[index] : 0
            if l != r { return l < r ? -1 : 1 }
        }
        return 0
    }

    /// A version's numeric components, ignoring anything that is not one.
    ///
    /// A component that does not parse becomes zero rather than ending the
    /// walk, so a build suffix cannot make a real version compare as empty and
    /// therefore as the lowest possible floor.
    private static func components(_ version: String) -> [Int] {
        return version.split(separator: ".").map { Int($0) ?? 0 }
    }

    private static func sorted(_ set: Set<Architecture>) -> [Architecture] {
        return Architecture.allCases.filter { set.contains($0) }
    }

    // MARK: - Reading a Mach-O binary

    /// Which architectures a Mach-O file carries, from its header alone.
    ///
    /// Parsed here rather than shelled out to `lipo`, which ships with the
    /// Command Line Tools and not with macOS: a check that quietly does
    /// nothing on the machines least likely to have a developer toolchain is
    /// the wrong way round, since those are the machines being protected.
    /// Only the header is needed, so the caller reads a prefix rather than a
    /// binary that runs to tens of megabytes.
    ///
    /// Returns an empty set for anything that is not Mach-O, which
    /// `verdict` reports as `.unreadable` rather than as a mismatch.
    public static func architectures(machO data: Data) -> Set<Architecture> {
        guard let magic = be32(data, 0) else { return [] }
        switch magic {
        // A fat (universal) archive. Its header and its entries are
        // big-endian whichever way round the slices inside them are, which is
        // the one thing about this format that is not negotiable per-field.
        case 0xCAFE_BABE, 0xCAFE_BABF:
            let entrySize = magic == 0xCAFE_BABF ? 32 : 20
            guard let count = be32(data, 4) else { return [] }
            // A count read out of a file is untrusted input, and the bound is
            // what the data can actually hold rather than a number the header
            // claims. `Data` subscripting traps out of range instead of
            // throwing, so every read below goes through the checked helpers.
            var found: Set<Architecture> = []
            for index in 0..<Int(count) {
                let offset = 8 + index * entrySize
                guard let cpuType = be32(data, offset) else { break }
                if let arch = Architecture.allCases.first(where: { $0.cpuType == cpuType }) {
                    found.insert(arch)
                }
            }
            return found
        // A single-architecture 64-bit image, little-endian on disk for both
        // architectures that exist here. MH_CIGAM_64 is the same header read
        // the other way and is what a cross-built image looks like.
        case 0xCFFA_EDFE, 0xFEED_FACF:
            let bigEndian = magic == 0xFEED_FACF
            guard let cpuType = bigEndian ? be32(data, 4) : le32(data, 4) else { return [] }
            guard let arch = Architecture.allCases.first(where: { $0.cpuType == cpuType }) else { return [] }
            return [arch]
        default:
            return []
        }
    }

    /// A big-endian 32-bit word at `offset`, or nil if the data is too short.
    private static func be32(_ data: Data, _ offset: Int) -> UInt32? {
        guard let bytes = word(data, offset) else { return nil }
        return (UInt32(bytes.0) << 24) | (UInt32(bytes.1) << 16) | (UInt32(bytes.2) << 8) | UInt32(bytes.3)
    }

    /// The same word read the other way round.
    private static func le32(_ data: Data, _ offset: Int) -> UInt32? {
        guard let bytes = word(data, offset) else { return nil }
        return (UInt32(bytes.3) << 24) | (UInt32(bytes.2) << 16) | (UInt32(bytes.1) << 8) | UInt32(bytes.0)
    }

    /// Four bytes at `offset`, counted from the data's own start.
    ///
    /// `Data` sliced out of a file keeps the parent's indices, so `data[0]` is
    /// not necessarily its first byte. Everything here is expressed as a
    /// distance from `startIndex` for that reason.
    private static func word(_ data: Data, _ offset: Int) -> (UInt8, UInt8, UInt8, UInt8)? {
        guard offset >= 0, data.count >= offset + 4 else { return nil }
        let base = data.startIndex + offset
        return (data[base], data[base + 1], data[base + 2], data[base + 3])
    }
}
