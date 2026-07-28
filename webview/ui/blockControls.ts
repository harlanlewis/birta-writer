/**
 * webview/ui/blockControls.ts
 *
 * Builders for the shared block control column (see blockControls.css): the
 * outside-top-right home for a rich block's key actions, extracted from the
 * embed card so embeds, images, tables, and code blocks share one anatomy.
 *
 * Buttons follow the widget-safety contract lifted from embedCard.ts
 * (guardActivation): inside the contenteditable root a control's mousedown
 * must not move the caret, and Enter/Space on a focused button must activate
 * it rather than type into the document (ui/foldEllipsis.ts's contract).
 */
import "./blockControls.css";
import { applyTooltip, type TooltipHandle } from "./tooltip";

/**
 * Make a control safe inside the contenteditable root: mousedown must not
 * move the editor caret, and Enter / Space on a focused button must activate
 * it rather than type into the document.
 */
export function guardActivation(button: HTMLElement): void {
    button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    button.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            button.click();
        }
    });
}

export interface BlockControlButton {
    button: HTMLButtonElement;
    tooltip: TooltipHandle;
    /** Update the icon + accessible label + tooltip together. */
    setVerb(icon: string, label: string): void;
    /** Persistent-ON tint — only for toggles whose state isn't already
     * visible in the content (full width, word wrap). */
    setOn(on: boolean): void;
}

/**
 * One column button composing the `.bc-btn` recipe. `className` is the
 * caller's own hook class (kept for tests and per-component styling);
 * `danger` inks it with errorForeground.
 */
export function makeBlockControlButton(opts: {
    className: string;
    icon: string;
    label: string;
    danger?: boolean;
    onClick: () => void;
}): BlockControlButton {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `bc-btn${opts.danger ? " bc-btn--danger" : ""} ${opts.className}`;
    const tooltip = applyTooltip(button, opts.label, { placement: "left" });
    const setVerb = (icon: string, label: string): void => {
        button.innerHTML = icon;
        button.setAttribute("aria-label", label);
        tooltip.setText(label);
    };
    setVerb(opts.icon, opts.label);
    const setOn = (on: boolean): void => {
        button.classList.toggle("bc-btn--on", on);
        button.setAttribute("aria-pressed", on ? "true" : "false");
    };
    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        opts.onClick();
    });
    guardActivation(button);
    return { button, tooltip, setVerb, setOn };
}

/** The column itself — hidden at rest, revealed on host hover/focus (one
 * rule for every block; pin open with `.bc-col--shown`). The host must be a
 * positioning context; this adds the `bc-host` class that drives the
 * visibility, and also documents the ORDER convention every column follows:
 * primary verb first (open / zoom / copy), then view verbs (preview, wrap,
 * width, fullscreen), then a `.bc-gap`, then document-editing verbs. No
 * delete buttons — deletion belongs to the block menu and the keyboard. */
export function createBlockControlsColumn(host: HTMLElement): HTMLElement {
    host.classList.add("bc-host");
    const col = document.createElement("div");
    col.className = "bc-col";
    col.setAttribute("contenteditable", "false");
    return col;
}

/** A small spacer separating verb groups within a column. */
export function makeBlockControlsGap(): HTMLElement {
    const gap = document.createElement("div");
    gap.className = "bc-gap";
    return gap;
}
