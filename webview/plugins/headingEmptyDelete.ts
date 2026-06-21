import type { EditorView } from "@milkdown/prose/view";
import { Plugin, TextSelection } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";

function deleteEmptyHeading(view: EditorView, direction: -1 | 1): boolean {
    const { state } = view;
    const { selection } = state;
    if (!selection.empty) {
        return false;
    }

    const { $from } = selection;
    const heading = $from.parent;
    if (
        heading.type.name !== "heading" ||
        heading.textContent.length > 0 ||
        $from.parentOffset !== 0
    ) {
        return false;
    }

    const headingPos = $from.before($from.depth);
    const headingEnd = headingPos + heading.nodeSize;
    const paragraph = state.schema.nodes["paragraph"];
    if (!paragraph) {
        return false;
    }

    const tr = state.tr;
    if (state.doc.childCount === 1) {
        const replacement = paragraph.createAndFill();
        if (!replacement) {
            return false;
        }
        tr.replaceWith(headingPos, headingEnd, replacement);
        tr.setSelection(TextSelection.create(tr.doc, headingPos + 1));
    } else {
        tr.delete(headingPos, headingEnd);
        const selectionPos = Math.min(headingPos, tr.doc.content.size);
        tr.setSelection(TextSelection.near(tr.doc.resolve(selectionPos), direction));
    }

    view.dispatch(tr.scrollIntoView());
    return true;
}

// 空标题 Backspace/Delete：避免默认 H3 -> H2 -> H1 逐级降级，一次删除空标题块。
export const headingEmptyDeletePlugin = $prose(() =>
    new Plugin({
        view(view) {
            const onKeyDown = (event: KeyboardEvent) => {
                if (
                    event.isComposing ||
                    event.defaultPrevented ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.altKey
                ) {
                    return;
                }

                const direction = event.key === "Backspace" ? -1 : event.key === "Delete" ? 1 : 0;
                if (direction === 0) {
                    return;
                }

                if (deleteEmptyHeading(view, direction)) {
                    event.preventDefault();
                    event.stopPropagation();
                }
            };

            view.dom.addEventListener("keydown", onKeyDown, true);
            return {
                destroy() {
                    view.dom.removeEventListener("keydown", onKeyDown, true);
                },
            };
        },
    }),
);
