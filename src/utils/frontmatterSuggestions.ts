/**
 * Pure helpers for workspace-aware frontmatter list-value suggestions.
 *
 * When the user opens the "+" menu on a list-valued frontmatter key
 * (tags/related/keywords, ...), the WebView asks the Extension for every value
 * used under the same key in the other markdown files of the workspace. This
 * module holds the vscode-free core so it can be unit-tested in a plain Node
 * environment; the provider handler in MarkdownEditorProvider.ts does the
 * findFiles/readFile plumbing and caches the per-file index.
 */

import { extractFrontmatter } from "./contentTransform";
import { parseTabularFrontmatter } from "../../shared/frontmatterTable";

/** Anything that can hand over a markdown document's full text. */
export type FmTextSource = { getText(): Promise<string> | string };

/**
 * Extracts the list values per frontmatter key from one markdown document.
 * Files without frontmatter, or whose frontmatter is not tabular (nested maps,
 * comments, block scalars, ...), contribute nothing. Scalar values are
 * intentionally ignored — only list-valued keys feed the suggestion menu.
 */
export function extractListValuesByKey(content: string): Map<string, string[]> {
    const { frontmatter } = extractFrontmatter(content);
    if (!frontmatter) { return new Map(); }
    const entries = parseTabularFrontmatter(frontmatter);
    if (entries === null) { return new Map(); }
    const result = new Map<string, string[]>();
    for (const entry of entries) {
        if (!entry.list) { continue; }
        const values = result.get(entry.key) ?? [];
        for (const item of entry.list.items) {
            if (item.value !== "") { values.push(item.value); }
        }
        result.set(entry.key, values);
    }
    return result;
}

/**
 * Aggregates per-file key→values maps into a deduplicated suggestion list for
 * one key, sorted by frequency (descending) then alphabetically.
 */
export function rankListValues(
    perFile: Iterable<ReadonlyMap<string, string[]>>,
    key: string,
): string[] {
    const counts = new Map<string, number>();
    for (const fileValues of perFile) {
        for (const value of fileValues.get(key) ?? []) {
            counts.set(value, (counts.get(value) ?? 0) + 1);
        }
    }
    return [...counts.entries()]
        .sort(([aValue, aCount], [bValue, bCount]) => bCount - aCount || aValue.localeCompare(bValue))
        .map(([value]) => value);
}

/**
 * Collects the suggestion list for `key` across `files`: reads each file's
 * text, indexes its frontmatter list values, and ranks the results by
 * frequency (descending) then alphabetically.
 */
export async function collectFrontmatterListValues(
    files: FmTextSource[],
    key: string,
): Promise<string[]> {
    const perFile = await Promise.all(
        files.map(async (file) => extractListValuesByKey(await file.getText())),
    );
    return rankListValues(perFile, key);
}
