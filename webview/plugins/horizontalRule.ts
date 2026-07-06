import { schemaCtx } from "@milkdown/core";
import type { EditorView } from "@milkdown/prose/view";
import { keymap } from "@milkdown/prose/keymap";
import { NodeSelection, Plugin } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";

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

// When a horizontal rule is the last node in the document, automatically append an empty paragraph after it:
// otherwise clicking below the rule only selects the rule itself, leaving no place for the cursor to type.
export const trailingHrParagraphPlugin = $prose((ctx) => {
    const schema = ctx.get(schemaCtx);
    const paragraph = schema.nodes["paragraph"];
    return new Plugin({
        appendTransaction(_trs, _oldState, newState) {
            if (!paragraph) return null;
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
