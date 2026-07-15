import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wireHoverMenu } from "../components/toolbar/hoverMenu";
import { closeTopmostLayer } from "../ui/escapeLayers";

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

// Matches hoverMenu's default openDelayMs — hover opens are gated behind it.
const OPEN_DELAY_MS = 140;

function fire(el: HTMLElement, type: "mouseenter" | "mouseleave"): void {
    el.dispatchEvent(new MouseEvent(type));
}

function key(k: string): KeyboardEvent {
    return new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
}

describe("wireHoverMenu", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // Drain layer entries left behind by other tests (module-level stack).
        while (closeTopmostLayer()) { /* drain */ }
    });
    afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

    it("opens on wrap hover, running onOpen before showing", () => {
        const { wrap, button, menu } = build();
        const calls: string[] = [];
        wireHoverMenu(wrap, button, menu, {
            onOpen: () => calls.push(menu.style.display), // captured before show
        });
        fire(wrap, "mouseenter");
        vi.advanceTimersByTime(OPEN_DELAY_MS);
        expect(menu.style.display).toBe("flex");
        expect(calls).toEqual(["none"]); // onOpen ran first, while still hidden
    });

    it("does not open until the hover-intent delay elapses", () => {
        const { wrap, button, menu } = build();
        wireHoverMenu(wrap, button, menu);
        fire(wrap, "mouseenter");
        vi.advanceTimersByTime(OPEN_DELAY_MS - 1);
        expect(menu.style.display).toBe("none"); // still closed under the delay
        vi.advanceTimersByTime(1);
        expect(menu.style.display).toBe("flex"); // opens exactly at the delay
    });

    it("cancels a pending hover-open if the pointer leaves before the delay", () => {
        const { wrap, button, menu } = build();
        wireHoverMenu(wrap, button, menu);
        fire(wrap, "mouseenter");
        vi.advanceTimersByTime(OPEN_DELAY_MS - 20);
        fire(wrap, "mouseleave"); // swept past before it opened
        vi.advanceTimersByTime(300);
        expect(menu.style.display).toBe("none"); // never opened — no flicker
    });

    it("keyboard open is instant (the intent delay is mouse-only)", () => {
        const { wrap, button, menu } = build();
        const row = document.createElement("div");
        row.className = "tb-fmt-item";
        menu.appendChild(row);
        wireHoverMenu(wrap, button, menu);
        button.focus();
        button.dispatchEvent(key("ArrowDown"));
        // No timer advance: keyboard opens immediately.
        expect(menu.style.display).toBe("flex");
    });

    it("marks the wrap open so its CSS gap-bridge is live, and clears it on close", () => {
        const { wrap, button, menu } = build();
        wireHoverMenu(wrap, button, menu);
        fire(wrap, "mouseenter");
        vi.advanceTimersByTime(OPEN_DELAY_MS);
        expect(wrap.classList.contains("tb-menu-open")).toBe(true);
        fire(wrap, "mouseleave");
        vi.advanceTimersByTime(0);
        expect(wrap.classList.contains("tb-menu-open")).toBe(false);
    });

    it("hides on leave with no grace delay by default", () => {
        const { wrap, button, menu } = build();
        wireHoverMenu(wrap, button, menu);
        fire(wrap, "mouseenter");
        vi.advanceTimersByTime(OPEN_DELAY_MS);
        fire(wrap, "mouseleave");
        // The default delay is 0 — the menu closes on the very next tick, so
        // switching between adjacent dropdowns never briefly stacks them.
        vi.advanceTimersByTime(0);
        expect(menu.style.display).toBe("none");
    });

    it("keeps the menu open when the pointer reaches it across the gap", () => {
        const { wrap, button, menu } = build();
        wireHoverMenu(wrap, button, menu);
        fire(wrap, "mouseenter");
        vi.advanceTimersByTime(OPEN_DELAY_MS);
        fire(wrap, "mouseleave"); // pointer leaves the wrap
        fire(menu, "mouseenter"); // ...but reaches the menu before the hide tick
        vi.advanceTimersByTime(500);
        expect(menu.style.display).toBe("flex");
    });

    it("respects a custom hideDelayMs", () => {
        const { wrap, button, menu } = build();
        wireHoverMenu(wrap, button, menu, { hideDelayMs: 50 });
        fire(wrap, "mouseenter");
        vi.advanceTimersByTime(OPEN_DELAY_MS);
        fire(wrap, "mouseleave");
        vi.advanceTimersByTime(49);
        expect(menu.style.display).toBe("flex");
        vi.advanceTimersByTime(1);
        expect(menu.style.display).toBe("none");
    });

    it("Enter on the trigger should open the menu and focus the first row", () => {
        const { wrap, button, menu } = build();
        const row = document.createElement("div");
        row.className = "tb-fmt-item";
        menu.appendChild(row);
        wireHoverMenu(wrap, button, menu);
        button.focus();
        button.dispatchEvent(key("Enter"));
        expect(menu.style.display).toBe("flex");
        expect(button.getAttribute("aria-expanded")).toBe("true");
        expect(document.activeElement).toBe(row);
    });

    it("Enter on the trigger with the menu open should close it", () => {
        const { wrap, button, menu } = build();
        wireHoverMenu(wrap, button, menu);
        fire(wrap, "mouseenter");
        vi.advanceTimersByTime(OPEN_DELAY_MS);
        expect(menu.style.display).toBe("flex");
        button.focus();
        button.dispatchEvent(key("Enter"));
        expect(menu.style.display).toBe("none");
        expect(button.getAttribute("aria-expanded")).toBe("false");
    });

    it("arrow keys should cycle focus across rows, skipping hidden ones", () => {
        const { wrap, button, menu } = build();
        const rows = ["a", "b", "c"].map((label) => {
            const row = document.createElement("div");
            row.className = "tb-fmt-item";
            row.textContent = label;
            menu.appendChild(row);
            return row;
        });
        rows[1].style.display = "none";
        wireHoverMenu(wrap, button, menu);
        button.focus();
        button.dispatchEvent(key("ArrowDown"));
        expect(document.activeElement).toBe(rows[0]);
        rows[0].dispatchEvent(key("ArrowDown"));
        expect(document.activeElement).toBe(rows[2]); // hidden row skipped
        rows[2].dispatchEvent(key("ArrowDown"));
        expect(document.activeElement).toBe(rows[0]); // wraps around
        rows[0].dispatchEvent(key("ArrowUp"));
        expect(document.activeElement).toBe(rows[2]);
    });

    it("Enter on a focused row should replay the mousedown its handler listens for", () => {
        const { wrap, button, menu } = build();
        const row = document.createElement("div");
        row.className = "tb-fmt-item";
        menu.appendChild(row);
        const action = vi.fn();
        row.addEventListener("mousedown", action);
        wireHoverMenu(wrap, button, menu);
        button.focus();
        button.dispatchEvent(key("Enter"));
        const e = key("Enter");
        row.dispatchEvent(e);
        expect(action).toHaveBeenCalledTimes(1);
        expect(e.defaultPrevented).toBe(true); // suppresses a double native click
    });

    it("Escape in the menu should close it and restore trigger focus", () => {
        const { wrap, button, menu } = build();
        const row = document.createElement("div");
        row.className = "tb-fmt-item";
        menu.appendChild(row);
        wireHoverMenu(wrap, button, menu);
        button.focus();
        button.dispatchEvent(key("Enter"));
        row.dispatchEvent(key("Escape"));
        expect(menu.style.display).toBe("none");
        expect(document.activeElement).toBe(button);
    });

    it("focus leaving the wrap should close the menu", () => {
        const { wrap, button, menu } = build();
        const outside = document.createElement("button");
        document.body.appendChild(outside);
        wireHoverMenu(wrap, button, menu);
        button.focus();
        button.dispatchEvent(key("Enter"));
        wrap.dispatchEvent(new FocusEvent("focusout", { relatedTarget: outside }));
        expect(menu.style.display).toBe("none");
    });

    it("the returned close should be the shared close path (Escape layer unregistered)", () => {
        // The item-pick regression: handlers that dismiss the menu must call
        // the returned close, not hide the menu element directly — only
        // close() drops the Escape-layer entry and resets the aria state.
        const { wrap, button, menu } = build();
        const { close } = wireHoverMenu(wrap, button, menu);
        fire(wrap, "mouseenter");
        vi.advanceTimersByTime(OPEN_DELAY_MS);
        expect(closeTopmostLayer()).toBe(true); // open registered a layer...
        expect(menu.style.display).toBe("none"); // ...whose close closes the menu

        fire(wrap, "mouseenter");
        vi.advanceTimersByTime(OPEN_DELAY_MS);
        close();
        expect(menu.style.display).toBe("none");
        expect(button.getAttribute("aria-expanded")).toBe("false");
        expect(wrap.classList.contains("tb-menu-open")).toBe(false);
        // The layer entry is gone — nothing left to swallow the next Escape.
        expect(closeTopmostLayer()).toBe(false);
    });

    it("a direct style hide (the old item-pick bug) would leak; reopening after close re-registers", () => {
        const { wrap, button, menu } = build();
        const { close } = wireHoverMenu(wrap, button, menu);
        fire(wrap, "mouseenter");
        vi.advanceTimersByTime(OPEN_DELAY_MS);
        close();
        // Reopen after a proper close: exactly one live layer entry again
        // (a leaked escapeOff used to suppress re-registration via ??=).
        fire(wrap, "mouseenter");
        vi.advanceTimersByTime(OPEN_DELAY_MS);
        expect(closeTopmostLayer()).toBe(true);
        expect(closeTopmostLayer()).toBe(false);
    });

    it("dispose() clears a pending hide and removes the listeners", () => {
        const { wrap, button, menu } = build();
        const { dispose } = wireHoverMenu(wrap, button, menu);
        fire(wrap, "mouseenter");
        vi.advanceTimersByTime(OPEN_DELAY_MS);
        fire(wrap, "mouseleave"); // schedules the hide
        dispose();
        vi.advanceTimersByTime(500);
        expect(menu.style.display).toBe("flex"); // pending timer was cleared

        // Listeners are gone: further hovers do nothing.
        menu.style.display = "none";
        fire(wrap, "mouseenter");
        vi.advanceTimersByTime(OPEN_DELAY_MS);
        expect(menu.style.display).toBe("none");
    });
});
