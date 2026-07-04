/**
 * linkUrlComplete tests: the caret-anchored workspace-file dropdown that
 * opens while typing inside an unclosed `[text](partial` construct in the
 * document body, driving the REAL Milkdown editor — the plugin, the shared
 * suggestion request/reply machinery and the shared menu builder are all
 * production code; only the Extension reply is simulated.
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import type { Mark } from "@milkdown/prose/model";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../serialization";
import { linkInputRule } from "../plugins/linkInputRule";
import { linkUrlCompletePlugin } from "../plugins/linkUrlComplete";
import { dispatchLinkTargetSuggestions } from "../components/pathLink/linkTargetComplete";

/** Workspace files as the Extension replies with them (both forms each). */
const ITEMS = [
    { relative: "../notion/index.md", rootRelative: "/write/notion/index.md" },
    { relative: "../anthropic/index.md", rootRelative: "/write/anthropic/index.md" },
    { relative: "assets/pic.png", rootRelative: "/write/hugo/assets/pic.png" },
];

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfm)
        .use(linkInputRule)
        .use(linkUrlCompletePlugin)
        .create();
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Place the text cursor at the very end of the doc's n-th top-level block. */
function placeCursorAtEndOfBlock(v: EditorView, n: number): void {
    const { state } = v;
    let pos = 0;
    for (let i = 0; i < n; i++) pos += state.doc.child(i).nodeSize;
    const endOfText = pos + state.doc.child(n).nodeSize - 1;
    v.dispatch(state.tr.setSelection(TextSelection.create(state.doc, endOfText)));
}

/** Insert text at the caret (each dispatch re-runs the plugin's update). */
function typeText(v: EditorView, text: string): void {
    const { from, to } = v.state.selection;
    v.dispatch(v.state.tr.insertText(text, from, to));
}

