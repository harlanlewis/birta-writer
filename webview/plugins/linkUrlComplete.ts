/**
 * Inline link URL autocompletion at the caret.
 *
 * While the user is typing inside an unclosed `[text](partial` construct in
 * the document body, the same workspace-file dropdown as the link popup /
 * insert-link prompt URL fields opens anchored at the caret. ArrowUp/Down
 * move the highlight, Enter converts the whole construct into a real link
 * with the picked path (the same transaction the ")" input rule in
 * linkInputRule.ts would produce — input rules only run on real typing, so
 * the pick applies it directly), Escape dismisses the menu until the caret
 * leaves the construct.
 *
 * The controller machinery (debounce, stale-reply generations, additive
 * capture-phase keyboard handling, IME safety) lives in caretSuggest.ts,
 * shared with the wikilink autocomplete; this module contributes only the
 * construct grammar and the pick transaction.
 *
 * External targets (http/https/mailto/#anchor) never trigger suggestions —
 * the shared isLocalPathQuery guard from shared/linkTargetSuggest.ts.
 */
import { PluginKey } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";
import type { LinkTargetSuggestionItem } from "../../shared/messages";
import {
    createLinkSuggestMenu,
    requestLinkTargetSuggestions,
} from "../components/pathLink/linkTargetComplete";
import { isLocalPathQuery } from "../../shared/linkTargetSuggest";
import { createLinkifyTr } from "./linkInputRule";
import { caretSuggestPlugin, type CaretSuggestSpec } from "./caretSuggest";

/** Unclosed inline link construct ending at the caret. */
export const PARTIAL_LINK_REGEX = /\[([^\[\]]*)\]\(([^()\s]*)$/;

const linkUrlCompleteKey = new PluginKey("MD_LINK_URL_COMPLETE");

const linkUrlSpec: CaretSuggestSpec = {
    match(textBefore) {
        const m = PARTIAL_LINK_REGEX.exec(textBefore);
        if (!m) { return null; }
        return { length: m[0].length, query: m[2] ?? "", label: m[1] ?? "" };
    },

    shouldSuggest: isLocalPathQuery,

    fetch: (query, cb) => requestLinkTargetSuggestions(query, cb),

    buildMenu(items, match, anchor, onPick) {
        return createLinkSuggestMenu(
            items as LinkTargetSuggestionItem[],
            match.query,
            anchor,
            onPick,
        );
    },

    pick(view, match, picked) {
        const { state } = view;
        // Convert `[text](picked` straight into a real link — exactly what
        // the ")" input rule would do if the path had been typed.
        const tr = createLinkifyTr(state, match.start, match.caret, match.label, picked);
        if (tr) {
            view.dispatch(tr.scrollIntoView());
        } else {
            // No usable label (e.g. `[](partial`): just complete the partial
            // path in place and let the user keep editing the literal text.
            view.dispatch(
                state.tr.insertText(picked, match.caret - match.query.length, match.caret),
            );
        }
    },
};

/**
 * The composable plugin. All work happens in the plugin view: it re-checks
 * the caret context on every transaction and owns the menu DOM/listeners.
 */
export const linkUrlCompletePlugin = $prose(() =>
    caretSuggestPlugin(linkUrlCompleteKey, linkUrlSpec),
);
