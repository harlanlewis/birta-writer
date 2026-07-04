/**
 * Pure text matchers behind the style check.
 *
 * - Phrase lists (fillers / redundancies / clichés) compile into one
 *   case-insensitive alternation regex per category. Deliberately
 *   regex-simple (no lookaround), following iA Writer's documented choice
 *   for keystroke-time matching performance.
 * - Repeated-word detection ("the the") is a small logic check with the
 *   usual exception list (had had, that that…).
 */

export type StyleCategory = "fillers" | "redundancies" | "cliches" | "repeated";

export type StyleMatch = {
    /** 0-indexed character offset of the match start (inclusive) */
    start: number;
    /** 0-indexed character offset of the match end (exclusive) */
    end: number;
    category: StyleCategory;
};

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build one word-bounded alternation regex from a phrase list.
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
 * Compile enabled category lists into a single matcher function.
 * Phrases in `exceptions` (user's escape valve, compared lowercase) are
 * removed before compiling. The matcher returns matches sorted by start
 * offset; overlapping matches from different categories are all reported.
 */
export function compileStyleMatcher(
    lists: Record<Exclude<StyleCategory, "repeated">, readonly string[]>,
    enabled: Record<Exclude<StyleCategory, "repeated">, boolean>,
    exceptions: readonly string[] = [],
): StyleMatcher {
    const excluded = new Set(exceptions.map((p) => p.toLowerCase().replace(/’/g, "'").trim()));
    const compiled: Array<{ category: StyleCategory; regex: RegExp }> = [];
    for (const category of ["fillers", "redundancies", "cliches"] as const) {
        if (!enabled[category]) { continue; }
        const regex = compileList(lists[category].filter((p) => !excluded.has(p)));
        if (regex) { compiled.push({ category, regex }); }
    }

    return (text: string): StyleMatch[] => {
        const matches: StyleMatch[] = [];
        for (const { category, regex } of compiled) {
            regex.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = regex.exec(text)) !== null) {
                matches.push({ start: m.index, end: m.index + m[0].length, category });
                // Guard against zero-length matches looping forever
                if (m[0].length === 0) { regex.lastIndex++; }
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
