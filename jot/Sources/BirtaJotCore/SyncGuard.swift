import Foundation

/// The two stale guards of the webview→host content protocol, ported from
/// `shared/saveFlushController.ts` (the ONE implementation on the extension
/// side; this is the ONE implementation on the Jot side). Jot has one document
/// and one writer, so the per-document and per-writer maps collapse to two
/// integers, and the backend is the single-writer one: only the current
/// version is admissible, and a rejected base means "re-push authoritative
/// content so the webview re-bases".
///
/// Invariants it upholds (AGENTS.md "View to document sync invariant"):
///   - ordering is total: every inbound `update`/`flushResult` carries a
///     monotonic `seq`, and one below the high-water mark is a stale in-flight
///     message that must not revert a fresher one;
///   - content serialized against a version the host has moved past (a
///     `externalUpdate` the host sent) is not applied.
public struct SyncGuard: Equatable, Sendable {
    /// Authoritative version; bumped for every `externalUpdate` the host sends.
    public private(set) var version: Int = 0
    /// Highest admitted inbound seq for the current webview generation.
    public private(set) var appliedSeq: Int = 0

    public init() {}

    /// A fresh webview context (its `ready`) restarts both of its counters.
    public mutating func resetForReady() {
        version = 0
        appliedSeq = 0
    }

    /// The host is about to send `externalUpdate`; the new version to stamp on it.
    public mutating func bumpVersion() -> Int {
        version += 1
        return version
    }

    public enum Verdict: Equatable, Sendable {
        /// Apply the content.
        case admit
        /// Serialized against a version the host moved past: drop it and
        /// re-push the authoritative content so the writer re-bases.
        case repush
        /// Below the seq high-water mark: an older in-flight message; drop.
        case staleSeq
    }

    /// Judge an inbound `update` / `flushResult`, claiming the seq when admitted
    /// (even if the caller's apply then turns out to be a no-op, so the mark
    /// stays a monotonic ceiling).
    public mutating func judge(baseSyncVersion: Int, seq: Int) -> Verdict {
        guard baseSyncVersion == version else { return .repush }
        guard seq > appliedSeq else { return .staleSeq }
        appliedSeq = seq
        return .admit
    }
}
