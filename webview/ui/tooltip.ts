import { getTopbarBottom, isInTopbar } from "../utils/headingUtils";

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

/** Tooltip placements. 'left' centers vertically and opens toward the page
 * body — for right-edge control columns (the embed card) whose tips would
 * otherwise clip at the viewport or cover the control below. */
export type TooltipPlacement = "above" | "below" | "left";

interface TooltipOptions {
    /** Placement: 'below' (default, used by the toolbar), 'above', or 'left' */
    placement?: TooltipPlacement;
    /** Only show when the text is truncated (an ellipsis appears) */
    truncatedOnly?: boolean;
}

export interface TooltipHandle {
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
    placement: TooltipPlacement,
): void {
    tip.style.visibility = "hidden";
    tip.style.display = "block";

    const elRect = el.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();

    let x = elRect.left + elRect.width / 2 - tipRect.width / 2;
    let y: number;

    // The topbar paints over the tooltip, so every vertical decision below is
    // taken against its bottom edge rather than the viewport top. The floor
    // must stay the topbar alone, not safeAreaTop(): the tooltip stacks above
    // the sticky heading, and a floor that counted it would push a toolbar
    // button's own tip down past the sticky title.
    //
    // An anchor INSIDE the bar is the one case that floor gets backwards. A
    // tip named after a control cannot clear the chrome the control lives in
    // without leaving the control: under the formattingInSecondRow
    // arrangement the bar is two rows tall, so a top-row button's tip landed
    // below the row it opens, adrift from the button and over the document.
    // Such a tip is floored by its own anchor and paints ABOVE the bar
    // instead, which is what .custom-tooltip's z-index buys.
    const safeTop = isInTopbar(el) ? 0 : getTopbarBottom();

    if (placement === "left") {
        x = elRect.left - tipRect.width - 6;
        y = elRect.top + elRect.height / 2 - tipRect.height / 2;
        if (x < 4) {
            // No room on the left: fall through to the right side.
            x = elRect.right + 6;
        }
    } else if (placement === "above") {
        y = elRect.top - tipRect.height - 6;
        if (y < safeTop + 4) {
            y = elRect.bottom + 6;
        } // not enough room above, so drop below
    } else {
        y = elRect.bottom + 6;
        if (y + tipRect.height > window.innerHeight - 4) {
            y = elRect.top - tipRect.height - 6;
        }
    }

    // Every branch has a fallback that can itself land in the band: `above`
    // and `below` each flip to the other side without re-checking, and an
    // anchor that is ITSELF under the chrome (a table grip on a scrolled
    // table) leaves both sides inside it. One floor covers all three.
    if (y < safeTop + 4) {
        y = safeTop + 4;
    }
    if (y + tipRect.height > window.innerHeight - 4) {
        y = Math.max(safeTop + 4, window.innerHeight - tipRect.height - 4);
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
    placement: TooltipPlacement = "above",
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
        // No tooltips while a block drag or marquee is in flight (belt to
        // the editor's pointer-events suppression — body-mounted chrome
        // still hit-tests), nor while the ToC flyout is out (the tab's
        // "Show table of contents" tip is redundant then and overlaps it).
        if (
            document.body.classList.contains("block-dragging") ||
            document.body.classList.contains("block-marqueeing") ||
            document.body.classList.contains("toc-flyout-open")
        ) {
            return;
        }
        // Nor while the control's own POPUP is out. A tooltip opens where a
        // menu opens, so a label naming the trigger would sit over the first
        // row it just revealed; this is what lets a menu trigger carry a
        // tooltip at all.
        //
        // Both attributes, and the pair is the whole of it. `aria-expanded`
        // alone means two different things in this webview, and only one of
        // them is a popup: a heading's fold button, the sticky crumb's, the
        // frontmatter toggle and the outline's rows all use it for "the
        // content under me is showing", and every one of those carries a
        // tooltip that has to keep working while it is true. `aria-haspopup`
        // is what separates them, since it says activating this opens
        // something over the page, and the disclosure controls do not set it.
        if (el.hasAttribute("aria-haspopup") && el.getAttribute("aria-expanded") === "true") {
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
