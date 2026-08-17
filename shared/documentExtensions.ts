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

const ALTERNATION = DOCUMENT_EXTENSIONS.join("|");

/**
 * Matches a path this editor opens. Built from the list rather than written
 * out, so the two can never disagree.
 *
 * Shared rather than constructed per call, and safe to share only because
 * neither pattern carries `g`: `lastIndex` is what makes a shared RegExp
 * stateful, and without `g` there is none to carry. `documentExtensions.test.ts`
 * asserts that, so the sharing cannot quietly stop being safe.
 *
 * It is shared because the callers are loops, not file work: `wikiNameOf` runs
 * over every workspace suggestion on every keystroke of a wikilink query.
 */
export const DOCUMENT_EXT_REGEX = new RegExp(`\\.(${ALTERNATION})$`, "i");

/** Matches a bundle index file (`index.md`, `_index.mdx`) in any of the formats. */
export const INDEX_FILE_REGEX = new RegExp(`^_?index\\.(${ALTERNATION})$`, "i");

/** True when `path` is a file the custom editor opens. */
export function isDocumentPath(path: string): boolean {
    return DOCUMENT_EXT_REGEX.test(path);
}
