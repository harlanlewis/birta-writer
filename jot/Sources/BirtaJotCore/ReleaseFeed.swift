import Foundation

/// What a GitHub release says, and whether it is newer than this build.
///
/// Pure, so the two things worth getting exactly right are decidable without a
/// network: which asset to fetch, and whether to fetch it at all. The download,
/// the checksum and the swap are `Updater`'s, where they need a real machine.
public enum ReleaseFeed {
    public struct Release: Equatable, Sendable {
        public let tag: String
        public let appURL: URL
        public let checksumURL: URL?

        public init(tag: String, appURL: URL, checksumURL: URL?) {
            self.tag = tag
            self.appURL = appURL
            self.checksumURL = checksumURL
        }
    }

    /// What the release job names the app archive, before the version.
    ///
    /// The one thing three places have to agree about: this, the `grep` in
    /// `jot/scripts/update-jot.sh`, and the `ditto` in `.github/workflows/
    /// release.yml` that produces the name. Nothing but a test relates them.
    public static let assetPrefix = "BirtaJot-"

    /// Read the newest release out of the API's JSON.
    ///
    /// Parsed with `JSONSerialization` rather than by pattern, which is what
    /// `jot/scripts/update-jot.sh` has to do in a shell. The shell version's
    /// own comment records the trap that costs: a pattern for the app's URL
    /// also matches the LEADING part of the checksum asset's URL and returns
    /// it truncated, which happens to be the right URL and is therefore
    /// correct by accident. Reading the field is not.
    public static func parse(_ data: Data) -> Release? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tag = root["tag_name"] as? String,
              let assets = root["assets"] as? [[String: Any]] else { return nil }

        func url(named predicate: (String) -> Bool) -> URL? {
            for asset in assets {
                guard let name = asset["name"] as? String, predicate(name),
                      let href = asset["browser_download_url"] as? String,
                      let parsed = URL(string: href) else { continue }
                return parsed
            }
            return nil
        }
        // The app archive, and the checksum published beside it by the same
        // job. `.sha256` is checked FIRST when excluding, or the archive
        // predicate matches the checksum's name too.
        //
        // Named by PREFIX as well, and not simply "the first .zip that is not
        // a checksum": a release is free to carry a second archive, and the
        // loose predicate would download whichever the API listed first and
        // then verify it against a checksum for the other. `update-jot.sh`
        // already selects by this prefix, and `appFlavor.test.ts` holds the
        // two and the release job that produces the name together.
        guard let app = url(named: { $0.hasPrefix(assetPrefix) && $0.hasSuffix(".zip")
                                     && !$0.hasSuffix(".sha256") }) else { return nil }
        let checksum = url(named: { $0.hasPrefix(assetPrefix) && $0.hasSuffix(".zip.sha256") })
        return Release(tag: tag, appURL: app, checksumURL: checksum)
    }

    /// Whether `candidate` is a later version than `current`.
    ///
    /// Compared field by field as numbers, never as strings: the versions are
    /// CalVer (`2026.820.0`), so `2026.9.0` is a string that sorts after
    /// `2026.820.0` and is nine months older. A leading `v` is accepted
    /// because a tag usually carries one and a bundle version never does.
    ///
    /// A version this cannot read is not newer. `0.0.0` is what a build from a
    /// checkout reports, and treating an unreadable or unstamped version as
    /// old would make every development build offer to replace itself with the
    /// release, which is the thing `AppFlavor.updatesItself` also refuses.
    public static func isNewer(_ candidate: String, than current: String) -> Bool {
        guard let a = fields(candidate), let b = fields(current) else { return false }
        for index in 0..<max(a.count, b.count) {
            let left = index < a.count ? a[index] : 0
            let right = index < b.count ? b[index] : 0
            if left != right { return left > right }
        }
        return false
    }

    private static func fields(_ version: String) -> [Int]? {
        let trimmed = version.hasPrefix("v") ? String(version.dropFirst()) : version
        guard !trimmed.isEmpty else { return nil }
        let parts = trimmed.split(separator: ".", omittingEmptySubsequences: false)
        var out: [Int] = []
        for part in parts {
            guard let value = Int(part), value >= 0 else { return nil }
            out.append(value)
        }
        return out.isEmpty ? nil : out
    }
}
