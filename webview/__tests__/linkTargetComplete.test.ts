/**
 * linkTargetComplete tests: workspace file autocompletion anchored under
 * link URL inputs (the link popup's URL field and the insert-link prompt).
 * Typing posts getLinkTargetSuggestions; a reply renders a dropdown of
 * matching files in the form the user is reaching for (document-relative
 * by default, root-relative when the query starts with "/").
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import {
    attachLinkTargetComplete,
    dispatchLinkTargetSuggestions,
} from "../components/pathLink/linkTargetComplete";
import { setupLinkPopup } from "../components/linkPopup";

/** Workspace files as the Extension replies with them (both forms each). */
const ITEMS = [
    { relative: "../notion/index.md", rootRelative: "/write/notion/index.md" },
    { relative: "../anthropic/index.md", rootRelative: "/write/anthropic/index.md" },
    { relative: "assets/pic.png", rootRelative: "/write/hugo/assets/pic.png" },
];

/** All getLinkTargetSuggestions requests posted so far. */
function postedRequests(): Array<{ id: string; query: string }> {
    return mockVscodeApi.postMessage.mock.calls
        .map(([msg]) => msg as { type: string; id?: string; query?: string })
        .filter((msg) => msg.type === "getLinkTargetSuggestions")
        .map((msg) => ({ id: msg.id!, query: msg.query! }));
}

/** Sets the input's value and fires input, then waits out the 200ms debounce. */
async function type(input: HTMLInputElement, text: string): Promise<void> {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(250);
}

/** Answers the LAST posted request with the given items. */
function reply(items = ITEMS): void {
    const last = postedRequests().at(-1);
    expect(last).toBeDefined();
    dispatchLinkTargetSuggestions(last!.id, items);
}

function menuEl(): HTMLElement | null {
    return document.querySelector(".link-target-menu");
}

/** Rendered option texts, in DOM order. */
function optionTexts(): string[] {
    return Array.from(
        document.querySelectorAll(".link-target-menu .fm-suggest-item"),
    ).map((li) => li.textContent ?? "");
}

/** Dispatches a keydown on the input and returns it (for defaultPrevented). */
function press(input: HTMLInputElement, key: string): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    return ev;
}

describe("link target autocompletion — requests", () => {
    let input: HTMLInputElement;
    let detach: () => void;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        document.body.innerHTML = "";
        input = document.createElement("input");
        input.type = "text";
        document.body.appendChild(input);
        detach = attachLinkTargetComplete(input);
    });

    afterEach(() => {
        detach();
        vi.useRealTimers();
    });

    it("typing a local path fragment should post a suggestion request", async () => {
        await type(input, "notion");

        expect(postedRequests()).toEqual([{ id: expect.any(String), query: "notion" }]);
    });

    it("typing should debounce to a single request", async () => {
        input.value = "no";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(50);
        input.value = "notion";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(250);

        expect(postedRequests()).toEqual([{ id: expect.any(String), query: "notion" }]);
    });

    it("external URLs should post no request and show no menu", async () => {
        await type(input, "https://example.com/page");
        await type(input, "http://example.com");
        await type(input, "mailto:someone@example.com");
        await type(input, "#section");

        expect(postedRequests()).toEqual([]);
        expect(menuEl()).toBeNull();
    });

    it("a reply arriving after detach should not render a menu", async () => {
        await type(input, "notion");
        detach();

        reply();

        expect(menuEl()).toBeNull();
    });
});

describe("link target autocompletion — options", () => {
    let input: HTMLInputElement;
    let detach: () => void;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        document.body.innerHTML = "";
        input = document.createElement("input");
        input.type = "text";
        document.body.appendChild(input);
        detach = attachLinkTargetComplete(input);
    });

    afterEach(() => {
        detach();
        vi.useRealTimers();
    });

    it("a reply should render only options matching the typed text", async () => {
        await type(input, "notion");

        reply();

        expect(menuEl()).not.toBeNull();
        expect(optionTexts()).toEqual(["../notion/index.md"]);
    });

    it("a query starting with / should render root-relative forms", async () => {
        await type(input, "/write/not");

        reply();

        expect(optionTexts()).toEqual(["/write/notion/index.md"]);
    });

    it("markdown files should be listed before other matching files", async () => {
        await type(input, "write");

        reply();

        // All three items match "write" via their root-relative form; both
        // .md files precede the .png despite the png's shorter relative form.
        expect(optionTexts()).toEqual([
            "../notion/index.md",
            "../anthropic/index.md",
            "assets/pic.png",
        ]);
    });

    it("a stale reply should be re-filtered against the input's current value", async () => {
        await type(input, "notion");
        // The user kept typing after the request went out
        input.value = "anthropic";

        reply();

        expect(optionTexts()).toEqual(["../anthropic/index.md"]);
    });
});

