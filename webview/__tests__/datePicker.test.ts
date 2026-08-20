/**
 * The one thing about the calendar's placement that jsdom CAN answer, and that
 * the browser suite could not reach.
 *
 * `e2e/datePicker` covers the keyboard, the focus return and the ordinary
 * placement, but it could not push the caret far enough below the viewport to
 * exercise the case below: the fixture would have to be scrolled further than
 * its own height allows. jsdom has no layout, which is normally what makes it
 * useless for placement, and here is exactly what makes this work: with every
 * measured size reported as zero, the arithmetic is all that is left, and the
 * arithmetic is the thing under test.
 *
 * The case: `computeAnchoredPosition` clamps `left`, and clamps `top` only from
 * above. Its flip-up branch returns `anchor.top - gap - height`, so a caret
 * scrolled below the viewport yields a coordinate off the bottom of the screen
 * (an anchor at 1500 in an 800px viewport returns 1248). Every other consumer
 * is spared that number by hiding when the anchor leaves view. This one keeps
 * itself open on purpose, because it holds keyboard focus, so it owes the
 * clamp: an unclamped popup here is invisible while still trapping Tab.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openDatePicker } from "../components/datePicker";

const TODAY = { year: 2026, month: 8, day: 20 };

function content(): HTMLElement {
    const el = document.createElement("div");
    document.body.appendChild(el);
    return el;
}

describe("the calendar's placement", () => {
    afterEach(() => {
        document.querySelectorAll(".date-picker").forEach((el) => el.remove());
        document.body.textContent = "";
    });

    it("an anchor below the viewport should still place the popup on screen", () => {
        openDatePicker({
            content: content(),
            // Far below the bottom edge: the caret has been scrolled past.
            anchor: () => ({ left: 100, top: 1500, bottom: 1516 }),
            today: TODAY,
            onPick: () => {},
            onClose: () => {},
            locale: "en-US",
        });

        const root = document.querySelector<HTMLElement>(".date-picker");
        expect(root, "the picker did not open").not.toBeNull();
        const top = Number.parseFloat(root!.style.top);
        expect(Number.isFinite(top), root!.style.top).toBe(true);
        expect(top, "the popup was placed below the bottom of the window")
            .toBeLessThanOrEqual(window.innerHeight);
        expect(top, "the popup was placed above the top of the window")
            .toBeGreaterThanOrEqual(0);
    });

    it("an anchor above the viewport should not place the popup off the top", () => {
        openDatePicker({
            content: content(),
            anchor: () => ({ left: 100, top: -900, bottom: -884 }),
            today: TODAY,
            onPick: () => {},
            onClose: () => {},
            locale: "en-US",
        });

        const root = document.querySelector<HTMLElement>(".date-picker");
        const top = Number.parseFloat(root!.style.top);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(top).toBeLessThanOrEqual(window.innerHeight);
    });

    it("an ordinary anchor should be left where the placement put it", () => {
        // The clamp must not become the placement. Without this, returning a
        // constant would satisfy both arms above.
        openDatePicker({
            content: content(),
            anchor: () => ({ left: 100, top: 200, bottom: 216 }),
            today: TODAY,
            onPick: () => {},
            onClose: () => {},
            locale: "en-US",
        });

        const root = document.querySelector<HTMLElement>(".date-picker");
        const top = Number.parseFloat(root!.style.top);
        // Below the caret, by the placement's own gap, and nowhere near either
        // clamp bound.
        expect(top).toBeGreaterThan(216);
        expect(top).toBeLessThan(window.innerHeight);
    });
});