/** All getLinkTargetSuggestions requests posted so far. */
function postedRequests(): Array<{ id: string; query: string }> {
    return mockVscodeApi.postMessage.mock.calls
        .map(([msg]) => msg as { type: string; id?: string; query?: string })
        .filter((msg) => msg.type === "getLinkTargetSuggestions")
        .map((msg) => ({ id: msg.id!, query: msg.query! }));
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

/**
 * Dispatches a keydown on a node INSIDE the editor content (like real typing
 * does), so the plugin's capture-phase listener on the editor root runs
 * before ProseMirror's own handlers. Returns the event.
 */
function press(v: EditorView, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const target = v.dom.firstElementChild ?? v.dom;
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev;
}

/** All [text, href] pairs of link-marked text nodes in the document. */
function linkedTexts(v: EditorView): Array<{ text: string; href: string }> {
    const found: Array<{ text: string; href: string }> = [];
    v.state.doc.descendants((node) => {
        if (!node.isText) return;
        const link = node.marks.find((m: Mark) => m.type.name === "link");
        if (link) {
            found.push({ text: node.text ?? "", href: link.attrs["href"] as string });
        }
    });
    return found;
}

describe("caret link URL autocompletion", () => {
    let editor: Editor;
    let v: EditorView;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor("x\n");
        v = view(editor);
        placeCursorAtEndOfBlock(v, 0);
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    it("typing [n](../not should request suggestions and open the menu on the reply", async () => {
        // Act
        typeText(v, "[n](../not");
        await vi.advanceTimersByTimeAsync(250);
        reply();

        // Assert
        expect(postedRequests()).toEqual([{ id: expect.any(String), query: "../not" }]);
        expect(menuEl()).not.toBeNull();
        expect(optionTexts()).toEqual(["../notion/index.md"]);
    });

    it("typing should debounce to a single request", async () => {
        typeText(v, "[n](../n");
        await vi.advanceTimersByTimeAsync(50);
        typeText(v, "ot");
        await vi.advanceTimersByTimeAsync(250);

        expect(postedRequests()).toEqual([{ id: expect.any(String), query: "../not" }]);
    });

    it("ArrowDown + Enter should convert the construct into a real link", async () => {
        // Arrange
        typeText(v, "[n](../not");
        await vi.advanceTimersByTimeAsync(250);
        reply();

        // Act — highlight the only option and accept it
        press(v, "ArrowDown");
        const enter = press(v, "Enter");

        // Assert — the pick applied the same conversion the ")" input rule does
        expect(enter.defaultPrevented).toBe(true);
        expect(menuEl()).toBeNull();
        expect(v.state.doc.textContent).toBe("xn");
        expect(linkedTexts(v)).toEqual([
            { text: "n", href: "../notion/index.md" },
        ]);
        expect(editor.action(getMarkdown())).toContain("[n](../notion/index.md)");
    });

    it("ArrowUp should wrap the highlight to the last option", async () => {
        typeText(v, "[n](index");
        await vi.advanceTimersByTimeAsync(250);
        reply();
        expect(optionTexts()).toEqual([
            "../notion/index.md",
            "../anthropic/index.md",
        ]);

        press(v, "ArrowUp"); // wraps to the last option
        press(v, "Enter");

        expect(linkedTexts(v)).toEqual([
            { text: "n", href: "../anthropic/index.md" },
        ]);
    });

    it("Enter with no highlight should close the menu and not be consumed", async () => {
        typeText(v, "[n](../not");
        await vi.advanceTimersByTimeAsync(250);
        reply();
        expect(menuEl()).not.toBeNull();

        press(v, "Enter");

        // The menu closes and nothing is converted; the key stays available
        // to ProseMirror's own keymaps (normal Enter handling).
        expect(menuEl()).toBeNull();
        expect(linkedTexts(v)).toEqual([]);
    });

    it("Escape should close the menu and keep it closed while typing in the same construct", async () => {
        // Arrange — menu open
        typeText(v, "[n](../not");
        await vi.advanceTimersByTimeAsync(250);
        reply();
        expect(menuEl()).not.toBeNull();

        // Act — dismiss, then keep typing inside the same construct
        const esc = press(v, "Escape");
        expect(esc.defaultPrevented).toBe(true);
        expect(menuEl()).toBeNull();
        typeText(v, "io");
        await vi.advanceTimersByTimeAsync(300);

        // Assert — no new request, no menu, while the context is unchanged
        expect(postedRequests()).toHaveLength(1);
        expect(menuEl()).toBeNull();
    });

    it("leaving the construct after Escape should lift the dismissal", async () => {
        // Arrange — dismissed menu
        typeText(v, "[n](../not");
        await vi.advanceTimersByTimeAsync(250);
        reply();
        press(v, "Escape");

        // Act — move the caret out of the construct, then back to its end
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 2)));
        placeCursorAtEndOfBlock(v, 0);
        await vi.advanceTimersByTimeAsync(250);

        // Assert — the context changed, so suggestions flow again
        expect(postedRequests()).toHaveLength(2);
        reply();
        expect(menuEl()).not.toBeNull();
    });

    it("a reply arriving after Escape closed the menu should not re-open it", async () => {
        typeText(v, "[n](../not");
        await vi.advanceTimersByTimeAsync(250);
        reply();
        expect(menuEl()).not.toBeNull();
        typeText(v, "i"); // newer request goes out while the menu is open
        await vi.advanceTimersByTimeAsync(250);
        press(v, "Escape"); // dismissed before that reply lands

        reply(); // answers the post-close request

        expect(menuEl()).toBeNull();
    });

    it("http/https/mailto/#anchor partials should never request or show a menu", async () => {
        for (const url of ["https://example.com", "http://x", "mailto:a@b.c", "#sec"]) {
            typeText(v, `[n](${url}`);
            await vi.advanceTimersByTimeAsync(300);
            // Reset the paragraph for the next partial
            placeCursorAtEndOfBlock(v, 0);
            const end = v.state.selection.from;
            v.dispatch(v.state.tr.delete(end - url.length - 4, end));
        }

        expect(postedRequests()).toEqual([]);
        expect(menuEl()).toBeNull();
    });

    it("keydown during IME composition should not be intercepted", async () => {
        typeText(v, "[n](../not");
        await vi.advanceTimersByTimeAsync(250);
        reply();
        expect(menuEl()).not.toBeNull();

        const esc = press(v, "Escape", { isComposing: true } as KeyboardEventInit);

        expect(esc.defaultPrevented).toBe(false);
        expect(menuEl()).not.toBeNull();
    });

    it("blur should close the menu", async () => {
        typeText(v, "[n](../not");
        await vi.advanceTimersByTimeAsync(250);
        reply();
        expect(menuEl()).not.toBeNull();

        v.dom.dispatchEvent(new FocusEvent("blur"));

        expect(menuEl()).toBeNull();
    });

    it("a stale reply should be re-ranked against the current partial url", async () => {
        typeText(v, "[n](index");
        await vi.advanceTimersByTimeAsync(250);
        // The user kept typing after the request went out
        typeText(v, "x"); // partial is now "indexx" — matches nothing

        reply();

        expect(menuEl()).toBeNull();
    });

    it("typing inside inline code should never open the menu", async () => {
        await editor.destroy();
        vi.useRealTimers(); // editor creation must not depend on fake timers
        editor = await makeEditor("`code`\n");
        vi.useFakeTimers();
        v = view(editor);
        // Caret in the middle of the inline code span ("co|de"), so both the
        // caret marks and the text typed at it carry the code mark
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 3)));

        typeText(v, "[n](../not");
        await vi.advanceTimersByTimeAsync(300);

        expect(postedRequests()).toEqual([]);
        expect(menuEl()).toBeNull();
    });
});
