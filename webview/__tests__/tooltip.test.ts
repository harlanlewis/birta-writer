/**
 * Tooltip component tests: hover basics, keyboard-focus display, owner
 * tracking, and Escape dismissal.
 *
 * The module keeps one shared tooltip element cached across the whole file,
 * so tests never wipe document.body — each test creates its own host
 * buttons and resets visibility through hideTooltip().
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyTooltip, hideTooltip, showTooltipAt, showTooltipForRect } from "../ui/tooltip";

const tip = () => document.querySelector(".custom-tooltip") as HTMLElement | null;
const tipVisible = () => tip() !== null && tip()!.style.display !== "none";

function makeButton(label: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = label;
    document.body.appendChild(btn);
    return btn;
}

describe("applyTooltip", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        hideTooltip();
        // release focus held by a previous test's button
        (document.activeElement as HTMLElement | null)?.blur?.();
    });

    it("mouseenter should show the tooltip with the given text", () => {
        const btn = makeButton("a");
        applyTooltip(btn, "Hover text");
        btn.dispatchEvent(new MouseEvent("mouseenter"));
        expect(tipVisible()).toBe(true);
        expect(tip()!.textContent).toBe("Hover text");
    });

    it("a host rect should get the same chip an element would", () => {
        // Chrome the page does not own and cannot see: the Mac app's titlebar
        // buttons are AppKit views drawn over this page, and they name
        // themselves with THIS tooltip so one band does not label its controls
        // two ways. The anchor is a box the shell sends rather than an
        // element, and everything else about the chip is unchanged.
        showTooltipForRect({ left: 100, top: 4, right: 126, bottom: 28, width: 26, height: 24 },
                           "New Note  ⌘N");
        expect(tipVisible()).toBe(true);
        expect(tip()!.textContent).toBe("New Note  ⌘N");
        // Below the box it names, by the same margin an element anchor gets.
        expect(tip()!.style.top).toBe("34px");
    });

    it("a host tooltip should not be taken away by whatever last owned the chip", () => {
        // The two kinds of anchor share one element, so ownership has to be
        // settled or a stale mouseleave from a page button pulls the host's
        // label out from under it. Nothing in the page owns it while a host
        // holds it; the host takes it away by asking.
        const btn = makeButton("a");
        applyTooltip(btn, "Bold");
        btn.dispatchEvent(new MouseEvent("mouseenter"));
        expect(tip()!.textContent).toBe("Bold");

        showTooltipForRect({ left: 100, top: 4, right: 126, bottom: 28, width: 26, height: 24 }, "Open…");
        expect(tip()!.textContent).toBe("Open…");
        btn.dispatchEvent(new MouseEvent("mouseleave"));
        expect(tipVisible()).toBe(true);
        expect(tip()!.textContent).toBe("Open…");

        hideTooltip();
        expect(tipVisible()).toBe(false);
    });

    it("a control whose own popup is out should show no tooltip", () => {
        // A tooltip opens where a menu opens, so the label would sit over the
        // first row the press just revealed. This is the rule that lets a menu
        // trigger carry a tooltip at all.
        const btn = makeButton("a");
        btn.setAttribute("aria-haspopup", "menu");
        applyTooltip(btn, "Settings");
        btn.dispatchEvent(new MouseEvent("mouseenter"));
        expect(tipVisible()).toBe(true);
        hideTooltip();
        btn.setAttribute("aria-expanded", "true");
        btn.dispatchEvent(new MouseEvent("mouseenter"));
        expect(tipVisible()).toBe(false);
        btn.setAttribute("aria-expanded", "false");
        btn.dispatchEvent(new MouseEvent("mouseenter"));
        expect(tipVisible()).toBe(true);
    });

    it("an expanded disclosure control should still show its tooltip", () => {
        // `aria-expanded` means two things in this webview and only one of them
        // is a popup. A heading's fold button, the sticky crumb's, the
        // frontmatter toggle and the outline's rows all use it for "what is
        // under me is showing", and every one of those carries a tooltip that
        // has to keep working while it is true. `aria-haspopup` is the half
        // that separates them, so this is the arm that fails if the rule above
        // is written on `aria-expanded` alone.
        const btn = makeButton("a");
        btn.setAttribute("aria-expanded", "true");
        applyTooltip(btn, "Fold");
        btn.dispatchEvent(new MouseEvent("mouseenter"));
        expect(tipVisible()).toBe(true);
    });

    it("mouseleave should hide the tooltip it owns", () => {
        const btn = makeButton("a");
        applyTooltip(btn, "Hover text");
        btn.dispatchEvent(new MouseEvent("mouseenter"));
        btn.dispatchEvent(new MouseEvent("mouseleave"));
        expect(tipVisible()).toBe(false);
    });

    it("keyboard focus should show the tooltip", () => {
        const btn = makeButton("a");
        applyTooltip(btn, "Focus text");
        btn.focus();
        expect(tipVisible()).toBe(true);
        expect(tip()!.textContent).toBe("Focus text");
    });

    it("blur should hide the tooltip", () => {
        const btn = makeButton("a");
        applyTooltip(btn, "Focus text");
        btn.focus();
        btn.blur();
        expect(tipVisible()).toBe(false);
    });

    it("tabbing between controls should move the tooltip to the newly focused one", () => {
        const a = makeButton("a");
        const b = makeButton("b");
        applyTooltip(a, "First");
        applyTooltip(b, "Second");
        a.focus();
        expect(tip()!.textContent).toBe("First");
        b.focus(); // fires blur on a, then focus on b
        expect(tipVisible()).toBe(true);
        expect(tip()!.textContent).toBe("Second");
    });

    it("Escape should dismiss the tooltip without claiming the key", () => {
        const btn = makeButton("a");
        applyTooltip(btn, "Focus text");
        btn.focus();
        const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        btn.dispatchEvent(e);
        expect(tipVisible()).toBe(false);
        expect(e.defaultPrevented).toBe(false);
    });

    it("mouseleave on a non-owner should not hide another control's tooltip", () => {
        const focused = makeButton("a");
        const hovered = makeButton("b");
        applyTooltip(focused, "Owner");
        applyTooltip(hovered, "Bystander");
        focused.focus();
        // the mouse drifting off an unrelated control must not dismiss it
        hovered.dispatchEvent(new MouseEvent("mouseleave"));
        expect(tipVisible()).toBe(true);
        expect(tip()!.textContent).toBe("Owner");
    });

    it("truncatedOnly with untruncated content should not show on focus", () => {
        // jsdom reports scrollWidth === offsetWidth === 0, i.e. untruncated
        const btn = makeButton("a");
        applyTooltip(btn, "Truncated text", { truncatedOnly: true });
        btn.focus();
        expect(tipVisible()).toBe(false);
    });

    it("empty text should not show on focus", () => {
        const btn = makeButton("a");
        applyTooltip(btn, "");
        btn.focus();
        expect(tipVisible()).toBe(false);
    });

    it("setText should update what a later focus shows", () => {
        const btn = makeButton("a");
        const handle = applyTooltip(btn, "Before");
        handle.setText("After");
        btn.focus();
        expect(tip()!.textContent).toBe("After");
    });

    it("blur after a programmatic handle.show should hide the tooltip", () => {
        const btn = makeButton("a");
        const handle = applyTooltip(btn, "Copied!");
        btn.focus();
        handle.show();
        expect(tipVisible()).toBe(true);
        btn.blur();
        expect(tipVisible()).toBe(false);
    });
});

describe("showTooltipAt / hideTooltip", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        hideTooltip();
    });

    it("showTooltipAt should display the text and hideTooltip should clear it", () => {
        const anchor = makeButton("a");
        showTooltipAt(anchor, "Imperative");
        expect(tipVisible()).toBe(true);
        expect(tip()!.textContent).toBe("Imperative");
        hideTooltip();
        expect(tipVisible()).toBe(false);
    });
});

describe("placement against the fixed chrome", () => {
    beforeEach(() => {
        hideTooltip();
        document.querySelector(".editor-topbar")?.remove();
        document.querySelector(".heading-sticky-title")?.remove();
    });

    // jsdom has no layout, so every rect is stubbed: a topbar `barHeight`
    // tall, a 64px sticky heading below it, a toolbar button on the bar's
    // first row, a second anchor in the document below, and a 20px-tall
    // tooltip.
    //
    // `barHeight` is the parameter the two-row arrangement needs. A bar as
    // tall as its one row cannot tell "floored to the bar" from "hung off the
    // button": on a 40px bar the two land 6px apart, so a fixture built only
    // at that height pins neither rule against the other.
    function fixedChrome(barHeight = 40) {
        const topbar = document.createElement("div");
        topbar.className = "editor-topbar";
        topbar.getBoundingClientRect = () => new DOMRect(0, 0, 800, barHeight);
        document.body.appendChild(topbar);
        const sticky = document.createElement("div");
        sticky.className = "heading-sticky-title";
        sticky.getBoundingClientRect = () => new DOMRect(0, barHeight, 800, 64);
        document.body.appendChild(sticky);
        const btn = document.createElement("button");
        btn.getBoundingClientRect = () => new DOMRect(300, 8, 24, 24);
        topbar.appendChild(btn);
        const inDoc = document.createElement("button");
        inDoc.getBoundingClientRect = () => new DOMRect(300, 10, 24, 24);
        document.body.appendChild(inDoc);
        return { btn, inDoc };
    }

    // The tooltip is measured on its second placement: the first one reads a
    // zero rect, and every assertion here is about where the box lands.
    function place(el: HTMLElement, text: string, placement: "below" | "above") {
        showTooltipAt(el, text, placement);
        tip()!.getBoundingClientRect = () => new DOMRect(0, 0, 80, 20);
        showTooltipAt(el, text, placement);
        return tip()!;
    }

    it("a toolbar button's tooltip should hang off the button, not off the bar", () => {
        const { btn } = fixedChrome();
        // The button's own gap: 8 + 24 + 6.
        expect(place(btn, "Insert Table", "below").style.top).toBe("38px");
    });

    it("a bar grown to two rows should still leave the tooltip on its button", () => {
        const { btn } = fixedChrome(68);
        // The regression this rewrite exists for. Floored to the bar's bottom
        // the tip would be at 72, below the row the button opens and adrift
        // from the button it names; the single-row bar above hid that,
        // because there 38 and 44 read the same on screen.
        expect(place(btn, "Hide formatting controls", "below").style.top).toBe("38px");
    });

    it("a document anchor's tooltip should be floored to the topbar, not to the sticky heading", () => {
        const { inDoc } = fixedChrome();
        // 10 + 24 + 6 = 40 is under the bar, which paints over the tooltip, so
        // it lands on the bar's bottom edge plus the margin. Floored against
        // the whole safe area it would sit under the sticky heading instead
        // (40 + 64 + 4).
        expect(place(inDoc, "Insert Table", "below").style.top).toBe(`${40 + 4}px`);
    });

    it("a document anchor above the topbar's bottom edge should still be floored to that edge", () => {
        const { inDoc } = fixedChrome();
        inDoc.getBoundingClientRect = () => new DOMRect(300, -30, 24, 24);
        showTooltipAt(inDoc, "Off the top", "above");
        expect(parseFloat(tip()!.style.top)).toBeGreaterThanOrEqual(40 + 4);
    });
});
