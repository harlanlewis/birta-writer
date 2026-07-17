/**
 * Inline-math reveal-source editing (MAR-74).
 *
 * `math_inline` stores its LaTeX source as text content (plugins/math.ts), so
 * the caret can sit INSIDE the formula and edit it per-character, like inline
 * code. This plugin supplies the interaction layer around that:
 *
 *  - A node decoration adds `.math-inline--editing` to the formula the caret is
 *    in; the NodeView's CSS then shows the raw source and hides the KaTeX
 *    render. Reveal is PURE selection state — no transaction, so navigating
 *    through a document can never dirty it or pollute undo history.
 *  - Boundary keys enter the node logically. The source span is `display:none`
 *    while not editing, and native browser caret movement skips hidden text —
 *    so ArrowLeft/ArrowRight into the node, and Backspace/Delete against its
 *    edge, place the caret inside (revealing it) instead of skipping/blindly
 *    deleting invisible source.
 *  - Clicking the rendered formula puts the caret inside at the end.
 *  - Typing `$` at the end of the source exits the node (the "close the
 *    delimiter" instinct); elsewhere inside it is swallowed — a literal `$`
 *    inside `$...$` would break the delimiter syntax on save.
 *  - A formula whose source has been emptied is deleted once the caret leaves
 *    it (matching the old popover's empty-commit behavior).
 */
import type { Node as PMNode } from "../pm";
import type { EditorState } from "../pm";
import { Plugin, PluginKey, TextSelection } from "../pm";
import { Decoration, DecorationSet } from "../pm";
import type { EditorView } from "../pm";
import { $prose } from "@milkdown/utils";
import { mathInlineId } from "./math";

/** The math node the caret sits inside, as {pos, end}, or null. */
export function mathAroundSelection(state: EditorState): { pos: number; end: number } | null {
    const { $from, $to } = state.selection;
    if ($from.parent.type.name !== mathInlineId) {
        return null;
    }
    // A range selection must stay within the same formula.
    if (!$to.sameParent($from)) {
        return null;
    }
    const pos = $from.before();
    return { pos, end: pos + $from.parent.nodeSize };
}

/** Reveal-decoration for the formula the caret is inside (pure derivation). */
export function revealDecorations(state: EditorState): DecorationSet {
    const range = mathAroundSelection(state);
    if (!range) {
        return DecorationSet.empty;
    }
    return DecorationSet.create(state.doc, [
        Decoration.node(range.pos, range.end, { class: "math-inline--editing" }),
    ]);
}

const key = new PluginKey("MDW_MATH_INLINE_EDIT");

export const mathInlineEditPlugin = $prose(
    () =>
        new Plugin({
            key,
            props: {
                decorations: revealDecorations,

                handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
                    if (event.metaKey || event.ctrlKey || event.altKey) {
                        return false;
                    }
                    const { state } = view;
                    const { selection } = state;
                    const isMath = (n: { type: { name: string } } | null | undefined): boolean =>
                        n?.type.name === mathInlineId;

                    // Shift+Arrow: native selection extension treats the hidden
                    // source as one opaque unit (the render is one ce=false box),
                    // so it jumps coarsely past the formula. Step the selection
                    // HEAD logically, one position at a time, when the next step
                    // crosses or moves inside a formula; defer to native
                    // everywhere else.
                    if (event.shiftKey) {
                        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                            return false;
                        }
                        const $head = selection.$head;
                        const dir = event.key === "ArrowRight" ? 1 : -1;
                        const headInMath = $head.parent.type.name === mathInlineId;
                        const crossing =
                            dir === 1 ? isMath($head.nodeAfter) : isMath($head.nodeBefore);
                        const next = $head.pos + dir;
                        if ((!headInMath && !crossing) || next < 0 || next > state.doc.content.size) {
                            return false;
                        }
                        view.dispatch(
                            state.tr.setSelection(
                                TextSelection.create(state.doc, selection.anchor, next),
                            ),
                        );
                        return true;
                    }

                    if (!selection.empty) {
                        return false;
                    }
                    const { $from } = selection;
                    const insideMath = $from.parent.type.name === mathInlineId;

                    const caretTo = (pos: number): boolean => {
                        view.dispatch(
                            state.tr.setSelection(TextSelection.create(state.doc, pos)),
                        );
                        return true;
                    };

                    if (!insideMath) {
                        // Entry: the hidden source can't be reached by native
                        // caret movement, so cross the boundary logically.
                        if (event.key === "ArrowLeft" && isMath($from.nodeBefore)) {
                            return caretTo($from.pos - 1); // inside, at the end
                        }
                        if (event.key === "ArrowRight" && isMath($from.nodeAfter)) {
                            return caretTo($from.pos + 1); // inside, at the start
                        }
                        // Backspace/Delete against the edge reveals instead of
                        // eating invisible source characters.
                        if (event.key === "Backspace" && isMath($from.nodeBefore)) {
                            return caretTo($from.pos - 1);
                        }
                        if (event.key === "Delete" && isMath($from.nodeAfter)) {
                            return caretTo($from.pos + 1);
                        }
                        return false;
                    }

                    // Exit: leave across the node edge back into the parent text.
                    const atStart = $from.parentOffset === 0;
                    const atEnd = $from.parentOffset === $from.parent.content.size;
                    if (event.key === "ArrowLeft" && atStart) {
                        return caretTo($from.before());
                    }
                    if (event.key === "ArrowRight" && atEnd) {
                        return caretTo($from.after());
                    }
                    return false;
                },

                handleTextInput(view: EditorView, _from: number, _to: number, text: string): boolean {
                    if (text !== "$") {
                        return false;
                    }
                    const { state } = view;
                    const { $from } = state.selection;
                    if ($from.parent.type.name !== mathInlineId) {
                        return false;
                    }
                    // `$` at the very end closes the formula: caret moves out.
                    if (
                        state.selection.empty &&
                        $from.parentOffset === $from.parent.content.size
                    ) {
                        view.dispatch(
                            state.tr.setSelection(TextSelection.create(state.doc, $from.after())),
                        );
                    }
                    // Swallowed everywhere inside: a literal `$` would break the
                    // `$...$` delimiters on serialize.
                    return true;
                },

                handleClickOn(
                    view: EditorView,
                    _pos: number,
                    node: PMNode,
                    nodePos: number,
                    _event: MouseEvent,
                    direct: boolean,
                ): boolean {
                    if (!direct || node.type.name !== mathInlineId) {
                        return false;
                    }
                    // Clicking the rendered formula: caret inside at the end
                    // (the render is not text, so there's no finer position).
                    view.dispatch(
                        view.state.tr.setSelection(
                            TextSelection.create(view.state.doc, nodePos + 1 + node.content.size),
                        ),
                    );
                    view.focus();
                    return true;
                },
            },

            // Delete a formula whose source was emptied, once the caret leaves it
            // (kept while inside so the user can retype). O(1): only the node the
            // PREVIOUS selection was in can have just been left.
            appendTransaction(trs, oldState, newState) {
                const prev = mathAroundSelection(oldState);
                if (!prev) {
                    return null;
                }
                let pos = prev.pos;
                for (const tr of trs) {
                    pos = tr.mapping.map(pos);
                }
                const node = newState.doc.nodeAt(pos);
                if (node?.type.name !== mathInlineId || node.content.size > 0) {
                    return null;
                }
                const now = mathAroundSelection(newState);
                if (now && now.pos === pos) {
                    return null; // still inside — leave it for retyping
                }
                return newState.tr.delete(pos, pos + node.nodeSize);
            },
        }),
);
