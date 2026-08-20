import { describe, it, expect, afterEach } from "vitest";
import { watchOutsidePress } from "../ui/outsidePress";

/**
 * The dismissal rule for click-opened surfaces (ui/outsidePress.ts).
 *
 * The case worth being careful about is the capture phase. Menu triggers call
 * `stopPropagation` on their own mousedown, so a bubble-phase listener never
 * hears a press on another surface's trigger — and that press is exactly the
 * one that has to close the open surface. A test that only pressed on a plain
 * `<div>` would pass against a bubble-phase implementation and prove nothing,
 * so the swallowing trigger is modelled here explicitly.
 */

function el(tag = "div"): HTMLElement {
    const node = document.createElement(tag);
    document.body.appendChild(node);
    return node;
}

/** A press, the way a real one arrives: bubbling and cancelable. */
function press(target: HTMLElement): void {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
}

/** A trigger that swallows its own mousedown, as `createMenuTrigger` does. */
function swallowingTrigger(): HTMLElement {
    const button = el("button");
    button.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    return button;
}

describe("watchOutsidePress", () => {
    afterEach(() => { document.body.innerHTML = ""; });

    it("a press outside every named element should call back", () => {
        const inside = el();
        const elsewhere = el();
        let closed = 0;
        watchOutsidePress([inside], () => { closed += 1; });
        press(elsewhere);
        expect(closed).toBe(1);
    });

    it("a press inside a named element should not", () => {
        const inside = el();
        const child = document.createElement("span");
        inside.appendChild(child);
        let closed = 0;
        watchOutsidePress([inside], () => { closed += 1; });
        press(child);
        expect(closed).toBe(0);
    });

    // THE case. A bubble-phase listener never sees this press at all, so this
    // is what discriminates the implementation from the obvious wrong one.
    it("a press on a trigger that swallows its own mousedown should still call back", () => {
        const inside = el();
        const other = swallowingTrigger();
        let closed = 0;
        watchOutsidePress([inside], () => { closed += 1; });
        press(other);
        expect(closed).toBe(1);
    });

    it("every element in the list should count as inside", () => {
        const menu = el();
        const trigger = el();
        let closed = 0;
        watchOutsidePress([menu, trigger], () => { closed += 1; });
        press(menu);
        press(trigger);
        expect(closed).toBe(0);
        press(el());
        expect(closed).toBe(1);
    });

    it("unregistering should stop the callbacks", () => {
        const inside = el();
        const outside = el();
        let closed = 0;
        const off = watchOutsidePress([inside], () => { closed += 1; });
        press(outside);
        expect(closed).toBe(1);
        off();
        press(outside);
        expect(closed).toBe(1);
    });

    it("unregistering twice should be harmless", () => {
        const inside = el();
        const off = watchOutsidePress([inside], () => { /* unused */ });
        off();
        expect(() => off()).not.toThrow();
    });

    it("a null or absent element in the list should not count as containing anything", () => {
        let closed = 0;
        watchOutsidePress([null, undefined], () => { closed += 1; });
        press(el());
        expect(closed).toBe(1);
    });
});
