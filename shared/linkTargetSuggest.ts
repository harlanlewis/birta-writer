/**
 * shared/linkTargetSuggest.ts
 *
 * Pure filtering/ranking helpers for link URL autocompletion (local file
 * targets). Used by BOTH sides: the Extension ranks workspace files before
 * replying, and the WebView re-ranks the reply against the input's latest
 * value so a stale (debounced) reply can never show outdated options.
 * Environment-neutral by design — no Node or DOM APIs.
 */
import type { LinkTargetSuggestionItem } from "./messages";
import { documentExtRegex } from "./documentExtensions";

/**
 * File extensions this editor opens, ranked before other files, from the
 * shared list. `.mdx` ranks with them because a link to one opens in the
 * editor exactly as `.md` does, so ranking it with the plain files it is not
 * would bury the target the author is most likely reaching for.
 */
const MARKDOWN_EXT_REGEX = documentExtRegex();

/** URL scheme prefix (http:, https:, mailto:, vscode:, ...). */
const SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * True when the typed text can meaningfully complete to a workspace file:
 * non-empty and not an external target (scheme URL or in-page #anchor).
 */
export function isLocalPathQuery(query: string): boolean {
    const q = query.trim();
    if (!q) { return false; }
    if (q.startsWith("#")) { return false; }
    if (SCHEME_REGEX.test(q)) { return false; }
    return true;
}

/**
 * The form the user is reaching for: root-relative when the typed text
 * starts with "/", document-relative otherwise.
 */
export function preferredLinkForm(item: LinkTargetSuggestionItem, query: string): string {
    return query.trim().startsWith("/") ? item.rootRelative : item.relative;
}

/**
 * Filters items to case-insensitive substring matches of `query` (checked
 * against both forms so "../notion" and "/write/notion" both hit) and sorts
 * them: markdown files first, then by path length, then alphabetically.
 * Items whose preferred form exactly equals the query are dropped — the
 * path is already complete, there is nothing to suggest.
 */
export function rankLinkTargets(
    items: readonly LinkTargetSuggestionItem[],
    query: string,
    limit = 20,
): LinkTargetSuggestionItem[] {
    const trimmed = query.trim();
    // A leading "./" is an explicit relative prefix, not part of the file path.
    const q = trimmed.replace(/^\.\//, "").toLowerCase();
    return items
        .filter((item) =>
            item.relative.toLowerCase().includes(q) ||
            item.rootRelative.toLowerCase().includes(q))
        .filter((item) => preferredLinkForm(item, trimmed) !== trimmed)
        .sort((a, b) => {
            const aMd = MARKDOWN_EXT_REGEX.test(a.rootRelative);
            const bMd = MARKDOWN_EXT_REGEX.test(b.rootRelative);
            if (aMd !== bMd) { return aMd ? -1 : 1; }
            if (a.rootRelative.length !== b.rootRelative.length) {
                return a.rootRelative.length - b.rootRelative.length;
            }
            return a.rootRelative.localeCompare(b.rootRelative);
        })
        .slice(0, limit);
}
