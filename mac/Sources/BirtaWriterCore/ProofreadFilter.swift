import Foundation

/// Whether a flagged span is prose worth showing or a tech-like token a prose
/// checker should stay quiet about.
///
/// A literal port of `shared/proofreadFilter.ts`, in the same family as
/// `AgentRequest` and `AgentReference`: the extension host filters Harper's
/// lints with those rules before the page draws them, and this shell filters
/// the system checker's with the same ones, so the same paragraph is marked up
/// the same way on both surfaces. `ProofreadFilterTests` mirrors the TypeScript
/// suite case for case, which is what holds the two ports together; a case
/// added on one side and not the other is the way they drift.
///
/// ## Why this counts in UTF-16
///
/// The offsets are the PAGE'S, and a JavaScript string is UTF-16, so a span the
/// page can slice is a range of UTF-16 code units. `NSSpellChecker` answers in
/// `NSRange`, which is also UTF-16, so the two meet with no conversion and this
/// file works in the same units rather than in Swift's grapheme clusters. Doing
/// it in `Character`s would agree with the page for as long as the text stayed
/// inside the basic plane and disagree, silently, the first time somebody typed
/// an emoji ahead of a typo.
public enum ProofreadFilter {
    /// Placeholder the page puts where a non-text inline node was.
    public static let inlinePlaceholder: UInt16 = 0xFFFC

    /// Characters marking a whitespace-delimited chunk as tech-speak.
    private static let techChars: Set<UInt16> = Set("./\\@_~#=&`".utf16)

    private static func isSpace(_ unit: UInt16) -> Bool {
        guard let scalar = Unicode.Scalar(unit) else { return false }
        return Character(scalar).isWhitespace
    }

    /// Letter or number, for the trim. A surrogate half is neither, and is
    /// treated as a letter on purpose: it is half of some real character, and
    /// trimming it would cut a chunk in the middle of one.
    private static func isLetterOrNumber(_ unit: UInt16) -> Bool {
        if unit >= 0xD800 && unit <= 0xDFFF { return true }
        guard let scalar = Unicode.Scalar(unit) else { return false }
        return scalar.properties.isAlphabetic || Character(scalar).isNumber
    }

    private static func isUppercase(_ unit: UInt16) -> Bool {
        guard let scalar = Unicode.Scalar(unit) else { return false }
        return Character(scalar).isUppercase
    }

    private static func isNumber(_ unit: UInt16) -> Bool {
        guard let scalar = Unicode.Scalar(unit) else { return false }
        return Character(scalar).isNumber
    }

    /// True when the span at [start, end) sits in a tech-like context: its
    /// containing chunk looks like a path, URL or e-mail, or the span itself is
    /// identifier-shaped.
    public static func isTechSpan(_ text: String, start: Int, end: Int) -> Bool {
        let units = Array(text.utf16)
        guard start >= 0, end <= units.count, start < end else { return false }
        let span = Array(units[start..<end])

        // Identifier-shaped: internal capitals, or any digit. Only for a span
        // with no space in it, so a multi-word grammar hit is never vetoed here.
        if span.contains(where: { !isSpace($0) }) && !span.contains(where: { isSpace($0) }) {
            if span.dropFirst().contains(where: isUppercase) { return true }
            if span.contains(where: isNumber) { return true }
        }

        // Expand to the containing whitespace-delimited chunk and read its shape.
        var chunkStart = start
        while chunkStart > 0 && !isSpace(units[chunkStart - 1]) { chunkStart -= 1 }
        var chunkEnd = end
        while chunkEnd < units.count && !isSpace(units[chunkEnd]) { chunkEnd += 1 }
        let chunk = Array(units[chunkStart..<chunkEnd])
        if chunk.contains(inlinePlaceholder) { return true }

        let trimmed = trimChunk(chunk)
        if trimmed.contains(where: { techChars.contains($0) }) { return true }
        // `://` as a unit, which the character set above cannot express. It is
        // reachable only when the colon and the slashes were all trimmed off
        // the ends, which the set already covers otherwise.
        let colon = UInt16(UnicodeScalar(":").value)
        let slash = UInt16(UnicodeScalar("/").value)
        for i in trimmed.indices where i + 2 < trimmed.count
            && trimmed[i] == colon && trimmed[i + 1] == slash && trimmed[i + 2] == slash {
            return true
        }
        return false
    }

    /// Strip punctuation that merely surrounds a chunk (quotes, brackets, and
    /// the sentence mark after a domain).
    private static func trimChunk(_ chunk: [UInt16]) -> [UInt16] {
        var lower = chunk.startIndex
        while lower < chunk.endIndex && !isLetterOrNumber(chunk[lower]) { lower += 1 }
        var upper = chunk.endIndex
        while upper > lower && !isLetterOrNumber(chunk[upper - 1]) { upper -= 1 }
        return Array(chunk[lower..<upper])
    }
}
