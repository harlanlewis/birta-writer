/**
 * pathComplete tests: the inline-code path autocomplete (typing `img/` inside
 * an inline `code` span offers workspace paths).
 *
 * This module had ZERO coverage until MAR-220, which is precisely how it
 * drifted away from its two siblings: no IME guard, no viewport flip, and
 * document-level listeners that were never detached. The cases below pin all
 * three, plus the shared-shell contract (ui-menu-row rows, initial highlight).
 *
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import {
    dispatchPathSuggestions,
    initPathComplete,
} from "../components/pathLink/pathComplete";
import type { PathSuggestionItem } from "../../shared/messages";

const ITEMS: PathSuggestionItem[] = [
    { path: "img/", isDir: true },
    { path: "img/cats.jpeg", isDir: false },
    { path: "notes.md", isDir: false },
];

function domRect(r: Partial<DOMRect>): DOMRect {
    return {
        top: 0, bottom: 0, left: 0, right: 0,
        width: 0, height: 0, x: 0, y: 0,
        toJSON: () => ({}),
        ...r,
    } as DOMRect;
}

/** Renders an inline `code` span and puts the caret inside it. */
function placeCaretInCode(text = "img/"): HTMLElement {
    document.body.innerHTML = `<div class="milkdown"><p><code>${text}</code></p></div>`;
    const code = document.querySelector("code") as HTMLElement;
    const range = document.createRange();
    range.setStart(code.firstChild!, text.length);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return code;
}

/** All getPathSuggestions requests posted so far. */
function postedRequests(): Array<{ id: string; query: string }> {
    return mockVscodeApi.postMessage.mock.calls
        .map(([msg]) => msg as { type: string; id?: string; query?: string })
        .filter((msg) => msg.type === "getPathSuggestions")
        .map((msg) => ({ id: msg.id!, query: msg.query! }));
}

/** Fires the trigger keyup and waits out the 200ms debounce. */
async function typeInCode(): Promise<void> {
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "/", bubbles: true }));
    await vi.advanceTimersByTimeAsync(250);
}

/** Answers the LAST posted request. */
function reply(items = ITEMS): void {
    const last = postedRequests().at(-1);
    expect(last).toBeDefined();
    dispatchPathSuggestions(last!.id, items);
}

function menuEl(): HTMLElement | null {
    return document.querySelector(".path-complete-menu");
}

function rowEls(): HTMLElement[] {
    return Array.from(document.querySelectorAll(".path-complete-menu li"));
}

/** Dispatches a keydown on document and returns it (for defaultPrevented). */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
    });
    document.dispatchEvent(ev);
    return ev;
}

