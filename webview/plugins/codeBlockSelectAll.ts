import { NodeSelection, Plugin, Selection, TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { $prose } from "@milkdown/utils";

function findCodeBlockDepth(selection: Selection): number | null {
    const { $from } = selection;
    for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type.name === "code_block") {
            return depth;
        }
    }
    return null;
}

function selectionIsInCodeBlock(selection: Selection): boolean {
    return findCodeBlockDepth(selection) !== null;
}

function selectCurrentCodeBlock(view: EditorView): boolean {
    if (
        view.state.selection instanceof NodeSelection &&
        view.state.selection.node.type.name === "code_block"
    ) {
        const from = view.state.selection.from + 1;
        const to = view.state.selection.to - 1;
        view.dispatch(
            view.state.tr
                .setSelection(TextSelection.create(view.state.doc, from, to))
                .scrollIntoView(),
        );
        return true;
    }

    const depth = findCodeBlockDepth(view.state.selection);
    if (depth === null) {
        return false;
    }

    const { $from } = view.state.selection;
    const from = $from.start(depth);
    const to = $from.end(depth);
    view.dispatch(
        view.state.tr
            .setSelection(TextSelection.create(view.state.doc, from, to))
            .scrollIntoView(),
    );
    return true;
}

function isModA(event: KeyboardEvent): boolean {
    return (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "a";
}

export const codeBlockSelectAllPlugin = $prose(() =>
    new Plugin({
        props: {
            handleKeyDown(view, event) {
                if (!isModA(event) || !selectionIsInCodeBlock(view.state.selection)) {
                    return false;
                }
                return selectCurrentCodeBlock(view);
            },
        },
        view(view) {
            const onKeyDown = (event: KeyboardEvent): void => {
                if (!isModA(event) || !selectionIsInCodeBlock(view.state.selection)) {
                    return;
                }

                const target = event.target as Node | null;
                if (target && !view.dom.contains(target) && !view.hasFocus()) {
                    return;
                }

                if (selectCurrentCodeBlock(view)) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                }
            };

            document.addEventListener("keydown", onKeyDown, true);
            return {
                destroy() {
                    document.removeEventListener("keydown", onKeyDown, true);
                },
            };
        },
    }),
);
