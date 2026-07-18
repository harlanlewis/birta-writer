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
 * `#slug` (linkPopup's resolveAnchorHeading, model-sourced) and any producer of
 * `#slug` hrefs (the section-link picker, also model-sourced). If the two
 * computed collision suffixes ever diverged, a link to the second `Foo` would
 * resolve to the first.
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

/**
 * Compute the `oldSlug → newSlug` renames produced by editing a document's
 * headings, given the OLD and NEW heading titles IN DOCUMENT ORDER plus a
 * pairing that says which new heading each old heading became. Powers the
 * auto-update of in-note `#slug` anchor links when a heading is renamed
 * (MAR-180): the caller (anchorSync) supplies `oldToNew` by mapping each old
 * heading's document position through the transaction, then this derives the
 * exact slug substitutions to apply to link hrefs.
 *
 * `oldToNew[i]` is the index into `newTitles` that old heading `i` became, or
 * `-1` when it has no counterpart (deleted, or moved so it can't be paired —
 * either way its inbound links must be LEFT dangling, never rewritten to
 * garbage). A pairing rather than a positional zip is essential: a rename can
 * add or remove a heading, so the two lists need not line up index-for-index.
 *
 * Both sides are run through the FULL `slugifyHeadings` so GitHub's document-
 * order `-N` disambiguation is reflected on each side independently. That is
 * what makes the duplicate-shift case correct without any special-casing:
 * renaming the first of two `Foo` headings (slugs `foo`, `foo-1`) turns the
 * survivor's slug into `foo`, so BOTH pairs differ — `foo → bar` (the edited
 * one) AND `foo-1 → foo` (the sibling that inherited the base slug) — and both
 * are captured because every paired heading is diffed, not just the one whose
 * title changed. A newly-created collision is handled by the same mechanism:
 * if an edit makes a second `Foo`, the survivor keeps `foo` and the newcomer
 * becomes `foo-1`, so only the heading that actually changed slug is recorded.
 *
 * A pair is recorded only when BOTH slugs are non-empty and they differ:
 * - equal slugs mean the anchor target is unchanged (e.g. a heading was MOVED
 *   but its text — and so its slug — did not change), so nothing to rewrite;
 * - an empty slug is an unaddressable heading (all punctuation/emoji, e.g.
 *   "🚀"); it has no `#slug` to be the source or destination of a link, so it
 *   can neither be renamed-from nor renamed-to.
 *
 * The result maps each ORIGINAL slug to its single new slug; the caller applies
 * it to each link's current href exactly once (never chaining `foo → bar` into
 * a subsequent `bar → …`), since it reads the pre-edit href and looks it up
 * one time.
 */
export function computeSlugRenames(
    oldTitles: readonly string[],
    newTitles: readonly string[],
    oldToNew: readonly number[],
): Map<string, string> {
    const oldSlugs = slugifyHeadings(oldTitles);
    const newSlugs = slugifyHeadings(newTitles);
    const renames = new Map<string, string>();
    for (let i = 0; i < oldSlugs.length; i++) {
        const j = oldToNew[i];
        if (j === undefined || j < 0) {
            continue; // unpaired (deleted / moved) — leave its links dangling
        }
        const from = oldSlugs[i];
        const to = newSlugs[j];
        if (from && to && from !== to) {
            renames.set(from, to);
        }
    }
    return renames;
}
