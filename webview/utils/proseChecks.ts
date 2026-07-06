/**
 * Structural style checks — the ones a flat phrase list can't express because
 * they depend on sentence shape, not a fixed vocabulary. Each is a pure
 * function over a block's plain text, returning `StyleMatch` spans in the same
 * shape the phrase matcher emits, so they flow through the proofread plugin's
 * decoration/exception plumbing unchanged.
 *
 * These sit beside `findRepeatedWords` (in styleMatcher.ts, the original
 * structural check) and are registered there. Prose checks (passive, long
 * sentences) are seeded from write-good (MIT); the AI-tell structural checks
 * (negative parallelism, rule of three) from the same MIT-clean sources as the
 * AI wordlists (see wordlists.ts).
 */
import type { StyleMatch } from "./styleMatcher";

/** Irregular past participles that a `-ed` test misses (be-verb + these = passive). */
const IRREGULAR_PARTICIPLES = new Set([
    "done", "gone", "made", "seen", "known", "given", "taken", "written", "shown",
    "found", "held", "kept", "left", "told", "brought", "bought", "caught", "taught",
    "built", "sent", "spent", "meant", "paid", "said", "read", "led", "set", "put",
    "begun", "chosen", "driven", "drawn", "eaten", "fallen", "forgotten", "hidden",
    "broken", "spoken", "stolen", "thrown", "worn", "born", "borne", "dealt", "felt",
    "grown", "laid", "lost", "proven", "risen", "sold", "understood", "won", "become",
]);

/**
 * Common "-ed" words that are predicate adjectives, not passive verbs — "I was
 * tired", "she is interested". Excluding them cuts the passive check's most
 * frequent false positive (a be-verb + a feeling word reads as passive to the
 * regex but never is).
 */
const PREDICATE_ADJECTIVES = new Set([
    "tired", "excited", "interested", "pleased", "bored", "worried", "confused",
    "surprised", "satisfied", "disappointed", "scared", "frightened", "exhausted",
    "concerned", "thrilled", "delighted", "annoyed", "amused", "embarrassed",
    "convinced", "determined", "committed", "dedicated", "qualified", "experienced",
]);

function isPastParticiple(word: string): boolean {
    const w = word.toLowerCase();
    if (PREDICATE_ADJECTIVES.has(w)) { return false; }
    if (IRREGULAR_PARTICIPLES.has(w)) { return true; }
    // Regular participles end in "-ed"; require length so "red"/"bed" don't match.
    return w.length > 3 && /[a-z]ed$/.test(w);
}

const BE_VERB = /\b(?:am|are|were|being|is|been|was|be)\b/gi;

/**
 * Passive voice: a "to be" verb followed (past an optional adverb) by a past
 * participle — "was written", "is being reviewed". Flags the be-verb -> participle
 * span. Same heuristic write-good uses; it over-flags adjectival "-ed" ("was
 * tired"), which the user can silence per-phrase via the exceptions list.
 */
export function findPassiveVoice(text: string): StyleMatch[] {
    const matches: StyleMatch[] = [];
    BE_VERB.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BE_VERB.exec(text)) !== null) {
        const beEnd = m.index + m[0].length;
        // After the be-verb: required whitespace, an optional single adverb, then
        // the candidate word.
        const after = /^(\s+)(?:([A-Za-z]+ly)(\s+))?([A-Za-z]+)/.exec(text.slice(beEnd));
        if (!after) { continue; }
        if (!isPastParticiple(after[4])) { continue; }
        matches.push({ start: m.index, end: beEnd + after[0].length, category: "passive" });
    }
    return matches;
}

const SENTENCE = /[^.!?]+[.!?]*/g;

/**
 * Long sentences: any sentence over `maxWords` words, flagged whole. A blunt
 * readability proxy (Hemingway's "hard to read"), off by default — the span is
 * large, so it reads as a nudge, not a deletion.
 */
export function findLongSentences(text: string, maxWords = 30): StyleMatch[] {
    const matches: StyleMatch[] = [];
    SENTENCE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SENTENCE.exec(text)) !== null) {
        const chunk = m[0];
        if (chunk.length === 0) { SENTENCE.lastIndex++; continue; }
        const leading = chunk.length - chunk.replace(/^\s+/, "").length;
        const trimmedEnd = chunk.replace(/\s+$/, "").length;
        const wordCount = (chunk.match(/\S+/g) ?? []).length;
        if (wordCount > maxWords) {
            matches.push({ start: m.index + leading, end: m.index + trimmedEnd, category: "longSentences" });
        }
    }
    return matches;
}

