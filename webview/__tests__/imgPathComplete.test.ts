/**
 * imgPathComplete tests: the image-path autocomplete attached to the image
 * toolbar's path field.
 *
 * Like pathComplete this module had ZERO coverage until MAR-220. The cases
 * below pin the behaviors it had drifted on — the missing `ui-menu-row`
 * primitive, the never-clamped placement, and a reply that could re-open a
 * dropdown the user had already dismissed — alongside the ones it got right
 * (the IME guard) so they cannot regress on the way through the shared shell.
 *
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import {
    attachImgPathComplete,
    dispatchImgPathSuggestions,
} from "../components/imageView/imgPathComplete";
import type { PathSuggestionItem } from "../../shared/messages";

const URI = "https://vscode.test/img/cats.jpeg";

const ITEMS: PathSuggestionItem[] = [
    { path: "img/nested/", isDir: true },
    { path: "img/cats.jpeg", isDir: false, webviewUri: URI },
    { path: "img/readme.md", isDir: false }, // not an image → filtered out
];

function domRect(r: Partial<DOMRect>): DOMRect {
    return {
        top: 0, bottom: 0, left: 0, right: 0,
        width: 0, height: 0, x: 0, y: 0,
        toJSON: () => ({}),
        ...r,
    } as DOMRect;
}

/** All getPathSuggestions requests posted so far. */
function postedRequests(): Array<{ id: string; query: string }> {
    return mockVscodeApi.postMessage.mock.calls
        .map(([msg]) => msg as { type: string; id?: string; query?: string })
        .filter((msg) => msg.type === "getPathSuggestions")
        .map((msg) => ({ id: msg.id!, query: msg.query! }));
}

function menuEl(): HTMLElement | null {
    return document.querySelector(".img-path-complete-menu");
}

function rowEls(): HTMLElement[] {
    return Array.from(document.querySelectorAll(".img-path-complete-menu li"));
}

