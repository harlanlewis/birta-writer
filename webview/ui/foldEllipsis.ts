/**
 * The collapsed-block ellipsis (MAR-110) — VS Code's folded-region `…`,
 * rendered once per collapsed block at the end of its visible line. One
 * visual component, two mounting paths: a widget decoration for plain blocks
 * (headings), and NodeView chrome for NodeView-backed hosts (the callout
 * title bar). Clicking it expands; the hidden-block count lives in the
 * tooltip and aria-label, never inline (quiet-by-default, VS Code's idiom).
 */
import { applyTooltip, hideTooltip } from "./tooltip";
import { t } from "../i18n";

export interface FoldEllipsis {
    readonly dom: HTMLButtonElement;
    /** Update the hidden-block count (tooltip + aria-label). */
    setCount(count: number): void;
}

function hiddenLabel(count: number): string {
    return count === 1 ? t("1 block hidden") : `${count} ${t("blocks hidden")}`;
}

export function createFoldEllipsis(count: number, onExpand: () => void): FoldEllipsis {
    const dom = document.createElement("button");
    dom.type = "button";
    dom.className = "fold-ellipsis";
    dom.textContent = "…";
    dom.contentEditable = "false";
    const tooltip = applyTooltip(dom, "", { placement: "above" });

    const setCount = (next: number): void => {
        dom.setAttribute("aria-label", `${t("Expand")} — ${hiddenLabel(next)}`);
        tooltip.setText(`${hiddenLabel(next)} — ${t("Click to expand")}`);
    };
    setCount(count);

    // Keep the editor caret where it is; the click expands, nothing else.
    dom.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    // The button can sit inside the contentEditable root (heading widget):
    // activation keys on a focused ellipsis must expand, not type.
    dom.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            dom.click();
        }
    });
    dom.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        hideTooltip();
        onExpand();
    });

    return { dom, setCount };
}
