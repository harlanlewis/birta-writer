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
