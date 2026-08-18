/**
 * Tooltip component tests: hover basics, keyboard-focus display, owner
 * tracking, and Escape dismissal.
 *
 * The module keeps one shared tooltip element cached across the whole file,
 * so tests never wipe document.body — each test creates its own host
 * buttons and resets visibility through hideTooltip().
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyTooltip, hideTooltip, showTooltipAt } from "../ui/tooltip";

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

    // jsdom has no layout, so every rect is stubbed: a 40px topbar, a 64px
    // sticky heading below it, a toolbar button inside the topbar, and a
    // 20px-tall tooltip.
    function fixedChrome(): HTMLButtonElement {
        const topbar = document.createElement("div");
        topbar.className = "editor-topbar";
        topbar.getBoundingClientRect = () => new DOMRect(0, 0, 800, 40);
        document.body.appendChild(topbar);
        const sticky = document.createElement("div");
        sticky.className = "heading-sticky-title";
        sticky.getBoundingClientRect = () => new DOMRect(0, 40, 800, 64);
        document.body.appendChild(sticky);
        const btn = document.createElement("button");
        btn.getBoundingClientRect = () => new DOMRect(300, 8, 24, 24);
        topbar.appendChild(btn);
        return btn;
    }

    it("a toolbar tooltip should sit just under its button, not under the sticky heading the tooltip paints over", () => {
        const btn = fixedChrome();
        showTooltipAt(btn, "Insert Table", "below");
        const t = tip()!;
        t.getBoundingClientRect = () => new DOMRect(0, 0, 80, 20);
        // Re-place with the tooltip's own size known (the first placement
        // measured a zero rect; the assertion is about the anchor gap).
        showTooltipAt(btn, "Insert Table", "below");
        // The button's own gap (8 + 24 + 6 = 38) is inside the topbar, which
        // paints over the tooltip, so it lands on the topbar's floor: bottom
        // edge plus the margin. Measured against the whole safe area it would
        // sit under the sticky heading instead (40 + 64 + 4).
        expect(t.style.top).toBe(`${40 + 4}px`);
    });

    it("an anchor above the topbar's bottom edge should still be floored to that edge", () => {
        const btn = fixedChrome();
        btn.getBoundingClientRect = () => new DOMRect(300, -30, 24, 24);
        showTooltipAt(btn, "Off the top", "above");
        expect(parseFloat(tip()!.style.top)).toBeGreaterThanOrEqual(40 + 4);
    });
});