describe("inline-code path autocompletion", () => {
    let detach: () => void;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        document.body.innerHTML = "";
        detach = initPathComplete(() => null);
    });

    afterEach(() => {
        detach?.();
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    it("typing a path prefix inside inline code should post a suggestion request", async () => {
        placeCaretInCode();

        await typeInCode();

        expect(postedRequests()).toHaveLength(1);
        expect(postedRequests()[0].query).toBe("img/");
    });

    it("a reply should render the dropdown with the first row highlighted", async () => {
        placeCaretInCode();
        await typeInCode();

        reply();

        expect(menuEl()).not.toBeNull();
        expect(rowEls()).toHaveLength(3);
        expect(rowEls()[0].classList.contains("fm-suggest-item--focused")).toBe(true);
        expect(rowEls()[1].classList.contains("fm-suggest-item--focused")).toBe(false);
    });

    it("rendered rows should compose the ui-menu-row primitive", async () => {
        placeCaretInCode();
        await typeInCode();
        reply();

        for (const li of rowEls()) {
            expect(li.classList.contains("ui-menu-row")).toBe(true);
            expect(li.classList.contains("fm-suggest-item")).toBe(true);
        }
    });

    it("a row should show only the last path segment and title the full path", async () => {
        placeCaretInCode();
        await typeInCode();
        reply();

        expect(rowEls()[1].textContent).toBe("cats.jpeg");
        expect(rowEls()[1].title).toBe("img/cats.jpeg");
    });

    it("text that is not a path prefix should post no request", async () => {
        placeCaretInCode("hello");

        await typeInCode();

        expect(postedRequests()).toHaveLength(0);
        expect(menuEl()).toBeNull();
    });

    // ── The MAR-220 headline bug: no IME guard ──────────────────
    // The listener is on `document` in the CAPTURE phase, so without the
    // guard a CJK candidate-window Enter or arrow key is swallowed from the
    // whole editor whenever the dropdown happens to be open.

    it("a keydown during IME composition should not be intercepted", async () => {
        placeCaretInCode();
        await typeInCode();
        reply();

        for (const key of ["Enter", "ArrowDown", "ArrowUp", "Escape", "Tab"]) {
            const ev = press(key, { isComposing: true });
            expect(ev.defaultPrevented, `${key} during composition`).toBe(false);
        }
        // The menu is untouched by a composition keystroke.
        expect(menuEl()).not.toBeNull();
    });

    it("the same keys outside composition should still be consumed", async () => {
        placeCaretInCode();
        await typeInCode();
        reply();

        expect(press("ArrowDown").defaultPrevented).toBe(true);
        expect(press("ArrowUp").defaultPrevented).toBe(true);
        expect(press("Escape").defaultPrevented).toBe(true);
        expect(menuEl()).toBeNull();
    });

    it("with no dropdown open no key should be intercepted", () => {
        expect(press("ArrowDown").defaultPrevented).toBe(false);
        expect(press("Escape").defaultPrevented).toBe(false);
    });

    it("ArrowDown should move the highlight and wrap at the end", async () => {
        placeCaretInCode();
        await typeInCode();
        reply();

        press("ArrowDown");
        expect(rowEls()[1].classList.contains("fm-suggest-item--focused")).toBe(true);
        press("ArrowDown");
        press("ArrowDown");
        expect(rowEls()[0].classList.contains("fm-suggest-item--focused")).toBe(true);
    });

    it("a mouseover right after keyboard navigation should not steal the highlight", async () => {
        placeCaretInCode();
        await typeInCode();
        reply();

        press("ArrowDown"); // highlight row 1, pointer parked on row 2
        rowEls()[2].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

        expect(rowEls()[1].classList.contains("fm-suggest-item--focused")).toBe(true);
        expect(rowEls()[2].classList.contains("fm-suggest-item--focused")).toBe(false);

        // A real pointer move lifts the guard.
        rowEls()[2].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
        rowEls()[2].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        expect(rowEls()[2].classList.contains("fm-suggest-item--focused")).toBe(true);
    });

    // ── Viewport placement (jsdom innerHeight = 768) ────────────

    it("with room below the dropdown should sit under the code span", async () => {
        const code = placeCaretInCode();
        vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
            function (this: Element) {
                return this === code
                    ? domRect({ top: 100, bottom: 120, left: 10, width: 40 })
                    : domRect({ height: 200 });
            },
        );

        await typeInCode();
        reply();

        expect(menuEl()!.style.top).toBe("122px");
    });

    it("a dropdown near the viewport bottom should flip above the code span", async () => {
        const code = placeCaretInCode();
        vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
            function (this: Element) {
                return this === code
                    ? domRect({ top: 730, bottom: 750, left: 10, width: 40 })
                    : domRect({ height: 200 });
            },
        );

        await typeInCode();
        reply();

        // Below would span 752..952 (> 768); flipped bottom edge sits at 728.
        expect(menuEl()!.style.top).toBe("528px");
    });

    // ── Teardown (the "never detached" comment) ─────────────────

    it("detach should stop the document listeners from opening a dropdown", async () => {
        placeCaretInCode();

        detach();

        await typeInCode();
        expect(postedRequests()).toHaveLength(0);
        expect(menuEl()).toBeNull();
    });

    it("detach should close an open dropdown and release its keys", async () => {
        placeCaretInCode();
        await typeInCode();
        reply();
        expect(menuEl()).not.toBeNull();

        detach();

        expect(menuEl()).toBeNull();
        expect(press("ArrowDown").defaultPrevented).toBe(false);
    });

    it("a reply arriving after the caret left the code span should not open a dropdown", async () => {
        placeCaretInCode();
        await typeInCode();

        // Caret moves out of the inline code before the reply lands.
        document.body.innerHTML = "<p>elsewhere</p>";
        reply();

        expect(menuEl()).toBeNull();
    });
});
