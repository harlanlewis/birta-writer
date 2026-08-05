/**
 * Pure text matchers behind the style check.
 *
 * - Phrase lists (fillers / redundancies / clichés) compile into
 *   case-insensitive alternation regexes, chunked at a fixed alternative
 *   count (see MAX_ALTERNATIVES_PER_REGEX — one alternation per category was
 *   seconds of one-time V8 compile work). Deliberately regex-simple (no
 *   lookaround), following iA Writer's documented choice for keystroke-time
 *   matching performance.
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

/**
 * The comparison form of a phrase: what the compiled pattern actually matches,
 * modulo the widenings it applies (case, `'`/`’`, whitespace runs). It is both
 * the strike-lookup key and `compileList`'s sort key. Exported for unit testing.
 */
export function normalizePhrase(s: string): string {
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
 * Alternatives per compiled regex (MAR-305).
 *
 * V8 compiles a large alternation **superlinearly**, and always lazily — never
 * at `new RegExp`, only on `exec`. MAR-315 pinned the mechanism, which is not
 * one compile but up to three per pattern, only the first of which lands on the
 * first scan:
 *
 *   1. the first `exec` compiles the pattern to irregexp **bytecode**;
 *   2. after `--regexp-tier-up-ticks` executions (**default 1**, so on the
 *      second) it **tiers up** and compiles again, to native code;
 *   3. the first `exec` against a **two-byte** subject (anything past Latin-1 —
 *      one curly quote in a paragraph is enough) pays a third compile, because
 *      irregexp compiles per subject-string encoding.
 *
 * The observation that fixes this rather than merely fitting it: running node
 * with `--regexp-tier-up-ticks=3` moves step 2's cost off the second `exec` and
 * onto the fourth, exactly; `--no-regexp-tier-up` removes step 2 entirely and
 * compiles straight to native on the first `exec`. Nothing else proposed for
 * the same timing shape — JIT warm-up of the matching loop, GC from allocating
 * the phrase structures, IC warm-up, string interning, "the second call just
 * reuses a cache the first filled" — moves with a regexp-only V8 flag. And the
 * subject in that probe is the single character `"x"`, so none of what is being
 * measured is matching cost.
 *
 * The compiled code is cached **per process, keyed by (source, flags)** — not
 * per RegExp object. A freshly built, identical set of regexes costs 0.02 ms
 * against ~34 ms for the first set. So the floor is paid once per webview, and
 * rebuilding the matcher on a config toggle (`styleMatcherFor`) is free.
 *
 * Measured on the shipped wordlists (1093 phrases across six categories), one
 * alternation per category, warm-up = all three steps:
 *
 * - Node 22 / V8 12.4: **2.4 s** unchunked, **37 ms** chunked at 256. Scaling a
 *   single alternation there: 400 alternatives 14 ms, 800 → 910 ms, 1093 → 2.4 s.
 *   Steady state also improves, 1.53 ms → 0.20 ms per 2000 characters.
 * - Chromium 151 (median of 7, fresh browser per sample, A/B order alternated):
 *   **113 ms** unchunked → **69 ms** chunked. Steady state is 0.10 ms either way.
 *
 * So the cliff is engine-version-dependent and the 2.4 s figure is NOT what a
 * current Electron pays — but `engines.vscode` still admits 1.95, whose
 * Chromium is years older than the one measured above. Chunking is insurance
 * against whichever V8 the host ships, and it wins on both.
 *
 * The trigger is the `\s+` whitespace widening below — with literal spaces the
 * same 1093-way alternation compiles in 20 ms on Node — but widening is
 * load-bearing (a phrase must match across a doubled space), so the alternation
 * is split rather than simplified. Folding `['’]` into the subject text instead
 * of the pattern was measured too, and does not help (74 ms vs 69 ms).
 *
 * ## What is left of the floor, and why 256 stays (MAR-315)
 *
 * All three steps together cost ~34–50 ms on Node 22 for the shipped lists, and
 * that is the document-size-independent floor the first proofread pass pays.
 * It is **accepted, not removed**. Three ways out were measured and rejected:
 *
 * - **A smaller chunk.** Sweeping 16…384 alternatives per regex moves total
 *   compile time by less than the run-to-run spread (12 samples each at 48 and
 *   256, alternating order: medians 113 ms vs 126 ms, ranges 91–229 and
 *   90–165). Only leaving the chunking altogether is catastrophic — one
 *   alternation per category re-measured at 1310 ms here against the 2.4 s
 *   MAR-305 recorded on the same V8 12.4 (a gap worth nobody's time: it is two
 *   orders of magnitude over the chunked cost either way), and it scans 6×
 *   slower besides. **The win here was the chunking, not its size**; do not
 *   re-sweep the constant hoping for more.
 * - **Compiling only enabled categories.** Already what `compileStyleMatcher`
 *   does, and it works: with `cliches` off the floor drops from 168 ms to
 *   37 ms, with every phrase category off to 4.7 ms. Those three, and the two
 *   chunk-sweep medians above, were taken on a machine running other work — the
 *   absolute values are inflated well past the 34–50 ms quoted earlier, so read
 *   the ratios and not the milliseconds. `cliches` is 732 of the 1093 phrases
 *   and roughly three quarters of the floor — a user who turns it off already
 *   stops paying for it. There is nothing further to split here.
 * - **Warming the regexes in an earlier idle callback.** Relocation, not
 *   removal: the total is fixed, and every destination for it is either the
 *   same idle window or in front of first paint, which `AGENTS.md` forbids.
 *   Worth revisiting only with a browser capture that shows the first pass is
 *   a *long* task on a fixture where the document-scaled half is small.
 */
export const MAX_ALTERNATIVES_PER_REGEX = 256;

/**
 * Build word-bounded alternation regexes from parsed phrases.
 * Literal spaces match any whitespace run; ASCII apostrophes in a phrase also
 * match typographic ones in the document. Word boundaries are only asserted
 * next to word characters (a phrase ending in "?" has none).
 *
 * The result is a *list* of regexes, chunked at MAX_ALTERNATIVES_PER_REGEX —
 * see there for why. Because each chunk scans independently, a category's raw
 * hits can now overlap where one alternation's leftmost-longest scan would have
 * produced a single hit; `leftmostLongest` restores that. Exported for unit
 * testing.
 *
 * ## Why alternatives are sorted DESCENDING by normalized phrase (MAR-315)
 *
 * Two things have to hold, and this one order gets both.
 *
 * **Correctness — "pretty much" must win over "pretty".** Alternation is
 * leftmost-*first*, not leftmost-longest, so within a chunk the order decides
 * which of two alternatives matching at the same start position wins. Two
 * alternatives can only match at one start position with different lengths when
 * the shorter match is a prefix of the longer one *in the same subject string*,
 * which means the shorter phrase's normalized form is a proper prefix of the
 * longer's. A proper prefix always sorts BEFORE the longer string ascending, so
 * descending puts the longer phrase first — for every such pair, unconditionally.
 * Straddling a chunk boundary is safe for a different reason: separate chunks
 * both report their hit and `leftmostLongest` keeps the longer. So the observable
 * contract — longest match wins — no longer depends on the sort at all, which is
 * exactly what `styleMatcherOrdering.test.ts` pins.
 *
 * The key is the **normalized** phrase, not the raw one, because matching is
 * case-insensitive and widens `'`/`’` and whitespace: raw-descending would let a
 * lowercase "delve" outrank a capitalized "Delve into" ("d" > "D"). The shipped
 * lists are all normalized already, so for them the two keys produce byte-
 * identical patterns; the normalization is what stops a future non-lowercase
 * entry from silently flipping a pair.
 *
 * The argument above was not trusted on its own. A differential over the six
 * shipped lists — 60 repo markdown files plus every phrase in six contexts
 * (uppercased, doubled spaces, typographic apostrophes, bare, parenthesized,
 * concatenated with another phrase); 10,990 inputs, 1.1 M characters — produced
 * **byte-identical** spans under the old length-descending order and this one,
 * all 17,872 of them. Ascending, run as a control, diverged on 142 lines. Counts
 * alone would not have shown either: they are equal in all three.
 *
 * **Speed.** Sorting lexicographically groups alternatives that share a prefix,
 * which irregexp exploits. Scanning the 1093 phrases over the `large` perf
 * fixture, 15 alternating samples in one process, identical 540 hits: Chromium
 * 151 median 10.6 → 7.3 ms, Node 22 / V8 12.4 11.5 → 7.8 ms (−31% both).
 *
 * **What that is NOT worth.** The scan is a smaller share of the proofread pass
 * than it looks: the `proofread` span on `large` measures ~62 ms, so ~3 ms is
 * about 5% of it, and the span read 62.4 ms before this change and 63.4 ms after
 * (`node e2e/perf.mjs large`, idle, median-of-9 each) — i.e. unmoved within the
 * drift of an absolute cross-run comparison, which cannot resolve 3 ms either
 * way. So this is a free and correct win in the scan itself, and NOT a
 * user-visible speed-up of the pass; it deliberately has no CHANGELOG entry. If
 * you are looking for the rest of that span, it is lint dispatch and decoration
 * building, and nobody has attributed them. The one-time
 * compile floor did not get worse — medians of 6 fresh processes each, 74 ms
 * before and 57 ms after, ranges 58.5–81.4 and 51.8–68.2 on a contended machine,
 * which overlap far too much to claim the difference either way.
 */
export function compileList(phrases: readonly string[]): RegExp[] {
    const alternatives = [...phrases]
        .map((phrase) => ({ phrase, key: normalizePhrase(phrase) }))
        .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
        .map(({ phrase: p }) => {
            const body = escapeRegExp(p)
                .replace(/ /g, "\\s+")
                .replace(/'/g, "['’]");
            const lead = /^\w/.test(p) ? "\\b" : "";
            const tail = /\w$/.test(p) ? "\\b" : "";
            return lead + body + tail;
        });
    const regexes: RegExp[] = [];
    for (let i = 0; i < alternatives.length; i += MAX_ALTERNATIVES_PER_REGEX) {
        const chunk = alternatives.slice(i, i + MAX_ALTERNATIVES_PER_REGEX);
        regexes.push(new RegExp(`(?:${chunk.join("|")})`, "gi"));
    }
    return regexes;
}

/** A raw phrase hit, before vetoes and strike-span resolution. */
type Span = { start: number; end: number };

/**
 * Reduce a category's hits — gathered from several chunk regexes — to the
 * non-overlapping set a single longest-first alternation would have produced:
 * leftmost position wins, longest match wins a tie, and the scan resumes after
 * the winner. Without this, "pretty much" and "pretty" landing in different
 * chunks would both be flagged. Exported for unit testing.
 */
export function leftmostLongest(hits: Span[]): Span[] {
    if (hits.length < 2) { return hits; }
    const sorted = [...hits].sort((a, b) => a.start - b.start || b.end - a.end);
    const kept: Span[] = [];
    let cursor = -1; // end of the last kept hit; -1 admits a hit at offset 0
    for (const hit of sorted) {
        if (hit.start < cursor) { continue; }
        kept.push(hit);
        cursor = hit.end;
    }
    return kept;
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
    const compiled: Array<{ category: StyleCategory; regexes: RegExp[] }> = [];
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
        const regexes = compileList(phrases);
        if (regexes.length > 0) { compiled.push({ category, regexes }); }
    }

    const structural = (Object.entries(STRUCTURAL_CHECKS) as Array<
        [Exclude<StructuralCategory, "repeated">, (text: string) => StyleMatch[]]
    >).filter(([category]) => enabled[category]).map(([, fn]) => fn);

    return (text: string): StyleMatch[] => {
        const matches: StyleMatch[] = [];
        for (const { category, regexes } of compiled) {
            const hits: Span[] = [];
            for (const regex of regexes) {
                regex.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = regex.exec(text)) !== null) {
                    hits.push({ start: m.index, end: m.index + m[0].length });
                    // Guard against zero-length matches looping forever
                    if (m[0].length === 0) { regex.lastIndex++; }
                }
            }
            // One chunk already scans leftmost-longest; several need merging.
            for (const { start, end } of regexes.length > 1 ? leftmostLongest(hits) : hits) {
                if (isVetoed(text, start, end)) { continue; }
                const matched = text.slice(start, end);
                const strikes = strikesByPhrase.get(normalizePhrase(matched));
                if (strikes) {
                    matches.push(...strikeSpans(matched, start, strikes, category));
                } else {
                    matches.push({ start, end, category });
                }
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
