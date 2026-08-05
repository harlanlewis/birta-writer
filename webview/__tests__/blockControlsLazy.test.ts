/**
 * A block control column mounts EMPTY and attaches its buttons on first
 * reveal (webview/ui/blockControls.ts, MAR-251). These pin the contract the
 * NodeViews and the CSS both depend on: nothing in the strip at rest, the
 * queued controls in their declared order the moment a reveal arrives, and
 * exactly once however many triggers fire.
 *
 * jsdom runs no CSS transitions, so the `transitionrun` trigger — the one
 * that catches the pointer-free reveals (`bc-active` when the caret lands in
 * the block, `bc-col--shown` when an image pins its column) — can only be
 * checked here by dispatching the event. That it FIRES for those class flips
 * is a browser behaviour, and is pinned in Chromium by e2e/blockWidth.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createBlockControlsColumn, makeBlockControlButton } from "../ui/blockControls";

function makeHost(): { host: HTMLElement; col: ReturnType<typeof createBlockControlsColumn> } {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const col = createBlockControlsColumn(host);
    host.appendChild(col.el);
    return { host, col };
}

const button = (name: string): HTMLButtonElement =>
    makeBlockControlButton({
        className: name,
        icon: "<svg></svg>",
        label: name,
        onClick: () => { /* no-op */ },
    }).button;

describe("block control column lazy population", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    it("a column that has never been revealed should hold no controls", () => {
        const { host, col } = makeHost();
        col.add(button("a"), button("b"));
        expect(host.querySelectorAll(".bc-btn")).toHaveLength(0);
        expect(col.el.childElementCount).toBe(0);
    });

    it("pointerenter on the host should attach the queued controls in order", () => {
        const { host, col } = makeHost();
        col.add(button("a"), button("b"));
        host.dispatchEvent(new Event("pointerenter"));
        expect([...col.el.children].map((el) => el.className))
            .toEqual(["bc-btn a", "bc-btn b"]);
    });

    it("focusin on the host should attach them too (a focus reveal has no pointer)", () => {
        const { host, col } = makeHost();
        col.add(button("a"));
        host.dispatchEvent(new Event("focusin"));
        expect(host.querySelectorAll(".bc-btn")).toHaveLength(1);
    });

    it("transitionrun on the strip should attach them (the caret/pin reveal path)", () => {
        const { host, col } = makeHost();
        col.add(button("a"));
        col.el.dispatchEvent(new Event("transitionrun"));
        expect(host.querySelectorAll(".bc-btn")).toHaveLength(1);
    });

    it("a second trigger after a reveal should not duplicate the controls", () => {
        const { host, col } = makeHost();
        col.add(button("a"));
        host.dispatchEvent(new Event("pointerenter"));
        host.dispatchEvent(new Event("focusin"));
        col.el.dispatchEvent(new Event("transitionrun"));
        expect(host.querySelectorAll(".bc-btn")).toHaveLength(1);
    });

    it("adding a control after the reveal should attach it immediately", () => {
        const { host, col } = makeHost();
        col.add(button("a"));
        col.reveal();
        col.add(button("b"));
        expect([...col.el.children].map((el) => el.className))
            .toEqual(["bc-btn a", "bc-btn b"]);
    });

    it("reveal() before anything is queued should still attach what is added later", () => {
        const { host, col } = makeHost();
        col.reveal();
        col.add(button("a"));
        expect(host.querySelectorAll(".bc-btn")).toHaveLength(1);
    });
});
