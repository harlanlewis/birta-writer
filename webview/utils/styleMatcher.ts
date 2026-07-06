/**
 * Pure text matchers behind the style check.
 *
 * - Phrase lists (fillers / redundancies / clichés) compile into one
 *   case-insensitive alternation regex per category. Deliberately
 *   regex-simple (no lookaround), following iA Writer's documented choice
 *   for keystroke-time matching performance.
 * - Entries may carry iA-style `~~ ~~` markers around the deletable
 *   sub-span; matches then strike only that sub-span ("combine ~~together~~"
 *   matches "combine together" but flags just "together").
 * - Repeated-word detection ("the the") is a small logic check with the
 *   usual exception list (had had, that that…).
 */

import {
    findPassiveVoice,
    findLongSentences,
    findNegativeParallelism,
    findRuleOfThree,
    findEmDash,
    findNonAsciiPunct,
} from "./proseChecks";

/** Categories backed by a phrase list (compiled to one alternation regex each). */
export type PhraseCategory =
    | "fillers"
    | "redundancies"
    | "cliches"
    | "wordiness"
    | "aiVocabulary"
    | "aiArtifacts";

/** Categories backed by a structural check (sentence shape, not a fixed list). */
export type StructuralCategory =
    | "repeated"
    | "passive"
    | "longSentences"
    | "negativeParallelism"
    | "ruleOfThree"
    | "emDash"
    | "nonAsciiPunct";

export type StyleCategory = PhraseCategory | StructuralCategory;

export type StyleMatch = {
    /** 0-indexed character offset of the flagged span start (inclusive) */
    start: number;
    /** 0-indexed character offset of the flagged span end (exclusive) */
    end: number;
    category: StyleCategory;
};

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePhrase(s: string): string {
    return s.toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ").trim();
}

/** Word-index ranges (inclusive) of the `~~ ~~`-marked words in an entry. */
type StrikeRanges = Array<[number, number]> | null;

type ParsedEntry = {
    /** The entry with markers stripped: the full phrase to match */
    phrase: string;
    /** Which words of the phrase get struck; null = the whole match */
    strikes: StrikeRanges;
};

/** Parse an entry's `~~ ~~` markers into word-index strike ranges. */
export function parseEntry(entry: string): ParsedEntry {
    if (!entry.includes("~~")) { return { phrase: entry, strikes: null }; }
    const ranges: Array<[number, number]> = [];
    let wordIndex = 0;
    let inStrike = false;
    let strikeStart = 0;
    for (const token of entry.split(/\s+/)) {
        let word = token;
        if (word.startsWith("~~")) { inStrike = true; strikeStart = wordIndex; word = word.slice(2); }
        const closes = word.endsWith("~~");
        if (closes) { word = word.slice(0, -2); }
        if (word.length > 0) {
            if (closes && inStrike) { ranges.push([strikeStart, wordIndex]); inStrike = false; }
            wordIndex++;
        } else if (closes) {
            inStrike = false;
        }
    }
    if (inStrike) { ranges.push([strikeStart, wordIndex - 1]); }
    return { phrase: entry.replace(/~~/g, ""), strikes: ranges.length > 0 ? ranges : null };
}

/**
 * Build one word-bounded alternation regex from parsed phrases.
 * Longer phrases are listed first so "pretty much" wins over "pretty";
 * literal spaces match any whitespace run; ASCII apostrophes in a phrase
 * also match typographic ones in the document. Word boundaries are only
 * asserted next to word characters (a phrase ending in "?" has none).
 */
function compileList(phrases: readonly string[]): RegExp | null {
    if (phrases.length === 0) { return null; }
    const alternatives = [...phrases]
        .sort((a, b) => b.length - a.length)
        .map((p) => {
            const body = escapeRegExp(p)
                .replace(/ /g, "\\s+")
                .replace(/'/g, "['’]");
            const lead = /^\w/.test(p) ? "\\b" : "";
            const tail = /\w$/.test(p) ? "\\b" : "";
            return lead + body + tail;
        });
    return new RegExp(`(?:${alternatives.join("|")})`, "gi");
}

export type StyleMatcher = (text: string) => StyleMatch[];

/**
 * Context vetoes: a listed phrase is NOT a style problem in these
 * grammatical contexts. `after` is tested at the match end, `before`
 * against the text leading up to the match start.
 */
const CONTEXT_VETOES: Record<string, Array<{ after?: RegExp; before?: RegExp }>> = {
    // Comparative "rather than" and preferential "would rather" are
    // legitimate grammar, not hedging ("They buy rather than build").
    rather: [
        { after: /^\s+than\b/i },
        { before: /\bwould\s+$/i },
    ],
};

function isVetoed(text: string, start: number, end: number): boolean {
    const rules = CONTEXT_VETOES[text.slice(start, end).toLowerCase()];
    if (!rules) { return false; }
    return rules.some((rule) =>
        (rule.after ? rule.after.test(text.slice(end)) : true)
        && (rule.before ? rule.before.test(text.slice(0, start)) : true));
}

/**
 * Map a match's strike word-ranges to character spans within the matched
 * text. The matched text's words correspond 1:1 to the phrase's words
 * (the regex only widens whitespace and apostrophes, never word count).
 */
