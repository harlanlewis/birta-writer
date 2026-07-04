/**
 * Pure text matcher behind the style check (fillers / redundancies / clichés).
 *
 * Compiles phrase lists into one case-insensitive alternation regex per
 * category. Deliberately regex-simple (no lookaround), following iA Writer's
 * documented choice for keystroke-time matching performance.
 */

export type StyleCategory = "fillers" | "redundancies" | "cliches";

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
 * literal spaces match any whitespace run so phrases survive line wraps.
 */
function compileList(phrases: readonly string[]): RegExp | null {
    if (phrases.length === 0) { return null; }
    const alternatives = [...phrases]
        .sort((a, b) => b.length - a.length)
        .map((p) => escapeRegExp(p).replace(/ /g, "\\s+"));
    return new RegExp(`\\b(?:${alternatives.join("|")})\\b`, "gi");
}

export type StyleMatcher = (text: string) => StyleMatch[];

/**
 * Compile enabled category lists into a single matcher function.
 * The matcher returns matches sorted by start offset; overlapping matches
 * from different categories are all reported (callers may dedupe).
 */
export function compileStyleMatcher(
    lists: Record<StyleCategory, readonly string[]>,
    enabled: Record<StyleCategory, boolean>,
): StyleMatcher {
    const compiled: Array<{ category: StyleCategory; regex: RegExp }> = [];
    for (const category of ["fillers", "redundancies", "cliches"] as const) {
        if (!enabled[category]) { continue; }
        const regex = compileList(lists[category]);
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
        return matches.sort((a, b) => a.start - b.start || a.end - b.end);
    };
}
