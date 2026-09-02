import { schemaCtx } from "@milkdown/core";
import type { EditorView, Node, NodeType, ResolvedPos } from "../pm";
import { keymap } from "../pm";
import { NodeSelection, Plugin, Selection } from "../pm";
import { $command, $prose } from "@milkdown/utils";
import { isProgressiveStreaming } from "./docChange";

function isHorizontalRuleNode(node: { type: { name: string } } | null | undefined): boolean {
    return node?.type.name === "hr" ||
        node?.type.name === "horizontal_rule" ||
        node?.type.name === "thematic_break";
}

function findHorizontalRulePosNear(state: { doc: any }, pos: number): number | null {
    for (const candidate of [pos, pos - 1]) {
        if (candidate < 0 || candidate > state.doc.content.size) {
            continue;
        }
        const node = state.doc.nodeAt(candidate);
        if (isHorizontalRuleNode(node)) {
            return candidate;
        }
    }
    return null;
}

function findHorizontalRuleElementNear(view: EditorView, event: MouseEvent): HTMLHRElement | null {
    const direct = (event.target as Element | null)?.closest?.("hr");
    if (direct instanceof HTMLHRElement && view.dom.contains(direct)) {
        return direct;
    }

    const hitSlop = 8;
    const hrs = Array.from(view.dom.querySelectorAll("hr"));
    for (const hr of hrs) {
        const rect = hr.getBoundingClientRect();
        const withinX = event.clientX >= rect.left && event.clientX <= rect.right;
        const withinY = event.clientY >= rect.top - hitSlop && event.clientY <= rect.bottom + hitSlop;
        if (withinX && withinY) {
            return hr;
        }
    }

    return null;
}

// Horizontal rule: supports click-to-select.
export const horizontalRulePlugin = $prose(() =>
    new Plugin({
        props: {
            handleDOMEvents: {
                mousedown: (view, event) => {
                    if (event.button !== 0) {
                        return false;
                    }
                    const hr = findHorizontalRuleElementNear(view, event);
                    if (!hr) {
                        return false;
                    }

                    const rawPos = view.posAtDOM(hr, 0);
                    const hrPos = findHorizontalRulePosNear(view.state, rawPos);
                    if (hrPos === null) {
                        return false;
                    }

                    event.preventDefault();
                    view.dispatch(
                        view.state.tr.setSelection(
                            NodeSelection.create(view.state.doc, hrPos),
                        ),
                    );
                    view.focus();
                    return true;
                },
            },
        },
    }),
);

// When the cursor is at the start of the block below a horizontal rule, a single Backspace deletes the rule directly.
export const horizontalRuleKeymapPlugin = $prose(() =>
    keymap({
        Backspace: (state, dispatch) => {
            const { selection } = state;
            if (selection instanceof NodeSelection && isHorizontalRuleNode(selection.node)) {
                if (dispatch) {
                    dispatch(state.tr.deleteSelection());
                }
                return true;
            }

            if (!selection.empty || selection.$from.parentOffset !== 0) {
                return false;
            }
            const $from = selection.$from;
            const startOfBlock = $from.before($from.depth);
            if (startOfBlock === 0) {
                return false;
            }

            const nodeBefore = state.doc.resolve(startOfBlock).nodeBefore;
            if (!isHorizontalRuleNode(nodeBefore)) {
                return false;
            }

            if (dispatch) {
                dispatch(
                    state.tr.delete(
                        startOfBlock - (nodeBefore?.nodeSize ?? 0),
                        startOfBlock,
                    ),
                );
            }
            return true;
        },
        Delete: (state, dispatch) => {
            const { selection } = state;
            if (!(selection instanceof NodeSelection) || !isHorizontalRuleNode(selection.node)) {
                return false;
            }
            if (dispatch) {
                dispatch(state.tr.deleteSelection());
            }
            return true;
        },
    }),
);

/**
 * Where a rule may legally go, given the caret at `$from` — a range to replace.
 *
 * An empty PARAGRAPH is a placeholder the rule takes over, because leaving it
 * beside the rule writes blank lines that no reparse returns. Anything else
 * keeps its block and the rule lands directly after it. The walk goes outward
 * only as far as the schema forces, which is what keeps the list item the caret
 * sits in alive.
 *
 * Only a paragraph, deliberately — not every empty textblock. A heading and a
 * code block are textblocks too, and both carry state their emptiness hides: an
 * empty `## ` holds its level, and a fence the user has just opened holds its
 * language. Taking those over dropped the attribute silently (recoverably, but
 * with nothing to see). A placeholder is a paragraph; a fence awaiting its first
 * line is not.
 */
