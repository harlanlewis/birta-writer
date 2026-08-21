import Foundation

/// Where an `/ai-advanced` attachment's bytes are written, and under what name.
///
/// A port of `saveAgentAttachment` in `src/agentBridge/askAgent.ts`, kept
/// literal for the same reason as `AgentRequest` and `AgentReference`: Swift
/// cannot import the TypeScript, both surfaces hand a path to the same agents,
/// and `AgentAttachmentTests` carries the cases the TypeScript side does. A
/// change to either has to be made in both.
///
/// A session temp directory, never the note's own `Attachments/` folder. That
/// folder is where `AttachmentStore` puts an image the document references, and
/// it travels with the note by design. An attachment is context for one
/// request: a screenshot dropped in to ask a question about it has no business
/// becoming a file beside the note that the user then has to notice and delete.
///
/// One deliberate divergence, and it is in the sanitizer rather than the rule.
/// The TypeScript operates on UTF-16 code units, so a character outside the
/// Basic Multilingual Plane becomes two underscores there and one here, and the
/// 64-unit truncation counts those units rather than characters. Both sides
/// reduce a name to the same ASCII-safe alphabet and neither can escape its
/// directory, which is what the sanitizer is for; the shared test cases are
/// ASCII, where the two agree exactly.
public enum AgentAttachment {
    /// Largest file that may be written, matching `MAX_ATTACHMENT_BYTES` on
    /// both the panel and the extension.
    ///
    /// The panel refuses an oversized file before reading it, which is the
    /// bound that matters. This one is the floor under that: it is the side
    /// that touches the disk, and it must not depend on the caller having
    /// checked.
    public static let maxBytes = 16 * 1024 * 1024

    public enum Failure: Error, Equatable {
        case tooLarge(bytes: Int)
    }

    /// A name reduced to something that cannot walk out of its directory.
    ///
    /// The basename only, anything outside `[A-Za-z0-9_.-]` replaced, the last
    /// 64 characters kept, leading dots stripped so nothing lands hidden, and
    /// `file` when that leaves nothing at all.
    public static func safeName(_ raw: String) -> String {
        // Empty subsequences are KEPT, matching the TypeScript's `split().pop()`:
        // a name ending in a separator has an empty basename and falls through
        // to `file`, rather than silently naming the directory above it.
        let parts = raw.split(omittingEmptySubsequences: false,
                              whereSeparator: { $0 == "/" || $0 == "\\" })
        let base = parts.last.map(String.init) ?? ""
        let mapped = String(base.map { ch -> Character in
            if ch.isASCII, ch.isLetter || ch.isNumber { return ch }
            return (ch == "_" || ch == "." || ch == "-") ? ch : "_"
        })
        let truncated = String(mapped.suffix(64))
        let stripped = String(truncated.drop(while: { $0 == "." }))
        return stripped.isEmpty ? "file" : stripped
    }

    /// The directory this process writes attachments into.
    ///
    /// Keyed by process id, so two running copies of Jot (a release and a
    /// development build) never write into each other's.
    public static func directory(temporaryDirectory: URL, processID: Int32) -> URL {
        temporaryDirectory.appendingPathComponent("birta-ai-\(processID)", isDirectory: true)
    }

    /// Where one attachment lands.
    ///
    /// `sequence` prefixes the name so two files called the same thing in one
    /// request do not overwrite each other.
    public static func destination(in directory: URL, sequence: Int, name: String) -> URL {
        directory.appendingPathComponent("\(sequence)-\(safeName(name))", isDirectory: false)
    }

    /// The size check, as its own step so a caller can refuse before writing.
    public static func check(byteCount: Int) throws {
        if byteCount > maxBytes { throw Failure.tooLarge(bytes: byteCount) }
    }
}
