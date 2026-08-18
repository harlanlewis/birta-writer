/**
 * The empty-line affordance: an empty top-level paragraph holding the caret
 * names the slash menu, the way Notion's empty block does.
 *
 * Two decorations do it: a node decoration marking the paragraph (the
 * positioning context and the CSS hook), and a widget holding the sentence,
 * whose key is a real `<code>` element so it wears the document's own inline
 * code chip. A pseudo-element cannot, because `content` is one string with no
 * way to style a span inside it.
 *
 * Neither touches the document. A decoration is view-only, so nothing here can
 * serialize, and the paragraph stays empty — which is what invisibleParagraph.ts
 * requires of it. The widget is `contenteditable=false` and out of flow, so the
 * caret sits exactly where it would with no hint at all.
 *
 * SCOPE is deliberately narrow. Only a paragraph directly under the doc root,
 * with no content at all, holding a collapsed selection. A list item, table
 * cell, or blockquote already carries its own structural cue at that spot, and
 * a hint beside every empty one of them is noise rather than help. One
 * character of content, `/` included, removes the decoration: the discovery
 * this exists for is over the moment the user acts on it.
 *
 * Whether the editor has FOCUS is left to CSS (`.ProseMirror:focus`), because
 * focus changes are not transactions and a plugin cannot recompute on them
 * without a view listener that dispatches one.
 */
import { Plugin, PluginKey } from "../pm";
import { Decoration, DecorationSet } from "../pm";
import type { EditorState } from "../pm";
import { $prose } from "@milkdown/utils";
import { t } from "../i18n";

const emptyLineHintKey = new PluginKey<DecorationSet>("MD_EMPTY_LINE_HINT");

/**
 * The hint's DOM. `{0}` is the key the sentence is about, so a translation can
 * put it anywhere in the sentence rather than only where English does (the
 * calcLedger precedent). Exported for tests.
 */
export function emptyLineHintDom(): HTMLElement {
    const host = document.createElement("span");
    host.className = "md-empty-hint-text";
    host.contentEditable = "false";
    const [before, after = ""] = t("press {0} to show commands").split("{0}");
    const key = document.createElement("code");
    key.textContent = "/";
    host.append(before ?? "", key, after);
    return host;
}

/** The decoration for `state`, or the empty set. Exported for tests. */
export function emptyLineHintDecorations(state: EditorState): DecorationSet {
    const { selection } = state;
    if (!selection.empty) {
        return DecorationSet.empty;
    }
    const $pos = selection.$from;
    // depth 1 is a block whose parent is the doc; anything deeper is nested.
    if ($pos.depth !== 1) {
        return DecorationSet.empty;
    }
    const node = $pos.parent;
    if (node.type.name !== "paragraph" || node.content.size !== 0) {
        return DecorationSet.empty;
    }
    const from = $pos.before();
    return DecorationSet.create(state.doc, [
        Decoration.node(from, from + node.nodeSize, { class: "md-empty-hint" }),
        // `side` MUST be negative, so the widget sorts before the caret's own
        // position rather than after it. This paragraph is empty, so widgets
        // are the only things in it: with a positive side, WebKit cannot hold
        // an insertion point in front of an uneditable widget that has no
        // content before it, and silently re-anchors the caret to the end of
        // the previous block, so the next character typed lands on the
        // previous line. One such widget is enough (verified by removing the
        // block-handle gutter, which sits at this same position and already
        // uses `side: -1`, and watching a positive side still break it).
        // Chromium tolerates the arrangement, which is why this only ever
        // showed up in Jot. Pinned by e2e/enterCaret, under both engines.
        // `ignoreSelection` keeps a DOM selection landing in the widget from
        // being read back as a document position.
        Decoration.widget(from + 1, emptyLineHintDom, {
            side: -1,
            ignoreSelection: true,
            key: "md-empty-hint",
        }),
    ]);
}

export const emptyLineHintPlugin = $prose(
    () =>
        new Plugin<DecorationSet>({
            key: emptyLineHintKey,
            state: {
                init: (_config, state) => emptyLineHintDecorations(state),
                // Neither the caret nor the doc moved, so the previous answer
                // still holds — and returning the same object keeps
                // ProseMirror from re-diffing decorations every update.
                apply: (tr, previous, _old, next) =>
                    tr.docChanged || tr.selectionSet ? emptyLineHintDecorations(next) : previous,
            },
            props: {
                decorations(state) {
                    return emptyLineHintKey.getState(state) ?? DecorationSet.empty;
                },
            },
        }),
);
