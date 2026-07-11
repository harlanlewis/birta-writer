let tooltipEl: HTMLElement | null = null;

// Element the visible tooltip belongs to. Hover and keyboard focus share the
// one tooltip element, so dismissal must be owner-checked: without it, the
// mouse leaving button A would hide the tooltip keyboard focus just opened
// on button B.
let ownerEl: HTMLElement | null = null;

function getTooltip(): HTMLElement {
    if (!tooltipEl) {
        tooltipEl = document.createElement("div");
        tooltipEl.className = "custom-tooltip";
        document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
}

interface TooltipOptions {
    /** Placement: 'below' (default, used by the toolbar) or 'above' */
    placement?: "above" | "below";
    /** Only show when the text is truncated (an ellipsis appears) */
    truncatedOnly?: boolean;
}

interface TooltipHandle {
    /** Dynamically update the tooltip text (without affecting visibility) */
    setText(t: string): void;
    /** Show the tooltip programmatically (e.g. for post-click feedback) */
    show(): void;
    /**
     * Unbind every listener this handle added and hide the tooltip if it still
     * owns it. Lets a caller (e.g. the toolbar's customize mode) attach a
     * temporary tooltip and cleanly remove it later without leaking listeners
     * or leaving a duplicate binding behind.
     */
    dispose(): void;
}

function position(
    tip: HTMLElement,
    el: HTMLElement,
    placement: "above" | "below",
): void {
    tip.style.visibility = "hidden";
    tip.style.display = "block";

    const elRect = el.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();

    let x = elRect.left + elRect.width / 2 - tipRect.width / 2;
    let y: number;

    if (placement === "above") {
        y = elRect.top - tipRect.height - 6;
        if (y < 4) {
            y = elRect.bottom + 6;
        } // not enough room above, so drop below
    } else {
        y = elRect.bottom + 6;
        if (y + tipRect.height > window.innerHeight - 4) {
            y = elRect.top - tipRect.height - 6;
        }
    }

    if (x + tipRect.width > window.innerWidth - 4) {
        x = window.innerWidth - tipRect.width - 4;
    }
    if (x < 4) {
        x = 4;
    }

    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.style.visibility = "visible";
}

/** Immediately hide the currently visible tooltip (e.g. to clear it after a click interaction) */
export function hideTooltip(): void {
    ownerEl = null;
    if (tooltipEl) {
        tooltipEl.style.display = "none";
    }
}

/** Imperative: show a tooltip next to the given element right away, no event binding needed */
export function showTooltipAt(
    el: Element,
    text: string,
    placement: "above" | "below" = "above",
): void {
    const tip = getTooltip();
    tip.textContent = text;
    position(tip, el as HTMLElement, placement);
    ownerEl = el as HTMLElement;
}

// True when focus should surface hover affordances, i.e. keyboard focus.
// Falls back to showing where the selector engine lacks :focus-visible
// (jsdom in tests).
function isKeyboardFocus(el: HTMLElement): boolean {
    try {
        return el.matches(":focus-visible");
    } catch {
        return true;
    }
}

/** Replace the native title with a VSCode-style custom tooltip */
export function applyTooltip(
    el: HTMLElement,
    text: string,
    options: TooltipOptions = {},
): TooltipHandle {
    const { placement = "below", truncatedOnly = false } = options;
    let currentText = text;

    el.removeAttribute("title");

    // All listeners are registered with this signal so dispose() can unbind
    // them in one call (no per-listener bookkeeping).
    const ac = new AbortController();
    const { signal } = ac;

    const show = () => {
        if (!currentText) {
            return;
        }
        // No tooltips while a block drag is in flight (belt to the editor's
        // pointer-events suppression — body-mounted chrome still hit-tests).
        if (document.body.classList.contains("block-dragging")) {
            return;
        }
        if (truncatedOnly && el.scrollWidth <= el.offsetWidth) {
            return;
        }
        const tip = getTooltip();
        tip.textContent = currentText;
        position(tip, el, placement);
        ownerEl = el;
    };
    const hideIfOwner = () => {
        if (ownerEl === el) {
            hideTooltip();
        }
    };

    el.addEventListener("mouseenter", show, { signal });
    el.addEventListener("mouseleave", hideIfOwner, { signal });

    // Keyboard parity with hover: tabbing onto the control surfaces the
    // tooltip, leaving hides it. Click focus stays silent (not
    // :focus-visible) — mouse users already get the hover path. Escape
    // dismisses without claiming the key, so overlays underneath (e.g.
    // the find bar's own Escape-to-close) still see it.
    el.addEventListener("focus", () => {
        if (isKeyboardFocus(el)) {
            show();
        }
    }, { signal });
    el.addEventListener("blur", hideIfOwner, { signal });
    el.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            hideIfOwner();
        }
    }, { signal });

    return {
        setText(t: string) {
            currentText = t;
        },
        show() {
            if (!currentText) {
                return;
            }
            const tip = getTooltip();
            tip.textContent = currentText;
            position(tip, el, placement);
            ownerEl = el;
        },
        dispose() {
            ac.abort();
            hideIfOwner();
        },
    };
}
