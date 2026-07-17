/**
 * Inline math NodeView — KaTeX render + in-place source editing (MAR-74).
 *
 * The `math_inline` node holds its LaTeX source as text CONTENT (plugins/
 * math.ts). This view shows two faces of that content:
 *
 *   - `.math-inline-render` — the KaTeX-rendered formula (contenteditable=false,
 *     lazy KaTeX), visible while the caret is elsewhere.
 *   - `.math-inline-src` — the contentDOM: the raw source ProseMirror manages,
 *     revealed (with `$` delimiter chrome from CSS) while the caret is inside.
 *
 * Which face shows is driven by `.math-inline--editing`, a node DECORATION from
 * mathInlineEdit.ts — selection state only, never a document change. The old
 * click popover is gone: clicking the render places the caret in the source.
 */
import "./math.css";
import type { Node as PMNode } from "@/pm";
import { renderKatexInto } from "@/utils/katexLoader";
import { t } from "@/i18n";

interface MathInlineView {
    dom: HTMLElement;
    contentDOM: HTMLElement;
    update: (node: PMNode) => boolean;
    selectNode: () => void;
    deselectNode: () => void;
    ignoreMutation: (mutation: MutationRecord | { type: "selection"; target: Node }) => boolean;
}

/** Render `value` into the render span; empty math shows a dimmed placeholder. */
function paint(dom: HTMLElement, render: HTMLElement, value: string): void {
    if (!value.trim()) {
        render.textContent = "";
        dom.classList.add("math-inline--empty");
        dom.title = t("Empty formula — type its LaTeX");
        return;
    }
    dom.classList.remove("math-inline--empty");
    dom.title = "";
    // Async KaTeX render; failures are painted red by KaTeX itself.
    void renderKatexInto(render, value, false).catch(() => {
        render.textContent = value;
    });
}

export function createMathInlineView(initialNode: PMNode): MathInlineView {
    let currentValue = initialNode.textContent;

    const dom = document.createElement("span");
    dom.className = "math-inline";
    dom.dataset["type"] = "math_inline";

    const render = document.createElement("span");
    render.className = "math-inline-render";
    render.contentEditable = "false";

    const src = document.createElement("span");
    src.className = "math-inline-src";
    src.spellcheck = false;

    dom.append(render, src);
    paint(dom, render, currentValue);

    return {
        dom,
        contentDOM: src,
        update(node: PMNode): boolean {
            if (node.type !== initialNode.type) {
                return false;
            }
            const next = node.textContent;
            if (next !== currentValue) {
                currentValue = next;
                paint(dom, render, next);
            }
            return true;
        },
        selectNode(): void {
            dom.classList.add("math-inline--selected");
        },
        deselectNode(): void {
            dom.classList.remove("math-inline--selected");
        },
        // ProseMirror must see mutations in the source span (its contentDOM);
        // KaTeX's own DOM churn in the render span is ours to ignore.
        ignoreMutation(mutation): boolean {
            if (mutation.type === "selection") {
                return false;
            }
            const target = mutation.target;
            return !(src === target || src.contains(target));
        },
    };
}
