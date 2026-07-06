/**
 * Inline math NodeView — renders `$...$` with KaTeX and edits it in place.
 *
 * The `math_inline` node is an inline atom carrying a single `value` attr (the
 * LaTeX source). This NodeView paints the rendered formula (KaTeX is loaded
 * lazily) and, on click, opens a small popover with a monospace input bound to
 * `value`. Enter or blur commits via `setNodeMarkup` (committing an empty value
 * deletes the node); Escape cancels. The popover mirrors the linkPopup pattern.
 */
import "./math.css";
import type { Node as PMNode } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import { renderKatexInto } from "@/utils/katexLoader";
import { attachInputUndo } from "@/utils/inputUndo";
import { t } from "@/i18n";

interface MathInlineView {
    dom: HTMLElement;
    update: (node: PMNode) => boolean;
    selectNode?: () => void;
    deselectNode?: () => void;
    stopEvent: (event: Event) => boolean;
    ignoreMutation: () => boolean;
    destroy: () => void;
}

/** Render `value` into `dom`; empty math shows a dimmed placeholder. */
function paint(dom: HTMLElement, value: string): void {
    if (!value.trim()) {
        dom.textContent = "";
        dom.classList.add("math-inline--empty");
        dom.title = t("Empty formula — click to edit");
        return;
    }
    dom.classList.remove("math-inline--empty");
    dom.title = "";
    // Async KaTeX render; failures are painted red by KaTeX itself.
    void renderKatexInto(dom, value, false).catch(() => {
        dom.textContent = value;
    });
}

export function createMathInlineView(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
): MathInlineView {
    let currentNode = node;

    const dom = document.createElement("span");
    dom.className = "math-inline";
    dom.dataset["type"] = "math_inline";
    dom.contentEditable = "false";
    paint(dom, currentNode.attrs["value"] as string);

    let popover: HTMLElement | null = null;
    let detachUndo: (() => void) | null = null;
    let outsideHandler: ((e: MouseEvent) => void) | null = null;

    function closePopover(): void {
        if (detachUndo) {
            detachUndo();
            detachUndo = null;
        }
        if (outsideHandler) {
            document.removeEventListener("mousedown", outsideHandler, true);
            outsideHandler = null;
        }
        if (popover && document.body.contains(popover)) {
            document.body.removeChild(popover);
        }
        popover = null;
    }

    /** Write the edited value back to the document (empty ⇒ delete the node). */
    function commit(nextValue: string): void {
        const pos = getPos();
        closePopover();
        if (pos === undefined) return;
        const trimmed = nextValue;
        const tr = view.state.tr;
        if (!trimmed.trim()) {
            tr.delete(pos, pos + currentNode.nodeSize);
        } else if (trimmed !== (currentNode.attrs["value"] as string)) {
            tr.setNodeMarkup(pos, undefined, {
                ...currentNode.attrs,
                value: trimmed,
            });
        } else {
            view.focus();
            return;
        }
        view.dispatch(tr);
        view.focus();
    }

    function openPopover(): void {
        if (popover) return;
        const pop = document.createElement("div");
        pop.className = "math-popover";
        pop.addEventListener("mousedown", (e) => e.stopPropagation());

        const input = document.createElement("input");
        input.type = "text";
        input.className = "math-popover-input";
        input.spellcheck = false;
        input.autocomplete = "off";
        input.placeholder = t("LaTeX formula");
        input.value = currentNode.attrs["value"] as string;

        pop.appendChild(input);
        document.body.appendChild(pop);
        popover = pop;

        // VS Code's Electron layer swallows Cmd/Ctrl+Z before native inputs
        // see it — restore local undo/redo for this field.
        detachUndo = attachInputUndo(input);

        // Position below the formula, clamped to the viewport.
        const rect = dom.getBoundingClientRect();
        const popW = Math.max(rect.width, 220);
        pop.style.width = `${popW}px`;
        let left = rect.left;
        if (left + popW > window.innerWidth - 8) {
            left = Math.max(8, window.innerWidth - 8 - popW);
        }
        pop.style.left = `${left}px`;
        pop.style.top = `${rect.bottom + 4}px`;

        input.focus();
        input.select();

        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                commit(input.value);
            } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closePopover();
                view.focus();
            }
        });
        // Blur commits, unless the blur is because the popover is being torn
        // down already (closePopover removes the node, firing blur).
        input.addEventListener("blur", () => {
            if (popover) commit(input.value);
        });

        outsideHandler = (e: MouseEvent) => {
            if (popover && !popover.contains(e.target as Node) && e.target !== dom) {
                commit(input.value);
            }
        };
        setTimeout(() => {
            if (outsideHandler) {
                document.addEventListener("mousedown", outsideHandler, true);
            }
        }, 0);
    }

    dom.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPopover();
    });

    return {
        dom,
        update(updatedNode: PMNode): boolean {
            if (updatedNode.type !== currentNode.type) return false;
            const prev = currentNode.attrs["value"] as string;
            currentNode = updatedNode;
            const next = updatedNode.attrs["value"] as string;
            if (next !== prev) paint(dom, next);
            return true;
        },
        selectNode(): void {
            dom.classList.add("math-inline--selected");
        },
        deselectNode(): void {
            dom.classList.remove("math-inline--selected");
        },
        // Keep ProseMirror out of the popover's input and our own click.
        stopEvent(event: Event): boolean {
            const target = event.target as Node | null;
            if (popover && target && popover.contains(target)) return true;
            return event.type === "mousedown";
        },
        ignoreMutation(): boolean {
            return true;
        },
        destroy(): void {
            closePopover();
        },
    };
}