function strikeSpans(
    matched: string,
    matchStart: number,
    strikes: Array<[number, number]>,
    category: StyleCategory,
): StyleMatch[] {
    const words: Array<{ start: number; end: number }> = [];
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(matched)) !== null) {
        words.push({ start: m.index, end: m.index + m[0].length });
    }
    const spans: StyleMatch[] = [];
    for (const [from, to] of strikes) {
        if (from >= words.length) { continue; }
        const last = Math.min(to, words.length - 1);
        spans.push({
            start: matchStart + words[from].start,
            end: matchStart + words[last].end,
            category,
        });
    }
    return spans;
}

const PHRASE_CATEGORIES: readonly PhraseCategory[] = [
    "fillers", "redundancies", "cliches", "wordiness", "aiVocabulary", "aiArtifacts",
];

/**
 * Structural checks keyed by category. `repeated` is intentionally absent: it
 * rides the style-check master switch (always on when the master is), so it is
 * appended unconditionally rather than toggled here.
 */
const STRUCTURAL_CHECKS: Record<
    Exclude<StructuralCategory, "repeated">,
    (text: string) => StyleMatch[]
> = {
    passive: findPassiveVoice,
    longSentences: findLongSentences,
    negativeParallelism: findNegativeParallelism,
    ruleOfThree: findRuleOfThree,
    emDash: findEmDash,
    nonAsciiPunct: findNonAsciiPunct,
};

/**
 * Compile the enabled categories into a single matcher function. Phrase
 * categories become alternation regexes; structural categories are pure checks
 * (see proseChecks.ts). Phrases in `exceptions` (the user's escape valve,
 * compared lowercase, markers ignored) are removed before compiling, and any
 * structural hit whose flagged text matches an exception is dropped too. The
 * matcher returns flagged spans sorted by start offset. Both `lists` and
 * `enabled` are partial: an absent list or a falsy flag simply omits that
 * category.
 */
export function compileStyleMatcher(
    lists: Partial<Record<PhraseCategory, readonly string[]>>,
    enabled: Partial<Record<StyleCategory, boolean>>,
    exceptions: readonly string[] = [],
): StyleMatcher {
    const excluded = new Set(exceptions.map((p) => normalizePhrase(p.replace(/~~/g, ""))));
    const compiled: Array<{ category: StyleCategory; regex: RegExp }> = [];
    // Strike ranges per normalized phrase, shared across categories
    const strikesByPhrase = new Map<string, StrikeRanges>();

    for (const category of PHRASE_CATEGORIES) {
        if (!enabled[category]) { continue; }
        const list = lists[category];
        if (!list) { continue; }
        const phrases: string[] = [];
        for (const entry of list) {
            const parsed = parseEntry(entry);
            if (excluded.has(normalizePhrase(parsed.phrase))) { continue; }
            phrases.push(parsed.phrase);
            strikesByPhrase.set(normalizePhrase(parsed.phrase), parsed.strikes);
        }
        const regex = compileList(phrases);
        if (regex) { compiled.push({ category, regex }); }
    }

    const structural = (Object.entries(STRUCTURAL_CHECKS) as Array<
        [Exclude<StructuralCategory, "repeated">, (text: string) => StyleMatch[]]
    >).filter(([category]) => enabled[category]).map(([, fn]) => fn);

    return (text: string): StyleMatch[] => {
        const matches: StyleMatch[] = [];
        for (const { category, regex } of compiled) {
            regex.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = regex.exec(text)) !== null) {
                const start = m.index;
                const end = m.index + m[0].length;
                if (!isVetoed(text, start, end)) {
                    const strikes = strikesByPhrase.get(normalizePhrase(m[0]));
                    if (strikes) {
                        matches.push(...strikeSpans(m[0], start, strikes, category));
                    } else {
                        matches.push({ start, end, category });
                    }
                }
                // Guard against zero-length matches looping forever
                if (m[0].length === 0) { regex.lastIndex++; }
            }
        }
        for (const check of structural) {
            for (const hit of check(text)) {
                if (!excluded.has(normalizePhrase(text.slice(hit.start, hit.end)))) {
                    matches.push(hit);
                }
            }
        }
        matches.push(...findRepeatedWords(text));
        return matches.sort((a, b) => a.start - b.start || a.end - b.end);
    };
}

/**
 * Legitimate doubled words that must never be flagged
 * (retext-repeated-words' exception set).
 */
const REPEAT_EXCEPTIONS = new Set([
    "had", "that", "can", "blah", "beep", "yadda", "sapiens", "tse", "mau",
]);

const REPEATED_RE = /\b([\p{L}']+)(\s+)(\1)\b/giu;

/**
 * Find accidentally repeated words ("the the"), flagging only the second
 * occurrence so the strikethrough reads as "delete this one". Letters only
 * (digits excluded — "5 5" in tables is data, not prose).
 */
export function findRepeatedWords(text: string): StyleMatch[] {
    const matches: StyleMatch[] = [];
    REPEATED_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REPEATED_RE.exec(text)) !== null) {
        const word = m[1].toLowerCase();
        if (!REPEAT_EXCEPTIONS.has(word)) {
            const secondStart = m.index + m[1].length + m[2].length;
            matches.push({ start: secondStart, end: secondStart + m[3].length, category: "repeated" });
        }
        // Allow overlapping runs ("the the the") to flag each extra word
        REPEATED_RE.lastIndex = m.index + m[1].length + m[2].length;
    }
    return matches;
}
