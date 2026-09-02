/**
 * One piece of transient chrome out at a time.
 *
 * The defect, seen on the Mac app: the table-of-contents flyout comes out under
 * the pointer, a toolbar dropdown opens over the top of it, and neither knows
 * about the other, so the flyout is left as a card with a menu sitting on it.
 *
 * The two halves are covered separately. The registry's own rules are here; the
 * toolbar menu's membership is at the bottom, driven through `wireHoverMenu` so
 * the claim is that a MENU sweeps, not that a function does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { claimExclusiveChrome, releaseExclusiveChrome } from "../ui/exclusiveChrome";
import { wireHoverMenu } from "../components/toolbar/hoverMenu";
import { closeTopmostLayer } from "../ui/escapeLayers";

const OPEN_DELAY_MS = 140;

function box(): HTMLElement {
    const el = document.createElement("div");
    document.body.appendChild(el);
    return el;
}

describe("claimExclusiveChrome", () => {
    afterEach(() => { document.body.innerHTML = ""; });

    it("opening one surface should dismiss the one that was out", () => {
        const first = Symbol("first");
        const second = Symbol("second");
        const dismissed: string[] = [];
        claimExclusiveChrome(first, box(), () => dismissed.push("first"));
        claimExclusiveChrome(second, box(), () => dismissed.push("second"));
        expect(dismissed).toEqual(["first"]);
        releaseExclusiveChrome(second);
    });

    it("a surface re-claiming should not dismiss itself", () => {
        const token = Symbol("one");
        const dismissed: string[] = [];
        const el = box();
        claimExclusiveChrome(token, el, () => dismissed.push("one"));
        claimExclusiveChrome(token, el, () => dismissed.push("one"));
        expect(dismissed).toEqual([]);
        releaseExclusiveChrome(token);
    });

    /**
     * The toolbar's overflow menu can hold a dropdown of its own, so a nested
     * menu opening must not close the menu it is drawn inside and take itself
     * off the screen with it. Containment is asked of the DOM rather than
     * declared, so a menu moved into another one is correct without being told.
     */
    it("a surface inside another should not dismiss the one containing it", () => {
        const outer = Symbol("outer");
        const inner = Symbol("inner");
        const dismissed: string[] = [];
        const outerEl = box();
        const innerEl = document.createElement("div");
        outerEl.appendChild(innerEl);
        claimExclusiveChrome(outer, outerEl, () => dismissed.push("outer"));
        claimExclusiveChrome(inner, innerEl, () => dismissed.push("inner"));
        expect(dismissed).toEqual([]);
        // ...and a third, unrelated surface still sweeps both.
        const other = Symbol("other");
        claimExclusiveChrome(other, box(), () => {});
        expect(dismissed.sort()).toEqual(["inner", "outer"]);
        releaseExclusiveChrome(other);
    });

    it("a released surface should not be dismissed again", () => {
        const gone = Symbol("gone");
        const dismissed: string[] = [];
        claimExclusiveChrome(gone, box(), () => dismissed.push("gone"));
        releaseExclusiveChrome(gone);
        const next = Symbol("next");
        claimExclusiveChrome(next, box(), () => {});
        expect(dismissed).toEqual([]);
        releaseExclusiveChrome(next);
    });

    /**
     * Every close path calls its own release, so a dismiss mutating the set
     * while the set is being walked is the normal case rather than an edge
     * one. A walk over the live map would skip an entry or throw.
     */
    it("a dismiss that releases itself should not disturb the sweep", () => {
        const a = Symbol("a");
        const b = Symbol("b");
        const dismissed: string[] = [];
        claimExclusiveChrome(a, box(), () => { dismissed.push("a"); releaseExclusiveChrome(a); });
        claimExclusiveChrome(b, box(), () => { dismissed.push("b"); releaseExclusiveChrome(b); });
        // `b` claiming swept `a`; a third sweeps `b`.
        const c = Symbol("c");
        claimExclusiveChrome(c, box(), () => {});
        expect(dismissed).toEqual(["a", "b"]);
        releaseExclusiveChrome(c);
    });
});

describe("a toolbar dropdown as an exclusive surface", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        while (closeTopmostLayer()) { /* drain the shared layer stack */ }
    });
    afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

    function menu(): { wrap: HTMLElement; button: HTMLButtonElement; menu: HTMLElement } {
        const wrap = document.createElement("div");
        const button = document.createElement("button");
        const el = document.createElement("div");
        el.style.display = "none";
        wrap.append(button, el);
        document.body.appendChild(wrap);
        return { wrap, button, menu: el };
    }

    it("opening a dropdown should retract a surface that was already out", () => {
        const flyout = Symbol("flyout");
        let retracted = false;
        claimExclusiveChrome(flyout, box(), () => { retracted = true; });

        const { wrap, button, menu: el } = menu();
        wireHoverMenu(wrap, button, el);
        wrap.dispatchEvent(new MouseEvent("mouseenter"));
        vi.advanceTimersByTime(OPEN_DELAY_MS);

        // The instrument first: a menu that never opened sweeps nothing and
        // would report the same `false`.
        expect(el.style.display).toBe("flex");
        expect(retracted).toBe(true);
    });

    it("closing a dropdown should leave the set free for the next surface", () => {
        const { wrap, button, menu: el } = menu();
        wireHoverMenu(wrap, button, el);
        wrap.dispatchEvent(new MouseEvent("mouseenter"));
        vi.advanceTimersByTime(OPEN_DELAY_MS);
        wrap.dispatchEvent(new MouseEvent("mouseleave"));
        vi.advanceTimersByTime(OPEN_DELAY_MS);
        expect(el.style.display).toBe("none");

        // A later claim finds nothing to dismiss, which is what says the menu
        // released rather than leaving a dead entry behind to swallow the
        // first sweep after it.
        const later = Symbol("later");
        let sweptSomething = false;
        claimExclusiveChrome(later, box(), () => {});
        // Re-claiming with a fresh token dismisses `later` and nothing else;
        // a leaked menu entry would have been dismissed by `later` above.
        const last = Symbol("last");
        claimExclusiveChrome(last, box(), () => { sweptSomething = true; });
        expect(sweptSomething).toBe(false);
        expect(el.style.display).toBe("none");
        releaseExclusiveChrome(last);
    });
});
