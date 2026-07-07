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
