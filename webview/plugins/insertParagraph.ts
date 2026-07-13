/**
 * plugins/insertParagraph.ts — Insert Paragraph After/Before (VS Code's
 * "Insert Line Below/Above", block-flavored, MAR-99).
 *
 * Mod-Enter / Mod-Shift-Enter are typing-level chords: they must be handled
 * synchronously in a ProseMirror keymap (an extension-host round-trip would
 * let contenteditable's default Enter handling race the command). Claimed by
 * the key-leak guard (webview/keyboardShortcuts.ts); the palette entries
 * (`birta.editor.insertParagraphAfter` / `insertParagraphBefore`)
 * stay rebindable to ADDITIONAL chords.
 *
 * Semantics:
 *   - Insert an EMPTY paragraph as a SIBLING of the caret's own block —
 *     never split the block, wherever the caret sits inside it — and move
 *     the caret into the new paragraph. One transaction, one undo step.
 *   - Container depth: inside a list item / callout / blockquote the new
 *     paragraph lands INSIDE the container, next to the caret's own
 *     textblock (a sibling within the innermost parent), not outside at top
 *     level. From a heading a PLAIN paragraph is inserted — attrs and marks
 *     are never inherited (stored marks are cleared too).
 *   - A block-range selection (plugins/blockRange.ts) inserts after its
 *     last / before its first block, at top level.
 *
 * CONSTRAINT: the commonmark preset already binds Mod-Enter to exit code
 * blocks and tables. This plugin is registered BEFORE the presets
 * (editor.ts), so its bindings win — insertParagraphAfter MUST return false
 * inside a code block or table so the preset's exit behavior keeps working.
 * The preset binds nothing on Mod-Shift-Enter there, so insertParagraphBefore
 * instead inserts an empty paragraph right before the enclosing code block /
 * table at its own depth (rather than being a swallowed dead key).
 */
import { keymap } from "@milkdown/prose/keymap";
import {
    NodeSelection,
    TextSelection,
    type Command,
    type EditorState,
} from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";
import { BlockRangeSelection } from "./blockRange";

/**
 * True when either selection edge sits inside a code block or table — the
 * preset's own Mod-Enter (exit code / exit table) owns the "after" direction
 * there (schema names per codeBlockSelectAll.ts / blockKeys.ts).
 */
function inPresetExitTerritory(state: EditorState): boolean {
    for (const $pos of [state.selection.$from, state.selection.$to]) {
        for (let depth = $pos.depth; depth > 0; depth--) {
            const name = $pos.node(depth).type.name;
            if (name === "code_block" || name === "table") {
                return true;
            }
        }
    }
    return false;
}

/**
 * The document position where the new sibling paragraph goes.
 *
 *   - Block range: its boundaries are already whole top-level blocks —
 *     after the last (`to`) / before the first (`from`).
 *   - Block NodeSelection (HR, selected table…): directly around the node.
 *   - Caret / text selection: the boundary of the edge's own textblock
 *     (`$to.after` / `$from.before` at the textblock's depth), which keeps
 *     the insertion INSIDE any list item / callout / blockquote container.
 */
function insertionPos(state: EditorState, side: -1 | 1): number {
    const sel = state.selection;
    if (
        sel instanceof BlockRangeSelection ||
        (sel instanceof NodeSelection && sel.node.isBlock)
    ) {
        return side === 1 ? sel.to : sel.from;
    }
    const $edge = side === 1 ? sel.$to : sel.$from;
    if ($edge.depth === 0) {
        return $edge.pos; // already at a block boundary (AllSelection edge)
    }
    return side === 1 ? $edge.after($edge.depth) : $edge.before($edge.depth);
}

/** Shared body: insert an empty paragraph on `side`, move the caret in. */
function insertSiblingParagraph(side: -1 | 1): Command {
    return (state, dispatch) => {
        const paragraph = state.schema.nodes["paragraph"];
        if (!paragraph) {
            return false;
        }
        // Inside a code block / table the preset's Mod-Enter (exit) owns the
        // "after" direction, so insertParagraphAfter falls through. But the
        // preset binds nothing on Mod-Shift-Enter there, so without this the
        // "before" chord would be a dead key (swallowed, no-op). Handle it by
        // inserting the paragraph immediately before the enclosing code
        // block / table AT ITS OWN DEPTH — a code block nested in a
        // blockquote / list item / callout gets the paragraph INSIDE that
        // container, consistent with the container rule above.
        let pos: number;
        if (inPresetExitTerritory(state)) {
            if (side === 1) {
                return false;
            }
            const $from = state.selection.$from;
            let before: number | null = null;
            for (let depth = $from.depth; depth > 0; depth--) {
                const name = $from.node(depth).type.name;
                if (name === "code_block" || name === "table") {
                    before = $from.before(depth);
                    break;
                }
            }
            // $from can sit outside the code/table when only the $to edge of
            // the selection is inside one: keep the old top-level placement.
            pos = before ?? ($from.depth === 0 ? $from.pos : $from.before(1));
        } else {
            pos = insertionPos(state, side);
        }
        const $pos = state.doc.resolve(pos);
        const index = $pos.index();
        if (!$pos.parent.canReplaceWith(index, index, paragraph)) {
            return false;
        }
        if (dispatch) {
            const tr = state.tr.insert(pos, paragraph.create());
            tr.setSelection(TextSelection.create(tr.doc, pos + 1));
            tr.setStoredMarks([]); // never inherit marks from the source block
            tr.scrollIntoView();
            dispatch(tr);
        }
        return true;
    };
}

/** Insert an empty paragraph after the current block and move the caret in. */
export const insertParagraphAfter: Command = insertSiblingParagraph(1);

/** Insert an empty paragraph before the current block and move the caret in. */
export const insertParagraphBefore: Command = insertSiblingParagraph(-1);

export const insertParagraphKeymapPlugin = $prose(() =>
    keymap({
        "Mod-Enter": insertParagraphAfter,
        "Mod-Shift-Enter": insertParagraphBefore,
    }),
);
