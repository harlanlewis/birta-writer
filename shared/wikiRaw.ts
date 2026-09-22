/**
 * shared/wikiRaw.ts
 *
 * The reading of a wikilink's raw inner bytes (`target#heading|alias`), with
 * no editor attached. The page's wikilink node and the host's folder index
 * both split a wikilink here, so a chip and the index can never disagree
 * about which file a `[[...]]` names.
 */

/** The parsed (display/navigation) reading of a wikilink's raw content. */
export interface WikiRawParts {
    /** file target, trimmed; empty for a same-page `[[#heading]]` link */
    target: string;
    /** heading inside the target, trimmed; null when absent */
    heading: string | null;
    /** display alias, trimmed; null when absent */
    alias: string | null;
}

/** Index of the first `ch` not preceded by a backslash, or -1. */
function indexOfUnescaped(s: string, ch: string): number {
    for (let i = 0; i < s.length; i++) {
        if (s[i] === "\\") { i++; continue; }
        if (s[i] === ch) return i;
    }
    return -1;
}

/**
 * Splits a wikilink's raw inner bytes on the FIRST unescaped `|` (alias —
 * `\|` is Obsidian's in-table spelling of a plain pipe) and the first `#`
 * before it (heading). Returns trimmed, unescaped copies for display and
 * resolution; `raw` itself is never modified — it is what serializes back
 * to disk.
 */
export function parseWikiRaw(raw: string): WikiRawParts {
    const unescapePipes = (s: string) => s.replace(/\\\|/g, "|");
    const pipe = indexOfUnescaped(raw, "|");
    const targetPart = pipe >= 0 ? raw.slice(0, pipe) : raw;
    const aliasPart = pipe >= 0 ? raw.slice(pipe + 1) : null;
    const hash = targetPart.indexOf("#");
    const target = unescapePipes(hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
    const heading = hash >= 0 ? unescapePipes(targetPart.slice(hash + 1)).trim() : null;
    const alias = aliasPart !== null ? unescapePipes(aliasPart).trim() : null;
    return { target, heading, alias };
}

/**
 * The text a wikilink displays: the alias if present, else target(#heading).
 * A degenerate raw (`[[ ]]`, `[[|]]`) falls back to the bracketed source so
 * the atom is never an invisible chip ("visible but safe").
 */
export function wikiDisplayText(raw: string): string {
    const { target, heading, alias } = parseWikiRaw(raw);
    if (alias) return alias;
    const text = heading !== null && heading !== "" ? `${target}#${heading}` : target;
    return text.trim() !== "" ? text : `[[${raw}]]`;
}