describe("link target autocompletion — keyboard and closing", () => {
    let input: HTMLInputElement;
    let detach: () => void;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        document.body.innerHTML = "";
        input = document.createElement("input");
        input.type = "text";
        document.body.appendChild(input);
        detach = attachLinkTargetComplete(input);
    });

    afterEach(() => {
        detach();
        vi.useRealTimers();
    });

    it("ArrowDown + Enter should fill the input with the highlighted option", async () => {
        await type(input, "index");
        reply();

        press(input, "ArrowDown"); // highlight "../notion/index.md"
        const enter = press(input, "Enter");

        expect(enter.defaultPrevented).toBe(true);
        expect(input.value).toBe("../notion/index.md");
        expect(menuEl()).toBeNull();
    });

    it("ArrowUp should wrap the highlight to the last option", async () => {
        await type(input, "index");
        reply();

        press(input, "ArrowUp"); // wraps to "../anthropic/index.md"
        press(input, "Enter");

        expect(input.value).toBe("../anthropic/index.md");
    });

    it("Enter with no highlight should close the menu and pass through", async () => {
        await type(input, "index");
        reply();

        const enter = press(input, "Enter");

        // Not consumed: the input's own confirm handler must still run.
        expect(enter.defaultPrevented).toBe(false);
        expect(menuEl()).toBeNull();
        expect(input.value).toBe("index");
    });

    it("Escape should close the menu first; a second Escape passes through", async () => {
        await type(input, "index");
        reply();

        const first = press(input, "Escape");
        expect(first.defaultPrevented).toBe(true);
        expect(menuEl()).toBeNull();

        const second = press(input, "Escape");
        expect(second.defaultPrevented).toBe(false);
    });

    it("blur should close the menu", async () => {
        await type(input, "index");
        reply();
        expect(menuEl()).not.toBeNull();

        input.dispatchEvent(new FocusEvent("blur"));

        expect(menuEl()).toBeNull();
    });

    it("option mousedown should prevent default and fill the input", async () => {
        await type(input, "index");
        reply();

        const option = document.querySelector(
            ".link-target-menu .fm-suggest-item",
        ) as HTMLElement;
        const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        option.dispatchEvent(ev);

        expect(ev.defaultPrevented).toBe(true); // keeps focus in the input
        expect(input.value).toBe("../notion/index.md");
        expect(menuEl()).toBeNull();
    });

    it("accepting an option should not immediately re-open the menu", async () => {
        await type(input, "index");
        reply();
        press(input, "ArrowDown");
        press(input, "Enter");

        await vi.advanceTimersByTimeAsync(300);

        // Only the original request — the programmatic input event of the
        // accepted value must not trigger a new suggestion round.
        expect(postedRequests()).toHaveLength(1);
        expect(menuEl()).toBeNull();
    });
});

describe("link target autocompletion — link popup URL field wiring", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        document.body.innerHTML = '<div id="container"></div>';
        setupLinkPopup(document.getElementById("container")!, () => null);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function urlInput(): HTMLInputElement {
        return document.querySelector(".lp-url-input") as HTMLInputElement;
    }

    it("typing in the popup's URL field should post a suggestion request", async () => {
        await type(urlInput(), "../not");

        expect(postedRequests()).toEqual([{ id: expect.any(String), query: "../not" }]);
    });

    it("a reply should render the anchored menu under the popup field", async () => {
        await type(urlInput(), "notion");

        reply();

        expect(menuEl()).not.toBeNull();
        expect(optionTexts()).toEqual(["../notion/index.md"]);
    });

    it("typing an http URL in the popup field should show no menu", async () => {
        await type(urlInput(), "https://example.com");

        expect(postedRequests()).toEqual([]);
        expect(menuEl()).toBeNull();
    });

    it("ArrowDown + Enter should fill the popup's URL field", async () => {
        const input = urlInput();
        await type(input, "notion");
        reply();

        press(input, "ArrowDown");
        press(input, "Enter");

        expect(input.value).toBe("../notion/index.md");
        expect(menuEl()).toBeNull();
    });
});
