import { describe, it, expect, beforeEach } from "vitest";
import { wireRoving } from "../components/toc/keyboardNav";

/** Roving-tabindex list navigation — the sidebar's keyboard access. */

function buttons(container: HTMLElement): HTMLButtonElement[] {
    return [...container.querySelectorAll("button")];
}
function makeList(n: number): HTMLElement {
    const c = document.createElement("div");
    for (let i = 0; i < n; i++) {
        const b = document.createElement("button");
        b.textContent = `i${i}`;
        c.appendChild(b);
    }
    document.body.appendChild(c);
    return c;
}
const key = (c: HTMLElement, k: string) => c.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

describe("wireRoving", () => {
    beforeEach(() => { document.body.innerHTML = ""; });

    it("seeds only the first item as tabbable", () => {
        const c = makeList(3);
        wireRoving({ container: c, items: () => buttons(c) });
        expect(buttons(c).map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    });

    it("ArrowDown / ArrowUp move focus and carry the tabbable slot", () => {
        const c = makeList(3);
        wireRoving({ container: c, items: () => buttons(c) });
        const b = buttons(c);
        b[0]!.focus();
        key(c, "ArrowDown");
        expect(document.activeElement).toBe(b[1]);
        expect(b.map((x) => x.tabIndex)).toEqual([-1, 0, -1]);
        key(c, "ArrowUp");
        expect(document.activeElement).toBe(b[0]);
    });

    it("Home / End jump to the ends", () => {
        const c = makeList(4);
        wireRoving({ container: c, items: () => buttons(c) });
        buttons(c)[1]!.focus();
        key(c, "End");
        expect(document.activeElement).toBe(buttons(c)[3]);
        key(c, "Home");
        expect(document.activeElement).toBe(buttons(c)[0]);
    });

    it("Escape invokes onEscape", () => {
        const c = makeList(2);
        let escaped = false;
        wireRoving({ container: c, items: () => buttons(c), onEscape: () => { escaped = true; } });
        key(c, "Escape");
        expect(escaped).toBe(true);
    });

    it("Left/Right go through onHorizontal when it handles them", () => {
        const c = makeList(2);
        const dirs: number[] = [];
        wireRoving({ container: c, items: () => buttons(c), onHorizontal: (_i, d) => { dirs.push(d); return true; } });
        buttons(c)[0]!.focus();
        key(c, "ArrowLeft");
        key(c, "ArrowRight");
        expect(dirs).toEqual([-1, 1]);
    });

    it("Enter clicks a non-button row (buttons activate natively)", () => {
        const c = document.createElement("div");
        const row = document.createElement("div");
        row.tabIndex = 0;
        let clicked = false;
        row.addEventListener("click", () => { clicked = true; });
        c.appendChild(row);
        document.body.appendChild(c);
        wireRoving({ container: c, items: () => [row] });
        row.focus();
        key(c, "Enter");
        expect(clicked).toBe(true);
    });
});
