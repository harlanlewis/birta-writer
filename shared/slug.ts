/**
 * GitHub-compatible slugify function.
 *
 * Rules:
 * 1. Lowercase everything.
 * 2. Strip Unicode punctuation, symbols, and emoji (keep only letters, digits,
 *    hyphens, underscores, and spaces). Non-Latin letters (e.g. CJK) are kept.
 * 3. Replace spaces with hyphens (do not collapse repeated hyphens, do not trim
 *    leading/trailing hyphens).
 *
 * Examples:
 *   "H2 Section Heading"      → "h2-section-heading"
 *   "🚀 Emoji Heading"        → "-emoji-heading"
 *   "Special chars : and &"   → "special-chars--and-"
 *   "Duplicate Heading"       → "duplicate-heading"  (the caller handles dedup suffixes)
 */
export function slugify(text: string): string {
    return text
        .toLowerCase()
        // Strip every character that is not a letter, digit, hyphen, underscore, or space.
        // \p{L} matches all Unicode letters (including CJK), \p{N} matches Unicode digits.
        // This automatically removes emoji, punctuation, etc.
        .replace(/[^\p{L}\p{N}_\- ]/gu, "")
        // Space → hyphen (repeats are preserved, reproducing cases like "special-chars--and-")
        .replace(/ /g, "-");
}

/**
 * Slugify a run of heading titles IN DOCUMENT ORDER, appending GitHub's `-N`
 * disambiguation suffix to the 2nd, 3rd, … occurrence of a colliding base slug
 * (`Foo`, `Foo`, `Foo` → `foo`, `foo-1`, `foo-2`). This is the piece `slugify`
 * deliberately leaves to the caller (see its docstring): the suffix depends on
 * every heading seen so far, not on one title.
 *
 * This is the SINGLE source of truth for anchor targets, shared by everything
 * that must agree byte-for-byte: the click-resolver that finds a heading from
 * `#slug` (linkPopup's findHeadingElement) and any producer of `#slug` hrefs
 * (the section-link picker). If the two computed collision suffixes ever
 * diverged, a link to the second `Foo` would resolve to the first.
 *
 * A title whose base slug is empty (all punctuation/emoji — e.g. "🚀") is
 * unaddressable: it yields "" and does NOT consume a collision counter, exactly
 * as the resolver skips such headings. Callers that filter empties out entirely
 * still agree, because the non-empty entries see identical counts either way.
 */
export function slugifyHeadings(titles: readonly string[]): string[] {
    const counts = new Map<string, number>();
    return titles.map((title) => {
        const base = slugify(title);
        if (!base) {
            return "";
        }
        const n = counts.get(base) ?? 0;
        counts.set(base, n + 1);
        return n === 0 ? base : `${base}-${n}`;
    });
}
