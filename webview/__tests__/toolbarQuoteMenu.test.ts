/**
 * Tests for the toolbar's Quote dropdown — the merged picker that folded the
 * standalone Blockquote button and the Callouts dropdown into one "Quote"
 * family control (blockquote on top, the five GitHub callout types below a
 * separator). Covers the rendered rows and that a row dispatches its command
 * against the REAL Milkdown editor. acquireVsCodeApi is injected by setup.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { initToolbar } from "../components/toolbar";
import { TextSelection } from "../pm";

let editors: Editor[] = [];

async function makeEditor(md: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, md);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    editors.push(editor);
    return editor;
}

function buildToolbar(getEditor: () => Editor | null): HTMLElement {
    const topbar = document.createElement("div");
    topbar.className = "editor-topbar";
    document.body.appendChild(topbar);
    initToolbar(topbar, getEditor);
    return topbar;
}

function quoteRows(topbar: HTMLElement): HTMLElement[] {
    return Array.from(
        topbar.querySelectorAll<HTMLElement>('[data-item-id="quote"] .tb-callout-item'),
    );
}

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

describe("toolbar Quote dropdown", () => {
    it("should render Blockquote plus the five callout types under one item", () => {
        // Arrange + Act
        const topbar = buildToolbar(() => null);

        // Assert: six rows, Blockquote first
        const labels = quoteRows(topbar).map((r) => r.querySelector("span")?.textContent);
        expect(labels).toEqual(["Blockquote", "Note", "Tip", "Important", "Warning", "Caution"]);
        // A separator sits between the blockquote row and the callout rows.
        expect(topbar.querySelector('[data-item-id="quote"] .tb-menu-sep')).not.toBeNull();
        // The standalone Blockquote button and Callouts dropdown are gone.
        expect(topbar.querySelectorAll('[data-item-id="blockquote"]').length).toBe(0);
        expect(topbar.querySelectorAll('[data-item-id="callouts"]').length).toBe(0);
        expect(topbar.querySelectorAll('[data-item-id="quote"]').length).toBe(1);
    });

    it("clicking the Blockquote row should wrap the block in a blockquote", async () => {
        // Arrange
        const editor = await makeEditor("hello");
        const topbar = buildToolbar(() => editor);

        // Act: activate the first row (Blockquote) the way wireHoverMenu does
        quoteRows(topbar)[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        // Assert
        expect(editor.action(getMarkdown()).trim()).toBe("> hello");
    });

    it("clicking it with the caret in a list should quote the whole list", async () => {
        // Arrange: the caret in the first item, where the row used to no-op
        // because a blockquote cannot be a list item's first child.
        const editor = await makeEditor("- one\n- two");
        const view = editor.action((ctx) => ctx.get(editorViewCtx));
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
        const topbar = buildToolbar(() => editor);

        // Act
        quoteRows(topbar)[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        // Assert
        expect(editor.action(getMarkdown()).trim()).toBe("> - one\n> - two");
    });
});