function horizontalRulePlacement(
    $from: ResolvedPos,
    hr: NodeType,
): { from: number; to: number } | null {
    if ($from.depth > 0 && $from.parent.type.name === "paragraph" && $from.parent.content.size === 0) {
        const index = $from.index($from.depth - 1);
        if ($from.node($from.depth - 1).canReplaceWith(index, index + 1, hr)) {
            return { from: $from.before($from.depth), to: $from.after($from.depth) };
        }
    }
    for (let d = $from.depth - 1; d >= 0; d--) {
        const index = $from.indexAfter(d);
        if ($from.node(d).canReplaceWith(index, index, hr)) {
            const at = $from.after(d + 1);
            return { from: at, to: at };
        }
    }
    return null;
}

/**
 * Insert a horizontal rule at the caret.
 *
 * Milkdown's own `insertHrCommand` is not used, because a `list_item` is
 * `paragraph block*` — a rule can never be an item's FIRST child. Building the
 * rule with `tr.replaceSelectionWith(hr)` therefore makes ProseMirror hoist the
 * insertion out of the item and delete it, and in an emptied TOP-LEVEL item the
 * command's follow-up `tr.insert(from, paragraph)` resolves a position the
 * hoist has already invalidated and throws `RangeError` (MAR-304). That extra
 * paragraph is also inserted BEFORE the rule rather than after it, where it
 * serializes to blank lines that vanish on the next parse.
 *
 * Asking the schema where the rule fits avoids all three.
 *
 * The command always leaves the caret in a textblock AFTER the rule, making one
 * if the document has none. Leaving it unset is not neutral: the old caret sat
 * in the block the rule just replaced, so ProseMirror maps it onto a
 * `NodeSelection` on the rule itself and the next keystroke replaces the rule
 * with that character. That is the ordinary `/divider` path, because
 * `slashMenu.apply` deletes the typed `/divider` before running the command —
 * so the block is always empty and the rule always ends what follows it.
 * `trailingHrParagraphPlugin` cannot cover this: it fires only when the rule is
 * `doc.lastChild` (never inside a list item, quote or callout), and it runs in
 * `appendTransaction`, which is after this command has already had to choose a
 * selection.
 */
export const insertHorizontalRuleCommand = $command(
    "InsertHorizontalRule",
    (ctx) => () => (state, dispatch) => {
        const schema = ctx.get(schemaCtx);
        const hr = schema.nodes["hr"];
        if (!hr) return false;
        const placement = horizontalRulePlacement(state.selection.$from, hr);
        if (!placement) return false;
        if (dispatch) {
            const tr = state.tr.replaceWith(placement.from, placement.to, hr.create());
            // `hr` is a leaf, so the position just past it is where the caret
            // looks for somewhere to land — forward first, then BACK into the
            // block above. Landing above the rule is a little surprising; being
            // left ON the rule destroys it, and adding a paragraph to land in
            // would write a blank line no reparse returns, which is the defect
            // this command exists to have stopped writing.
            const after = placement.from + 1;
            const landing =
                Selection.findFrom(tr.doc.resolve(after), 1, true) ??
                Selection.findFrom(tr.doc.resolve(after), -1, true);
            if (landing) {
                tr.setSelection(landing);
            } else {
                // The rule is now the document's only content, so there is no
                // textblock either side to hold a caret. This is the one case
                // that has to grow one — and it is exactly the case
                // `trailingHrParagraphPlugin` already appends for, so the
                // trailing blank it costs is a divergence the editor has always
                // accepted rather than a new one.
                const paragraph = schema.nodes["paragraph"];
                const $at = tr.doc.resolve(after);
                const index = $at.index();
                if (paragraph && $at.parent.canReplaceWith(index, index, paragraph)) {
                    tr.insert(after, paragraph.createAndFill() ?? paragraph.create());
                    const grown = Selection.findFrom(tr.doc.resolve(after), 1, true);
                    if (grown) tr.setSelection(grown);
                }
            }
            dispatch(tr.scrollIntoView());
        }
        return true;
    },
);

// When a horizontal rule is the last node in the document, automatically append an empty paragraph after it:
// otherwise clicking below the rule only selects the rule itself, leaving no place for the cursor to type.
export const trailingHrParagraphPlugin = $prose((ctx) => {
    const schema = ctx.get(schemaCtx);
    const paragraph = schema.nodes["paragraph"];
    return new Plugin({
        appendTransaction(_trs, _oldState, newState) {
            if (!paragraph) return null;
            // While a progressive open streams, the document's end is a
            // chunk's end and not the document's: a paragraph put there
            // would sit in the middle of the document once the next chunk
            // landed. A whole open adds nothing after a trailing rule until
            // its first transaction, and the streamed one gets its turn on
            // the transactions that finish the stream.
            if (isProgressiveStreaming()) return null;
            const { doc } = newState;
            if (!isHorizontalRuleNode(doc.lastChild)) return null;
            const empty = paragraph.createAndFill();
            if (!empty) return null;
            return newState.tr
                .insert(doc.content.size, empty)
                .setMeta("addToHistory", false);
        },
    });
});