const NEGATIVE_PARALLELISM: readonly RegExp[] = [
    // "not just / only / merely X but (also) Y"
    /\bnot (?:just|only|merely|simply)\b[^.!?;:\n]{1,80}?\bbut\b(?:\s+also\b)?/gi,
    // "it's not X, it's Y" — the reframe negation. The tell is the *echo* of the
    // subject-copula ("it's … it's"), so this deliberately does NOT accept a
    // trailing "but": "it's not ready, but we ship" is ordinary contrast, which
    // pattern 1 already covers when it's the "not just … but" form.
    /\b(?:it'?s|it is|this is|that'?s|that is)\s+not\b[^,.!?;:\n]{1,60},\s+(?:it'?s|it is)\b/gi,
];

/**
 * Negative parallelism: the "not just X, but Y" / "it's not X, it's Y" reframe —
 * one of the most-catalogued AI cadences. Flags the whole construction;
 * overlapping matches from the two patterns are de-duplicated.
 */
export function findNegativeParallelism(text: string): StyleMatch[] {
    const matches: StyleMatch[] = [];
    for (const re of NEGATIVE_PARALLELISM) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const start = m.index;
            const end = m.index + m[0].length;
            if (m[0].length === 0) { re.lastIndex++; continue; }
            if (matches.some((x) => start < x.end && end > x.start)) { continue; }
            matches.push({ start, end, category: "negativeParallelism" });
        }
    }
    return matches.sort((a, b) => a.start - b.start);
}

/** Suffixes that mark a word as adjective/adverb-like, to gate the triad check. */
const ADJ_SUFFIX = /(?:ive|ous|ful|ent|ant|ing|ed|al|ic|ble|less|ual|ary|ory|ly)$/i;

/**
 * Common short adjectives with no derivational suffix, so the classic bare
 * triad ("fast, cheap, and reliable") is caught without a part-of-speech
 * tagger. Deliberately small — every entry widens the noun-list false-positive
 * risk, so it holds only high-frequency adjectives, not colours or sizes that
 * double as nouns.
 */
const COMMON_ADJECTIVES = new Set([
    "fast", "slow", "cheap", "good", "bad", "hard", "soft", "clean", "safe",
    "fair", "rich", "poor", "quick", "strong", "weak", "clear", "smart",
    "simple", "easy", "free", "true", "real", "fake", "sharp", "deep",
]);

function isAdjectiveLike(word: string): boolean {
    return ADJ_SUFFIX.test(word) || COMMON_ADJECTIVES.has(word.toLowerCase());
}

const TRIAD = /\b([A-Za-z]+), ([A-Za-z]+),? and ([A-Za-z]+)\b/gi;

/**
 * Rule of three: three stacked adjective-like terms ("efficient, scalable, and
 * maintainable") — artificial emphasis by triple. Gated to adjective/adverb
 * shapes so plain lists ("apples, oranges, and bananas") don't trip it, but
 * still noisy by nature: off by default.
 */
export function findRuleOfThree(text: string): StyleMatch[] {
    const matches: StyleMatch[] = [];
    TRIAD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TRIAD.exec(text)) !== null) {
        if (isAdjectiveLike(m[1]) && isAdjectiveLike(m[2]) && isAdjectiveLike(m[3])) {
            matches.push({ start: m.index, end: m.index + m[0].length, category: "ruleOfThree" });
        }
        TRIAD.lastIndex = m.index + 1; // allow overlapping triads
    }
    return matches;
}

// Em dash (U+2014) and en dash (U+2013) glyphs. The author's voice marks asides
// with a spaced ASCII hyphen, so a real dash glyph is itself a tell; also a
// catalogued AI tic.
const DASH = /[\u2014\u2013]/g;

export function findEmDash(text: string): StyleMatch[] {
    const matches: StyleMatch[] = [];
    DASH.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DASH.exec(text)) !== null) {
        matches.push({ start: m.index, end: m.index + 1, category: "emDash" });
    }
    return matches;
}

// Curly quotes (U+2018/19/1C/1D), the ellipsis glyph (U+2026), and invisible
// spaces (nbsp U+00A0, thin U+2009, zero-width U+200B..U+200D) — normalize to
// ASCII. Dashes are handled by findEmDash; the inline-node placeholder (U+FFFC)
// and other non-ASCII (accented letters, names) are deliberately left alone.
const NON_ASCII_PUNCT = /[\u2018\u2019\u201C\u201D\u2026\u00A0\u2009\u200B\u200C\u200D]/g;

export function findNonAsciiPunct(text: string): StyleMatch[] {
    const matches: StyleMatch[] = [];
    NON_ASCII_PUNCT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NON_ASCII_PUNCT.exec(text)) !== null) {
        matches.push({ start: m.index, end: m.index + 1, category: "nonAsciiPunct" });
    }
    return matches;
}
