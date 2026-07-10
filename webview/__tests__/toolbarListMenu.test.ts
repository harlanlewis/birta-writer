/**
 * Tests for the toolbar's Lists dropdown — the single hover-menu picker that
 * replaced the three separate bullet / ordered / task buttons (mirroring the
 * Format P + headings dropdown). Covers the rendered rows and the active-list
 * checkmark that onSelectionChange drives against the REAL Milkdown editor.
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { Selection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
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

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function buildToolbar(getEditor: () => Editor | null): {
    topbar: HTMLElement;
    tb: ReturnType<typeof initToolbar>;
} {
    const topbar = document.createElement("div");
    topbar.className = "editor-topbar";
    document.body.appendChild(topbar);
    const tb = initToolbar(topbar, getEditor);
    return { topbar, tb };
}

function listRows(topbar: HTMLElement): HTMLElement[] {
    return Array.from(topbar.querySelectorAll<HTMLElement>(".tb-list-menu .tb-list-item"));
}

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    window.__i18n = undefined;
    document.body.innerHTML = "";
});

describe("toolbar Lists dropdown", () => {
    it("should render one dropdown with Bullet / Ordered / Task rows", () => {
        // Arrange + Act
        const { topbar } = buildToolbar(() => null);

        // Assert: a single list slot, three labelled rows, each with an icon
        const rows = listRows(topbar);
        expect(rows.map((r) => r.querySelector(".tb-check-label")?.textContent)).toEqual([
            "Bullet List",
            "Ordered List",
            "Task List",
        ]);
        rows.forEach((r) => expect(r.querySelector(".tb-list-item-icon svg")).not.toBeNull());
        // The three old standalone list buttons are gone.
        expect(topbar.querySelectorAll('[data-item-id="bulletList"]').length).toBe(0);
        expect(topbar.querySelectorAll('[data-item-id="listMenu"]').length).toBe(1);
    });

    it("a caret inside a bullet list should check only the Bullet row", async () => {
        // Arrange
        const editor = await makeEditor("- one\n- two");
        const v = view(editor);
        const { topbar, tb } = buildToolbar(() => editor);

        // Act: move the caret into the list, then repaint the toolbar state
        v.dispatch(v.state.tr.setSelection(Selection.atEnd(v.state.doc)));
        tb.onSelectionChange(v);

        // Assert
        const [bullet, ordered, task] = listRows(topbar);
        expect(bullet!.classList.contains("tb-check-item--on")).toBe(true);
        expect(ordered!.classList.contains("tb-check-item--on")).toBe(false);
        expect(task!.classList.contains("tb-check-item--on")).toBe(false);
    });

    it("a caret inside an ordered list should check only the Ordered row", async () => {
        // Arrange
        const editor = await makeEditor("1. one\n2. two");
        const v = view(editor);
        const { topbar, tb } = buildToolbar(() => editor);

        // Act
        v.dispatch(v.state.tr.setSelection(Selection.atEnd(v.state.doc)));
        tb.onSelectionChange(v);

        // Assert
        const [bullet, ordered, task] = listRows(topbar);
        expect(ordered!.classList.contains("tb-check-item--on")).toBe(true);
        expect(bullet!.classList.contains("tb-check-item--on")).toBe(false);
        expect(task!.classList.contains("tb-check-item--on")).toBe(false);
    });

    it("a caret inside a task list should check only the Task row", async () => {
        // Arrange
        const editor = await makeEditor("- [ ] one\n- [x] two");
        const v = view(editor);
        const { topbar, tb } = buildToolbar(() => editor);

        // Act
        v.dispatch(v.state.tr.setSelection(Selection.atEnd(v.state.doc)));
        tb.onSelectionChange(v);

        // Assert
        const [bullet, ordered, task] = listRows(topbar);
        expect(task!.classList.contains("tb-check-item--on")).toBe(true);
        expect(bullet!.classList.contains("tb-check-item--on")).toBe(false);
        expect(ordered!.classList.contains("tb-check-item--on")).toBe(false);
    });

    it("a caret in plain text should check no list row", async () => {
        // Arrange
        const editor = await makeEditor("just a paragraph");
        const v = view(editor);
        const { topbar, tb } = buildToolbar(() => editor);

        // Act
        v.dispatch(v.state.tr.setSelection(Selection.atEnd(v.state.doc)));
        tb.onSelectionChange(v);

        // Assert
        listRows(topbar).forEach((r) => expect(r.classList.contains("tb-check-item--on")).toBe(false));
    });
});
