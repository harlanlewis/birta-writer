import Foundation

/// Whether a typed query matches a candidate the way a palette expects, and
/// how well (MAR-458).
///
/// A subsequence match, case-insensitive: every character of the query has
/// to appear in the candidate, in order, not necessarily adjacent, so `ital`
/// finds Italic and `sca` finds Save a Copy As. What separates a good match
/// from a poor one is where the letters land, and the score says so:
///
/// * a letter that starts a word (the first character, or one after a space,
///   slash, dot, dash or underscore, or a capital after a lowercase) is worth
///   the most, because `sca` should read Save a Copy As, three word starts,
///   ahead of any title where the same three letters sit inside its words;
/// * a letter adjacent to the previous match is worth more than one that is
///   not, so a typed run of a word beats the same letters scattered;
/// * every candidate character skipped between matches costs a little, so a
///   match packed at the front of a short title beats one spread across a
///   long path.
///
/// Greedy from the left, with one lookahead: at each query letter the match
/// takes the next occurrence that starts a word if there is one nearby, else
/// the next occurrence at all. That is not the optimal alignment and does
/// not need to be; it is the alignment a person's eye makes, and it is what
/// keeps this a few dozen lines with no dependency, which the ticket asked
/// for. Where it refuses a candidate the plain first-occurrence alignment
/// stands in (`match` says why). The ranges are handed back so a row can
/// draw the letters it matched.
public enum FuzzyMatch {
    public struct Match: Equatable, Sendable {
        public let score: Int
        /// The matched characters, as offsets into the candidate's characters.
        public let ranges: [Range<Int>]

        public init(score: Int, ranges: [Range<Int>]) {
            self.score = score
            self.ranges = ranges
        }
    }

    /// How far ahead the boundary lookahead reaches. Far enough to skip a
    /// short word (`a` in Save a Copy As), not so far that a boundary at the
    /// end of a long path steals a letter from its start.
    private static let lookahead = 12

    /// The match, or nil when the query is not a subsequence of the
    /// candidate. An empty query matches everything with no letters marked.
    ///
    /// The greedy alignment above, and when it refuses, the plain one that
    /// takes each letter's first occurrence. The greedy walk can refuse a
    /// candidate that is a match, and even one that STARTS with the query:
    /// `theme` against `Theme › Harlan Slate` jumps from the T to Harlan's
    /// word-start H, then finds no m after it, and returns nil, while the
    /// plain walk reads the first word. The plain walk is a fallback rather
    /// than a rival scored beside it, so every ranking between candidates
    /// the greedy walk does align is exactly what it was; what changes is
    /// that a subsequence is never refused.
    public static func match(_ query: String, in candidate: String) -> Match? {
        let needle = Array(query.lowercased())
        guard !needle.isEmpty else { return Match(score: 0, ranges: []) }
        let hay = Array(candidate)
        let folded = Array(candidate.lowercased())
        guard folded.count == hay.count else { return fallbackMatch(needle, folded: folded) }
        return align(needle, folded: folded, hay: hay, preferringWordStarts: true)
            ?? align(needle, folded: folded, hay: hay, preferringWordStarts: false)
    }

    private static func align(_ needle: [Character], folded: [Character], hay: [Character],
                              preferringWordStarts: Bool) -> Match? {
        var score = 0
        var ranges: [Range<Int>] = []
        var position = 0
        var previous = -1
        for letter in needle {
            let found = preferringWordStarts
                ? nextIndex(of: letter, in: folded, from: position, original: hay)
                : folded[position...].firstIndex(of: letter)
            guard let at = found else { return nil }
            let boundary = isWordStart(at, in: hay)
            let adjacent = previous >= 0 && at == previous + 1
            score += boundary ? 3 : (adjacent ? 2 : 1)
            // Skipped characters cost, capped so a long tail of skipping does
            // not push a real match below zero.
            score -= min(at - position, 4)
            if let last = ranges.last, last.upperBound == at {
                ranges[ranges.count - 1] = last.lowerBound..<(at + 1)
            } else {
                ranges.append(at..<(at + 1))
            }
            previous = at
            position = at + 1
        }
        // A short candidate that matches is a closer match than a long one:
        // `Bold` over `Bold the heading`. Small, so it never outweighs a
        // boundary.
        score -= min(hay.count / 16, 3)
        return Match(score: score, ranges: ranges)
    }

    /// The next place `letter` occurs at or after `from`: a word start within
    /// the lookahead when there is one, else the first occurrence.
    private static func nextIndex(of letter: Character, in folded: [Character], from: Int, original: [Character]) -> Int? {
        var first: Int?
        var index = from
        while index < folded.count {
            if folded[index] == letter {
                if isWordStart(index, in: original) { return index }
                if first == nil { first = index }
                if index - from > lookahead, first != nil { return first }
            }
            index += 1
        }
        return first
    }

    private static func isWordStart(_ index: Int, in text: [Character]) -> Bool {
        guard index > 0 else { return true }
        let before = text[index - 1]
        if before == " " || before == "/" || before == "." || before == "-" || before == "_" || before == "(" {
            return true
        }
        // A capital after a lowercase letter, as in `openHostPreferences`.
        return text[index].isUppercase && before.isLowercase
    }

    /// For a candidate whose lowercase form has a different character count
    /// (a handful of scripts fold that way), match on the folded text alone
    /// and mark nothing rather than mark the wrong letters.
    private static func fallbackMatch(_ needle: [Character], folded: [Character]) -> Match? {
        var position = 0
        for letter in needle {
            guard let at = folded[position...].firstIndex(of: letter) else { return nil }
            position = at + 1
        }
        return Match(score: 0, ranges: [])
    }
}
