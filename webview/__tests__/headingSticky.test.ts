/**
 * Tests for the sticky heading's gutter DOM contract (plugins/headingSticky):
 * the H-badge is a functional block handle — a real button that opens the
 * block menu for the live heading position — not a display-only span. The
 * scroll-driven positioning itself needs real layout and is covered by the
 * e2e harness, not jsdom.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import { setStickyContent } from "../plugins/headingSticky";
import { setBlockMenuContext, closeBlockMenu } from "../components/blockMenu";

let editors: Editor[] = [];
let activeEditor: Editor | null = null;

setBlockMenuContext({ getEditor: () => activeEditor });

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfm)
        .use(headingFoldPlugin)
        .create();
    editors.push(editor);
    activeEditor = editor;
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** First heading's node position in a doc that starts with a heading. */
const FIRST_HEADING_POS = 0;

function makeSticky(editorView: EditorView, headingPos: number): HTMLElement {
    const sticky = document.createElement("div");
    sticky.className = "heading-sticky-title";
    sticky.dataset["headingPos"] = String(headingPos);
    document.body.appendChild(sticky);
    const heading = editorView.nodeDOM(headingPos) as HTMLElement;
    setStickyContent(sticky, editorView, heading, headingPos, false, true);
    return sticky;
}

afterEach(() => {
    closeBlockMenu();
    for (const editor of editors) {
        void editor.destroy();
    }
    editors = [];
    activeEditor = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
});

describe("sticky heading gutter", () => {
    it("a sticky heading should render its badge as a block-handle button", async () => {
        const editor = await makeEditor("## Section\n\nBody text.");
        const sticky = makeSticky(view(editor), FIRST_HEADING_POS);

        const marker = sticky.querySelector(".heading-sticky-marker");
        expect(marker).toBeInstanceOf(HTMLButtonElement);
        expect(marker?.textContent).toBe("H2");
        expect(marker?.getAttribute("aria-haspopup")).toBe("menu");
        expect(marker?.getAttribute("aria-label")).toContain("Block options");
        expect(marker?.getAttribute("aria-expanded")).toBe("false");
    });

    it("clicking the sticky badge should open the block menu anchored to it", async () => {
        const editor = await makeEditor("## Section\n\nBody text.");
        const sticky = makeSticky(view(editor), FIRST_HEADING_POS);
        const marker = sticky.querySelector<HTMLButtonElement>(".heading-sticky-marker");

        marker?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));

        expect(document.querySelector(".block-menu")).not.toBeNull();
        expect(marker?.classList.contains("heading-fold-marker--menu-open")).toBe(true);
        expect(marker?.getAttribute("aria-expanded")).toBe("true");
    });

    it("the sticky badge click should derive the heading position from data-heading-pos at click time", async () => {
        const editor = await makeEditor("## Section\n\nBody text.");
        const editorView = view(editor);
        // Simulate the captured pos going stale: point data-heading-pos at a
        // paragraph so a stale-captured-pos menu (heading rows) and a live-pos
        // menu (no heading conversion for itself) would differ; the menu must
        // open without throwing on the refreshed position.
        const sticky = makeSticky(editorView, FIRST_HEADING_POS);
        const paragraphPos = FIRST_HEADING_POS + editorView.state.doc.child(0).nodeSize;
        sticky.dataset["headingPos"] = String(paragraphPos);
        const marker = sticky.querySelector<HTMLButtonElement>(".heading-sticky-marker");

        marker?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));

        expect(document.querySelector(".block-menu")).not.toBeNull();
    });
});
