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

/** A box in viewport coordinates: what an element reports, or what a host says. */
export interface TooltipAnchor {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly width: number;
    readonly height: number;
}

/**
 * Place the chip against `elRect`.
 *
 * A RECT rather than an element, because the anchor is not always one: the Mac
 * app's titlebar buttons are AppKit views drawn over this page, and they name
 * themselves with this same chip so the two halves of that band say things the
 * same way. Everything about how the tooltip looks and where it goes stays
 * here, which is the only reason those buttons can borrow it without a second
 * implementation growing in Swift.
 *
 * `safeTop` is the floor the chip may not go above, and it is the caller's
 * because only the caller knows what the anchor is: chrome inside the top bar
 * is floored at the viewport, and a document anchor is floored under the bar
 * that paints over it.
 */
function position(
    tip: HTMLElement,
    elRect: TooltipAnchor,
    placement: TooltipPlacement,
    safeTop: number,
): void {
    tip.style.visibility = "hidden";
    tip.style.display = "block";

    const tipRect = tip.getBoundingClientRect();

    let x = elRect.left + elRect.width / 2 - tipRect.width / 2;
    let y: number;

    // The topbar paints over the tooltip, so every vertical decision below is
    // taken against its bottom edge rather than the viewport top. The floor
    // must stay the topbar alone, not safeAreaTop(): the tooltip stacks above
    // the sticky heading, and a floor that counted it would push a toolbar
    // button's own tip down past the sticky title.
    //
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
/**
 * The floor for an anchor that IS an element.
 *
 * An anchor inside the bar is the case a naive floor gets backwards. A tip
 * named after a control cannot clear the chrome the control lives in without
 * leaving the control: under the `formattingInSecondRow` arrangement the bar
 * is two rows tall, so a top-row button's tip landed below the row it opens,
 * adrift from the button and over the document. Such a tip is floored by its
 * own anchor and paints ABOVE the bar instead, which is what
 * `.custom-tooltip`'s z-index buys.
 */
function safeTopFor(el: HTMLElement): number {
    return isInTopbar(el) ? 0 : getTopbarBottom();
}

export function showTooltipAt(
    el: Element,
    text: string,
    placement: TooltipPlacement = "above",
): void {
    const tip = getTooltip();
    tip.textContent = text;
    position(tip, (el as HTMLElement).getBoundingClientRect(), placement, safeTopFor(el as HTMLElement));
    ownerEl = el as HTMLElement;
}

/**
 * Draw the chip against a box the HOST gave us, in viewport coordinates.
 *
 * For chrome this page does not own and cannot see. The Mac app's titlebar
 * band is half AppKit and half this toolbar, and the two are meant to read as
 * one strip; a system tooltip on one half and this chip on the other is the
 * same strip saying things two ways. The shell sends the button's box and its
 * label, and the tooltip that appears is literally this one.
 *
 * The floor is the viewport, because such an anchor is by definition in the
 * window's own chrome, above anything this page paints.
 *
 * `ownerEl` is cleared rather than set, and that is what keeps the two kinds
 * of anchor from fighting: nothing in the page owns this chip while a host
 * holds it, so a stale `mouseleave` from whatever last owned it cannot take
 * it away. The host takes it away by asking (`hideTooltip`).
 */
export function showTooltipForRect(
    rect: TooltipAnchor,
    text: string,
    placement: TooltipPlacement = "below",
): void {
    const tip = getTooltip();
    tip.textContent = text;
    position(tip, rect, placement, 0);
    ownerEl = null;
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
        position(tip, el.getBoundingClientRect(), placement, safeTopFor(el));
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
            position(tip, el.getBoundingClientRect(), placement, safeTopFor(el));
            ownerEl = el;
        },
        dispose() {
            ac.abort();
            hideIfOwner();
        },
    };
}
