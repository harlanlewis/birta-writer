/**
 * shared/documentExtensions.ts
 *
 * The file extensions this editor opens, in ONE place.
 *
 * They were spelled out separately in four: the provider's own routing, the
 * open-a-text-tab swap in `extension.ts`, link-target ranking, and wikilink
 * completion. Adding `.mdx` reached two of the four, so a `.mdx` file opened
 * from the explorer stayed in the raw text editor while a `.md` file swapped
 * to the editor, and `[[a-page]]` offered `.md` targets only. Both were the
 * same omission, found separately, months apart.
 *
 * A list re-derived at each call site is a list that goes out of step, so the
 * next format is added here and nowhere else. Environment-neutral: no Node,
 * no DOM, importable from both sides.
 */

/** Extensions the custom editor opens, without their leading dot. */
export const DOCUMENT_EXTENSIONS = ["md", "markdown", "mdx"] as const;

/**
 * Matches a path this editor opens. Built from the list rather than written
 * out, so the two can never disagree.
 *
 * A fresh RegExp per call, because a shared literal with the `g` flag would
 * carry `lastIndex` between callers; this one has no `g`, and the cost of
 * constructing it is nothing next to the file work every caller is doing.
 */
export function documentExtRegex(): RegExp {
    return new RegExp(`\\.(${DOCUMENT_EXTENSIONS.join("|")})$`, "i");
}

/** True when `path` is a file the custom editor opens. */
export function isDocumentPath(path: string): boolean {
    return documentExtRegex().test(path);
}

/** Matches a bundle index file (`index.md`, `_index.mdx`) in any of the formats. */
export function indexFileRegex(): RegExp {
    return new RegExp(`^_?index\\.(${DOCUMENT_EXTENSIONS.join("|")})$`, "i");
}
