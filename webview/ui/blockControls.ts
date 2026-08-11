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

/** A control column: the strip, plus the deferred attachment of its contents. */
export interface BlockControlsColumn {
    /** The strip. Append it to the host as usual — it mounts EMPTY. */
    readonly el: HTMLElement;
    /**
     * Queue controls in column order. They are attached to the strip on the
     * column's first reveal, not at mount — see the note on
     * `createBlockControlsColumn`. Adding after a reveal attaches immediately.
     */
    add(...children: HTMLElement[]): void;
    /** Attach the queued controls now. Idempotent; safe before `add`. */
    reveal(): void;
}

/** The column itself — hidden at rest, revealed on host hover/focus (one
 * rule for every block; pin open with `.bc-col--shown`). The host must be a
 * positioning context; this adds the `bc-host` class that drives the
 * visibility, and also documents the ORDER convention every column follows:
 * primary verb first (open / zoom / copy), then view verbs (preview, wrap,
 * width, fullscreen), then a `.bc-gap`, then document-editing verbs. No
 * delete buttons — deletion belongs to the block menu and the keyboard.
 *
 * **The strip mounts empty and its contents attach on first reveal**
 * (MAR-251). Every column is invisible at rest and the user reveals a handful
 * of them, so mounting every strip's buttons puts a large share of a
 * block-heavy document's DOM into the first paint for chrome nobody asked to
 * see. The cost being avoided is joining a live tree and being styled and laid
 * out, NOT building the nodes — so defer the ATTACHMENT and never the
 * construction: the buttons are built eagerly, so every caller's
 * `syncWidthBtn()` / `applyWordWrapState()` keeps working on a detached node
 * and is simply correct the moment it lands.
 *
 * Three triggers arm the reveal, and the third is the one that makes the set
 * complete rather than a guess. The CSS is the choke point *every* reveal path
 * goes through — `.bc-host:hover`, `:focus-within`, `.bc-active` (a caret
 * arriving in the block, no pointer involved), `.bc-col--shown` (an image
 * pinning its column from selectNode) — and each one animates the strip's
 * opacity, so `transitionrun` fires however the reveal was caused, including
 * by paths added later. That is also its one dependency: **`.bc-col`'s
 * `transition: opacity` in blockControls.css is load-bearing.** Take it away
 * (a `prefers-reduced-motion` rule is the plausible way) and the pointer-free
 * reveals go back to fading in an empty strip. The other two triggers are the
 * semantic fallbacks that survive that, and they are what a jsdom test can
 * drive — jsdom runs no transitions at all.
 */
export function createBlockControlsColumn(host: HTMLElement): BlockControlsColumn {
    host.classList.add("bc-host");
    const col = document.createElement("div");
    col.className = "bc-col";
    col.setAttribute("contenteditable", "false");
    // The buttons live in their own stack inside the strip rather than in the
    // strip itself, and that indirection is what lets them stay on screen: the
    // strip is absolutely positioned (it has to overhang the block), and an
    // absolutely positioned box cannot also be sticky. See blockControls.css.
    const stack = document.createElement("div");
    stack.className = "bc-stack";
    col.appendChild(stack);

    let pending: DocumentFragment | null = document.createDocumentFragment();
    const ac = new AbortController();
    const reveal = (): void => {
        if (!pending) {
            return;
        }
        const frag = pending;
        pending = null;
        ac.abort();
        stack.appendChild(frag);
    };
    const { signal } = ac;
    host.addEventListener("pointerenter", reveal, { signal });
    host.addEventListener("focusin", reveal, { signal });
    col.addEventListener("transitionrun", reveal, { signal });

    return {
        el: col,
        add(...children: HTMLElement[]): void {
            for (const child of children) {
                (pending ?? stack).appendChild(child);
            }
        },
        reveal,
    };
}

/** A small spacer separating verb groups within a column. */
export function makeBlockControlsGap(): HTMLElement {
    const gap = document.createElement("div");
    gap.className = "bc-gap";
    return gap;
}
