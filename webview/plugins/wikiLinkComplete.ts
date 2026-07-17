/**
 * Wikilink autocompletion at the caret.
 *
 * Typing `[[partial` opens the workspace-file dropdown with Obsidian-style
 * bare names (the filename without its markdown extension; a bundle's
 * `index.md`/`_index.md` shows its directory name). Picking replaces the
 * construct with a real wiki_link atom. Duplicate bare names disambiguate
 * by showing the root-relative path without extension instead — a path-style
 * target the host's resolveWikiTarget handles the same way.
 *
 * The controller machinery is caretSuggest.ts (shared with the inline link
 * URL autocomplete); no new host protocol — bare names derive webview-side
 * from the existing getLinkTargetSuggestions reply's rootRelative form.
 *
 * Suggestion stops once the partial contains `#` or `|` (heading/alias
 * completion is out of scope), and the whole plugin sits behind the
 * smartLinks setting (baked into window.__i18n at load).
 */
import { PluginKey } from "../pm";
import { $prose } from "@milkdown/utils";
import type { LinkTargetSuggestionItem } from "../../shared/messages";
import {
    createSuggestMenuFromRows,
    requestLinkTargetSuggestions,
} from "../components/pathLink/linkTargetComplete";
import { caretSuggestPlugin, type CaretSuggestSpec } from "./caretSuggest";
import { attrsFromRaw, wikiLinkId } from "./wikiLinks";

/** Unclosed wikilink construct ending at the caret. */
export const PARTIAL_WIKI_REGEX = /\[\[([^\[\]]*)$/;

const MD_EXT_REGEX = /\.(md|markdown)$/i;
const INDEX_FILE_REGEX = /^_?index\.(md|markdown)$/i;

/**
 * The Obsidian-style bare name a workspace file is wiki-linkable as:
 * filename minus the markdown extension; for a bundle index file, the parent
 * directory's name. Null for non-markdown files (not offered).
 */
export function wikiNameOf(rootRelative: string): string | null {
    if (!MD_EXT_REGEX.test(rootRelative)) { return null; }
    const segs = rootRelative.replace(/^\//, "").split("/");
    const base = segs[segs.length - 1];
    if (INDEX_FILE_REGEX.test(base)) {
        return segs.length >= 2 ? segs[segs.length - 2] : null;
    }
    return base.replace(MD_EXT_REGEX, "");
}

/**
 * Ranked wiki suggestion rows for `query`: unique bare names, duplicates
 * shown as their root-relative path without extension (still a resolvable
 * wiki target). Case-insensitive substring match; prefix matches first,
 * then shorter names, then alpha.
 */
export function rankWikiNames(
    items: readonly LinkTargetSuggestionItem[],
    query: string,
    limit = 20,
): Array<{ text: string; title: string }> {
    const q = query.trim().toLowerCase();
    const byName = new Map<string, string[]>(); // bare name → rootRelative[]
    for (const item of items) {
        const name = wikiNameOf(item.rootRelative);
        if (name === null) { continue; }
        const list = byName.get(name) ?? [];
        list.push(item.rootRelative);
        byName.set(name, list);
    }

    const rows: Array<{ text: string; title: string; sortKey: string }> = [];
    for (const [name, paths] of byName) {
        if (q && !name.toLowerCase().includes(q)) { continue; }
        if (paths.length === 1) {
            rows.push({ text: name, title: paths[0], sortKey: name.toLowerCase() });
        } else {
            for (const p of paths) {
                const pathForm = p.replace(/^\//, "").replace(MD_EXT_REGEX, "");
                rows.push({ text: pathForm, title: p, sortKey: name.toLowerCase() });
            }
        }
    }
    rows.sort((a, b) => {
        const aPre = q !== "" && a.sortKey.startsWith(q);
        const bPre = q !== "" && b.sortKey.startsWith(q);
        if (aPre !== bPre) { return aPre ? -1 : 1; }
        if (a.text.length !== b.text.length) { return a.text.length - b.text.length; }
        return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
    });
    return rows.slice(0, limit).map(({ text, title }) => ({ text, title }));
}

const wikiLinkCompleteKey = new PluginKey("MD_WIKI_LINK_COMPLETE");

/** smartLinks gates the whole feature; read per call (baked at panel load). */
function smartLinksEnabled(): boolean {
    return window.__i18n?.smartLinks ?? true;
}

const wikiCompleteSpec: CaretSuggestSpec = {
    match(textBefore) {
        if (!smartLinksEnabled()) { return null; }
        const m = PARTIAL_WIKI_REGEX.exec(textBefore);
        if (!m) { return null; }
        const query = m[1] ?? "";
        // Heading/alias completion is out of scope — stop suggesting the
        // moment the user starts one.
        if (query.includes("#") || query.includes("|")) { return null; }
        return { length: m[0].length, query };
    },

    // A bare `[[` suggests immediately (the empty query ranks every file,
    // markdown first) — waiting for a first character made the feature look
    // broken. Only a same-page `[[#` opts out.
    shouldSuggest: (query) => !query.trim().startsWith("#"),

    fetch: (query, cb) => requestLinkTargetSuggestions(query, cb),

    buildMenu(items, match, anchor, onPick) {
        const rows = rankWikiNames(items as LinkTargetSuggestionItem[], match.query);
        return createSuggestMenuFromRows(rows, anchor, onPick);
    },

    pick(view, match, picked) {
        const { state } = view;
        const type = state.schema.nodes[wikiLinkId];
        if (!type) { return; }
        view.dispatch(
            state.tr
                .replaceRangeWith(match.start, match.caret, type.create(attrsFromRaw(picked)))
                .scrollIntoView(),
        );
    },
};

/** The composable plugin (registered beside linkUrlCompletePlugin). */
export const wikiLinkCompletePlugin = $prose(() =>
    caretSuggestPlugin(wikiLinkCompleteKey, wikiCompleteSpec),
);