describe("image path autocompletion", () => {
    let input: HTMLInputElement;
    let detach: () => void;
    let onEnter: ReturnType<typeof vi.fn>;
    let onEscape: ReturnType<typeof vi.fn>;

    /** Sets the input's value, fires input, and waits out the debounce. */
    async function type(text: string): Promise<void> {
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(250);
    }

    /** Answers the LAST posted request. */
    function reply(items = ITEMS): void {
        const last = postedRequests().at(-1);
        expect(last).toBeDefined();
        dispatchImgPathSuggestions(last!.id, items);
    }

    /** Dispatches a keydown on the input and returns it. */
    function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
        const ev = new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
            ...init,
        });
        input.dispatchEvent(ev);
        return ev;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        document.body.innerHTML = "";
        input = document.createElement("input");
        input.type = "text";
        document.body.appendChild(input);
        onEnter = vi.fn();
        onEscape = vi.fn();
        detach = attachImgPathComplete(input, onEnter, onEscape);
    });

    afterEach(() => {
        detach();
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    it("typing a path prefix should post a suggestion request", async () => {
        await type("img/");

        expect(postedRequests()).toHaveLength(1);
        expect(postedRequests()[0].query).toBe("img/");
    });

    it("text that is not a path prefix should post no request", async () => {
        await type("https://example.com/a.png");

        expect(postedRequests()).toHaveLength(0);
    });

    it("a reply should render the dropdown with the first row highlighted", async () => {
        await type("img/");

        reply();

        expect(menuEl()).not.toBeNull();
        expect(rowEls()[0].classList.contains("fm-suggest-item--focused")).toBe(true);
    });

    it("only directories and image files should be listed", async () => {
        await type("img/");
        reply();

        expect(rowEls().map((li) => li.title)).toEqual([
            "img/nested/",
            "img/cats.jpeg",
        ]);
    });

    it("rendered rows should compose the ui-menu-row primitive", async () => {
        await type("img/");
        reply();

        for (const li of rowEls()) {
            expect(li.classList.contains("ui-menu-row")).toBe(true);
            expect(li.classList.contains("fm-suggest-item")).toBe(true);
        }
    });

    it("an image row should render a thumbnail and a directory row a file icon", async () => {
        await type("img/");
        reply();

        const [dirRow, imgRow] = rowEls();
        expect(dirRow.querySelector("img.img-complete-thumb")).toBeNull();
        expect(dirRow.querySelector(".img-complete-icon svg")).not.toBeNull();

        const thumb = imgRow.querySelector("img.img-complete-thumb") as HTMLImageElement;
        expect(thumb).not.toBeNull();
        expect(thumb.getAttribute("src")).toBe(URI);
        expect(thumb.alt).toBe("");
    });

    it("a row should show only the last path segment and title the full path", async () => {
        await type("img/");
        reply();

        expect(rowEls()[1].textContent).toBe("cats.jpeg");
        expect(rowEls()[1].title).toBe("img/cats.jpeg");
    });

    // ── Keyboard ────────────────────────────────────────────────

    it("Enter on the highlighted row should fill the field and record its webviewUri", async () => {
        await type("img/");
        reply();

        // Arrow keys move the highlight only — the field is untouched until
        // the row is actually accepted.
        press("ArrowDown"); // move to the image row
        expect(input.value).toBe("img/");
        expect(input.dataset.imgWebviewUri).toBeUndefined();

        press("Enter");

        expect(input.value).toBe("img/cats.jpeg");
        expect(input.dataset.imgWebviewUri).toBe(URI);
        expect(menuEl()).toBeNull();
        expect(onEnter).not.toHaveBeenCalled();
    });

    it("Enter with the dropdown closed should delegate to the confirm callback", () => {
        press("Enter");

        expect(onEnter).toHaveBeenCalledTimes(1);
    });

    it("Escape should close the dropdown first, then delegate to cancel", async () => {
        await type("img/");
        reply();

        press("Escape");
        expect(menuEl()).toBeNull();
        expect(onEscape).not.toHaveBeenCalled();

        press("Escape");
        expect(onEscape).toHaveBeenCalledTimes(1);
    });

    it("a keydown during IME composition should not be intercepted", async () => {
        await type("img/");
        reply();

        for (const key of ["Enter", "ArrowDown", "ArrowUp", "Escape", "Tab"]) {
            const ev = press(key, { isComposing: true });
            expect(ev.defaultPrevented, `${key} during composition`).toBe(false);
        }
        expect(menuEl()).not.toBeNull();
        expect(onEnter).not.toHaveBeenCalled();
        expect(onEscape).not.toHaveBeenCalled();
    });

    it("a mouseover right after keyboard navigation should not steal the highlight", async () => {
        await type("img/");
        reply();

        press("ArrowDown"); // highlight row 1, pointer parked on row 0
        rowEls()[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

        expect(rowEls()[1].classList.contains("fm-suggest-item--focused")).toBe(true);
        expect(rowEls()[0].classList.contains("fm-suggest-item--focused")).toBe(false);
    });

    // ── Stale replies ───────────────────────────────────────────

    it("a reply arriving after Escape dismissed the dropdown should not re-open it", async () => {
        await type("img/");
        reply();
        expect(menuEl()).not.toBeNull();

        // The user keeps typing (a second request goes out), then dismisses.
        await type("img/c");
        press("Escape");
        expect(menuEl()).toBeNull();

        reply(); // the in-flight reply lands after the dismissal

        expect(menuEl()).toBeNull();
    });

    it("a reply arriving after blur should not re-open the dropdown", async () => {
        await type("img/");
        input.dispatchEvent(new Event("blur", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(200); // the 150ms close delay

        reply();

        expect(menuEl()).toBeNull();
    });

    it("Escape with no dropdown should still cancel and drop an in-flight reply", async () => {
        await type("img/");

        press("Escape");
        expect(onEscape).toHaveBeenCalledTimes(1);

        reply();

        expect(menuEl()).toBeNull();
    });

    it("a reply arriving after detach should not open a dropdown", async () => {
        await type("img/");
        detach();

        reply();

        expect(menuEl()).toBeNull();
    });

    // ── Viewport placement (jsdom innerHeight = 768) ────────────

    it("with room below the dropdown should sit under the field", async () => {
        vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
            function (this: Element) {
                return this === input
                    ? domRect({ top: 100, bottom: 120, left: 10, width: 240 })
                    : domRect({ height: 200 });
            },
        );

        await type("img/");
        reply();

        expect(menuEl()!.style.top).toBe("122px");
        expect(menuEl()!.style.minWidth).toBe("240px");
    });

    it("a dropdown near the viewport bottom should flip above the field", async () => {
        vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
            function (this: Element) {
                return this === input
                    ? domRect({ top: 730, bottom: 750, left: 10, width: 240 })
                    : domRect({ height: 200 });
            },
        );

        await type("img/");
        reply();

        // Below would span 752..952 (> 768); flipped bottom edge sits at 728.
        expect(menuEl()!.style.top).toBe("528px");
    });

    it("detach should close an open dropdown and release its keys", async () => {
        await type("img/");
        reply();
        expect(menuEl()).not.toBeNull();

        detach();

        expect(menuEl()).toBeNull();
        press("Enter");
        expect(onEnter).not.toHaveBeenCalled();
    });
});
