/**
 * Tests for the toolbar's Code dropdown — the picker that turned the standalone
 * Code Block button into a "Code" family control (plain code block on top, then
 * Mermaid Diagram and Math Block below a separator, all inserting a fenced code
 * block with the right language). Mirrors the Quote dropdown test.
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../serialization";
import { initToolbar } from "../components/toolbar";

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
        .use(gfm)
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

function codeRows(topbar: HTMLElement): HTMLElement[] {
    return Array.from(
        topbar.querySelectorAll<HTMLElement>('[data-item-id="codeBlock"] .tb-callout-item'),
    );
}

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

describe("toolbar Code dropdown", () => {
    it("should render Code Block plus Mermaid and Math Block under one item", () => {
        // Arrange + Act
        const topbar = buildToolbar(() => null);

        // Assert: three rows, plain Code Block first
        const labels = codeRows(topbar).map((r) => r.querySelector("span")?.textContent);
        expect(labels).toEqual(["Code Block", "Mermaid Diagram", "Math Block"]);
        // A separator sits between the plain block and the language-typed blocks.
        expect(topbar.querySelector('[data-item-id="codeBlock"] .tb-menu-sep')).not.toBeNull();
        // It is a dropdown, present exactly once.
        expect(topbar.querySelectorAll('[data-item-id="codeBlock"]').length).toBe(1);
        expect(topbar.querySelector('[data-item-id="codeBlock"] .tb-fmt-menu')).not.toBeNull();
    });

    it("clicking the Mermaid row should insert a mermaid code fence", async () => {
        // Arrange
        const editor = await makeEditor("text");
        const topbar = buildToolbar(() => editor);

        // Act: activate the Mermaid row (index 1) the way wireHoverMenu does
        codeRows(topbar)[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        // Assert
        expect(editor.action(getMarkdown())).toContain("```mermaid");
    });

    it("clicking the Math Block row should insert a display-math block", async () => {
        // Arrange
        const editor = await makeEditor("text");
        const topbar = buildToolbar(() => editor);

        // Act: activate the Math Block row (index 2)
        codeRows(topbar)[2]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        // Assert: a LaTeX-language code block serializes to a `$$…$$` block.
        expect(editor.action(getMarkdown())).toContain("$$");
    });
});
