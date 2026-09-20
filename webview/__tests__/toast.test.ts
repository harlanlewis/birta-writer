/**
 * The shared transient-message surface (ui/toast.ts).
 *
 * Three of these checks are about things that are invisible when they break.
 * A toast that built a fresh node per message would look identical in a
 * screenshot and leave a stack of pills in the DOM. A tone that is set and
 * never cleared shows the NEXT message in red. And the clear-then-set is what
 * makes a repeated message reach a screen reader at all, which nothing about
 * the rendered page can tell you.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { hide, showToast } from "../ui/toast";

const SURFACE = "test-toast";
const OTHER = "test-toast-other";

function nodes(surface = SURFACE): Element[] {
    return [...document.querySelectorAll(`.${surface}`)];
}

describe("showToast", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        document.body.innerHTML = "";
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("two messages on one surface should share a single element", () => {
        showToast("first", { surface: SURFACE });
        showToast("second", { surface: SURFACE });

        expect(nodes()).toHaveLength(1);
        expect(nodes()[0].textContent).toBe("second");
    });

    it("two surfaces should each get their own element", () => {
        showToast("here", { surface: SURFACE });
        showToast("there", { surface: OTHER });

        expect(nodes()).toHaveLength(1);
        expect(nodes(OTHER)).toHaveLength(1);
        expect(nodes(OTHER)[0].textContent).toBe("there");
    });

    it("a message the surface is already showing should still be re-announced", async () => {
        const el = showToast("same", { surface: SURFACE })!;
        // A live region announces on CHANGE, so the write has to pass through
        // empty. Watched rather than inferred: the end state is identical
        // either way, which is exactly why this can be lost silently.
        // Read from the RECORDS rather than from the node at delivery time:
        // the observer fires once, after both writes, so the node already
        // says "same" whether or not it ever passed through empty.
        const steps: string[] = [];
        const observer = new MutationObserver((records) => {
            for (const record of records) {
                if (record.removedNodes.length > 0) { steps.push("cleared"); }
                if (record.addedNodes.length > 0) { steps.push("set"); }
            }
        });
        observer.observe(el, { childList: true, characterData: true, subtree: true });

        showToast("same", { surface: SURFACE });
        await Promise.resolve();
        observer.disconnect();

        expect(steps).toEqual(["cleared", "set"]);
        expect(el.textContent).toBe("same");
    });

    it("a message should take itself off after its dwell", () => {
        showToast("gone soon", { surface: SURFACE, dwellMs: 1000 });
        expect(nodes()[0].classList.contains(`${SURFACE}--visible`)).toBe(true);

        vi.advanceTimersByTime(1001);

        expect(nodes()[0].classList.contains(`${SURFACE}--visible`)).toBe(false);
        // The node stays for the next message; only the message goes.
        expect(nodes()).toHaveLength(1);
    });

    it("a second message should restart the dwell rather than inherit it", () => {
        showToast("first", { surface: SURFACE, dwellMs: 1000 });
        vi.advanceTimersByTime(900);
        showToast("second", { surface: SURFACE, dwellMs: 1000 });

        vi.advanceTimersByTime(200);

        expect(nodes()[0].classList.contains(`${SURFACE}--visible`)).toBe(true);
    });

    it("an ordinary message after an error should not stay in the error ink", () => {
        showToast("broke", { surface: SURFACE, tone: "error" });
        expect(nodes()[0].classList.contains("ui-notice--error")).toBe(true);

        showToast("fine", { surface: SURFACE });

        expect(nodes()[0].classList.contains("ui-notice--error")).toBe(false);
    });

    it("a click on a dismissible message should take it away early", () => {
        showToast("click me", { surface: SURFACE, dwellMs: 10_000, dismissible: true });

        nodes()[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        expect(nodes()[0].classList.contains(`${SURFACE}--visible`)).toBe(false);
    });

    it("a click on a message that is not dismissible should leave it alone", () => {
        showToast("read me", { surface: SURFACE, dwellMs: 10_000 });

        nodes()[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        expect(nodes()[0].classList.contains(`${SURFACE}--visible`)).toBe(true);
    });

    it("a persisting message should stay until its owner takes it away", () => {
        showToast("still going", { surface: SURFACE, persist: true });

        // Well past any dwell it could have inherited. What it reports is
        // still happening, so nothing but its owner may end it.
        vi.advanceTimersByTime(60_000);
        expect(nodes()[0].classList.contains(`${SURFACE}--visible`)).toBe(true);

        hide(SURFACE);
        expect(nodes()[0].classList.contains(`${SURFACE}--visible`)).toBe(false);
    });

    it("a message after a persisting one should go back to fading", () => {
        showToast("still going", { surface: SURFACE, persist: true });
        showToast("news", { surface: SURFACE, dwellMs: 1000 });

        vi.advanceTimersByTime(1001);

        // The node outlives the message, so persist has to be read per call
        // or the surface's first message decides for every one after it.
        expect(nodes()[0].classList.contains(`${SURFACE}--visible`)).toBe(false);
    });

    it("a message should announce unless its caller says otherwise", () => {
        showToast("quiet", { surface: SURFACE, announce: false });
        expect(nodes()[0].getAttribute("aria-live")).toBe("off");

        showToast("out loud", { surface: SURFACE });

        expect(nodes()[0].getAttribute("aria-live")).toBe("polite");
    });

    it("a message a click cannot take away should not take the click", () => {
        showToast("read me", { surface: SURFACE });
        expect(nodes()[0].classList.contains("ui-notice--static")).toBe(true);

        showToast("click me", { surface: SURFACE, dismissible: true });

        // Whether the corner under it belongs to the message or to the page
        // is the same question as whether a click does anything, so the two
        // are read off one option rather than set independently.
        expect(nodes()[0].classList.contains("ui-notice--static")).toBe(false);
    });

    it("a surface whose element was removed should be rebuilt rather than lost", () => {
        showToast("first", { surface: SURFACE });
        nodes()[0].remove();

        showToast("second", { surface: SURFACE });

        expect(nodes()).toHaveLength(1);
        expect(nodes()[0].textContent).toBe("second");
    });

    it("hiding a surface nothing has shown should not throw", () => {
        expect(() => hide("never-shown")).not.toThrow();
    });
});
