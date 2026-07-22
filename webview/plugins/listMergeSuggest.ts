/**
 * Caret advisory for adjacent same-type lists — "Merge with list above".
 *
 * When two sibling lists of the same type touch, the split is the SOURCE's
 * own structure (a `-`→`*` marker change; edit-created adjacency is already
 * auto-joined by listAutoJoinPlugin) — so it is never merged silently. But it
 * is also, very often, an accident the file accumulated: this editor's own
 * serializer used to write exactly that marker alternation whenever an edit
 * left two lists adjacent. This advisory resolves the ambiguity with consent,
 * the inline-calc way: while the caret sits in the FIRST item of the lower
 * list — right where the boundary is — a single quiet row offers the merge.
 * Tab confirms; Enter keeps its newline meaning; Escape dismisses until the
 * caret leaves the list (the shared caretSuggest contract). The merge itself
 * is one undo step through editing/listMerge, same as the block menu rows.
 */
import { PluginKey } from "../pm";
import { $prose } from "@milkdown/utils";
import { createSuggestMenuFromRows } from "../components/pathLink/linkTargetComplete";
import { caretSuggestPlugin, type CaretSuggestSpec } from "./caretSuggest";
import { caretMergeBoundary, mergeListsAt } from "../editing/listMerge";
import { t } from "../i18n";

const listMergeSuggestKey = new PluginKey("MD_LIST_MERGE_SUGGEST");

const listMergeSuggestSpec: CaretSuggestSpec = {
    // Structural trigger: caret in the first item of a list whose previous
    // sibling is a same-type list. The span is the caret itself — the menu
    // anchors there, and leaving the item ends the context (lifting any
    // Escape suppression).
    matchState(state) {
        if (caretMergeBoundary(state) === null) { return null; }
        const caret = state.selection.from;
        return { start: caret, caret, query: "merge", label: "" };
    },

    shouldSuggest: () => true,

    // Synchronous, like calc: the lone "suggestion" is the action itself.
    fetch(_query, cb) {
        cb([true]);
    },

    buildMenu(_items, _match, anchor, onPick) {
        return createSuggestMenuFromRows(
            [
                {
                    text: t("Merge with list above"),
                    title: t(
                        "Two adjacent lists of the same kind — Tab joins them into one",
                    ),
                    hint: "Tab",
                },
            ],
            anchor,
            onPick,
        );
    },

    pick(view, _match, _picked) {
        // Recompute against the CURRENT state — the boundary may have moved
        // since the menu was built (the match span carries no positions worth
        // trusting across edits).
        const boundary = caretMergeBoundary(view.state);
        if (boundary !== null) {
            mergeListsAt(view, boundary);
        }
    },

    // Single advisory row, pre-selected: Tab confirms without an arrow key;
    // Enter deliberately keeps its newline meaning (caretSuggest's
    // autoActivate contract, shared with calc).
    autoActivate: true,

    // A structural trigger can coincide with any text-construct menu (typing
    // `2+3=` in the first item of a split list matches calc AND this) — the
    // construct being typed wins the caret; this offer waits its turn.
    yieldsToOpenMenus: true,
};

/** The list-merge caret advisory (registered beside the other suggestions). */
export const listMergeSuggestPlugin = $prose(() =>
    caretSuggestPlugin(listMergeSuggestKey, listMergeSuggestSpec),
);
