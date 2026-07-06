import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wireHoverMenu } from "../components/toolbar/hoverMenu";

// Real DOM + fake timers exercise the actual open/close state machine, including
// the button->menu gap bridge. placeMenu runs inside open(); in jsdom it reads
// zero geometry and just sets styles without throwing, which is fine here — the
// geometry itself is covered in menuPlacement.test.ts.

function build(): { wrap: HTMLElement; button: HTMLButtonElement; menu: HTMLElement } {
    const wrap = document.createElement("div");
    const button = document.createElement("button");
    const menu = document.createElement("div");
    menu.style.display = "none";
    wrap.append(button, menu);
    document.body.appendChild(wrap);
    return { wrap, button, menu };
}

function fire(el: HTMLElement, type: "mouseenter" | "mouseleave"): void {
    el.dispatchEvent(new MouseEvent(type));
}

describe("wireHoverMenu", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

    it("opens on wrap hover, running onOpen before showing", () => {
        const { wrap, button, menu } = build();
        const calls: string[] = [];
        wireHoverMenu(wrap, button, menu, {
            onOpen: () => calls.push(menu.style.display), // captured before show
        });
        fire(wrap, "mouseenter");
        expect(menu.style.display).toBe("flex");
        expect(calls).toEqual(["none"]); // onOpen ran first, while still hidden
    });

    it("hides only after the grace delay on leave", () => {
        const { wrap, button, menu } = build();
        wireHoverMenu(wrap, button, menu);
        fire(wrap, "mouseenter");
        fire(wrap, "mouseleave");
        expect(menu.style.display).toBe("flex"); // still open during grace
        vi.advanceTimersByTime(100);
        expect(menu.style.display).toBe("none");
    });

    it("keeps the menu open when the pointer reaches it across the gap", () => {
        const { wrap, button, menu } = build();
        wireHoverMenu(wrap, button, menu);
        fire(wrap, "mouseenter");
        fire(wrap, "mouseleave"); // pointer enters the dead-space gap
        fire(menu, "mouseenter"); // ...then reaches the menu
        vi.advanceTimersByTime(500);
        expect(menu.style.display).toBe("flex");
    });

    it("respects a custom hideDelayMs", () => {
        const { wrap, button, menu } = build();
        wireHoverMenu(wrap, button, menu, { hideDelayMs: 50 });
        fire(wrap, "mouseenter");
        fire(wrap, "mouseleave");
        vi.advanceTimersByTime(49);
        expect(menu.style.display).toBe("flex");
        vi.advanceTimersByTime(1);
        expect(menu.style.display).toBe("none");
    });

    it("dispose() clears a pending hide and removes the listeners", () => {
        const { wrap, button, menu } = build();
        const dispose = wireHoverMenu(wrap, button, menu);
        fire(wrap, "mouseenter");
        fire(wrap, "mouseleave"); // schedules the hide
        dispose();
        vi.advanceTimersByTime(500);
        expect(menu.style.display).toBe("flex"); // pending timer was cleared

        // Listeners are gone: further hovers do nothing.
        menu.style.display = "none";
        fire(wrap, "mouseenter");
        expect(menu.style.display).toBe("none");
    });
});
