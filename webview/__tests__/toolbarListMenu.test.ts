/**
 * Tests for the toolbar's Lists dropdown — the single hover-menu picker that
 * replaced the three separate bullet / ordered / task buttons (mirroring the
 * Format P + headings dropdown). Covers the rendered rows and the active-list
 * highlight (a filled accent row) that onSelectionChange drives against the REAL
 * Milkdown editor. acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { Selection } from "../pm";
import type { EditorView } from "../pm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
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
        .use(gfmFidelity)
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

/** The task-sink preference row — a switch, not one of the fill-idiom rows. */
function sinkSwitch(topbar: HTMLElement): HTMLElement {
    return topbar.querySelector<HTMLElement>(".tb-list-menu .tb-switch-item")!;
}

/** Open the Lists dropdown the keyboard way (instant — no hover-intent timer). */
function openListMenu(topbar: HTMLElement): void {
    topbar
        .querySelector<HTMLElement>('[data-item-id="listMenu"] .tb-fmt-btn')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
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
    it("should render one dropdown with Bullet / Ordered / Task rows and the sink switch", () => {
        // Arrange + Act
        const { topbar } = buildToolbar(() => null);

        // Assert: a single list slot; three insert rows, then the
        // "Move checked tasks to bottom" settings switch below a divider.
        const rows = listRows(topbar);
        expect(rows.map((r) => r.querySelector(".tb-list-item-label")?.textContent)).toEqual([
            "Bullet List",
            "Ordered List",
            "Task List",
        ]);
        rows.forEach((r) => expect(r.querySelector(".tb-list-item-icon svg")).not.toBeNull());
        expect(topbar.querySelector(".tb-list-menu .tb-menu-sep")).not.toBeNull();
        // The preference is a switch row (not the rows' accent-fill idiom): a
        // leading icon that keeps the column aligned, a label, and a track.
        const sink = sinkSwitch(topbar);
        expect(sink.querySelector(".tb-switch-item-label")?.textContent).toBe(
            "Move checked tasks to bottom",
        );
        expect(sink.querySelector(".tb-list-item-icon svg")).not.toBeNull();
        expect(sink.querySelector(".tb-switch .tb-switch-knob")).not.toBeNull();
        expect(sink.getAttribute("role")).toBe("switch");
        // It reflects the (default off) setting.
        expect(sink.getAttribute("aria-checked")).toBe("false");
        expect(sink.classList.contains("tb-switch-item--on")).toBe(false);
        // The three old standalone list buttons are gone.
        expect(topbar.querySelectorAll('[data-item-id="bulletList"]').length).toBe(0);
        expect(topbar.querySelectorAll('[data-item-id="listMenu"]').length).toBe(1);
    });

    it("clicking the sink switch should flip its checked state and the in-session gate", () => {
        // Arrange
        window.__i18n = { translations: {}, isMac: false, checklistSinkChecked: false };
        const { topbar } = buildToolbar(() => null);
        const sink = sinkSwitch(topbar);

        // Act
        sink.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        // Assert
        expect(sink.getAttribute("aria-checked")).toBe("true");
        expect(sink.classList.contains("tb-switch-item--on")).toBe(true);
        expect(window.__i18n?.checklistSinkChecked).toBe(true);
        delete window.__i18n;
    });

    it("opening the menu should repaint the sink switch from the current gate", () => {
        // Arrange: the same setting is flippable from the task-list block menu
        // and by a settings echo, neither of which touches this row.
        window.__i18n = { translations: {}, isMac: false, checklistSinkChecked: false };
        const { topbar } = buildToolbar(() => null);
        const sink = sinkSwitch(topbar);
        expect(sink.getAttribute("aria-checked")).toBe("false");
        window.__i18n!.checklistSinkChecked = true;

        // Act
        openListMenu(topbar);

        // Assert
        expect(sink.getAttribute("aria-checked")).toBe("true");
        delete window.__i18n;
    });

    it("clicking a row should run its list command against the editor", async () => {
        // Arrange
        const editor = await makeEditor("plain line");
        const v = view(editor);
        const { topbar } = buildToolbar(() => editor);
        v.dispatch(v.state.tr.setSelection(Selection.atEnd(v.state.doc)));

        // Act: activate the Ordered row (index 1) the way wireHoverMenu does
        const [, ordered] = listRows(topbar);
        ordered!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        // Assert: the paragraph is now an ordered list item
        expect(editor.action(getMarkdown()).trim()).toMatch(/^1\. plain line/);
    });

    it("a caret inside a bullet list should mark only the Bullet row active", async () => {
        // Arrange
        const editor = await makeEditor("- one\n- two");
        const v = view(editor);
        const { topbar, tb } = buildToolbar(() => editor);

        // Act: move the caret into the list, then repaint the toolbar state
        v.dispatch(v.state.tr.setSelection(Selection.atEnd(v.state.doc)));
        tb.onSelectionChange(v);

        // Assert
        const [bullet, ordered, task] = listRows(topbar);
        expect(bullet!.classList.contains("tb-list-item--on")).toBe(true);
        expect(ordered!.classList.contains("tb-list-item--on")).toBe(false);
        expect(task!.classList.contains("tb-list-item--on")).toBe(false);
    });

    it("a caret inside an ordered list should mark only the Ordered row active", async () => {
        // Arrange
        const editor = await makeEditor("1. one\n2. two");
        const v = view(editor);
        const { topbar, tb } = buildToolbar(() => editor);

        // Act
        v.dispatch(v.state.tr.setSelection(Selection.atEnd(v.state.doc)));
        tb.onSelectionChange(v);

        // Assert
        const [bullet, ordered, task] = listRows(topbar);
        expect(ordered!.classList.contains("tb-list-item--on")).toBe(true);
        expect(bullet!.classList.contains("tb-list-item--on")).toBe(false);
        expect(task!.classList.contains("tb-list-item--on")).toBe(false);
    });

    it("a caret inside a task list should mark only the Task row active", async () => {
        // Arrange
        const editor = await makeEditor("- [ ] one\n- [x] two");
        const v = view(editor);
        const { topbar, tb } = buildToolbar(() => editor);

        // Act
        v.dispatch(v.state.tr.setSelection(Selection.atEnd(v.state.doc)));
        tb.onSelectionChange(v);

        // Assert
        const [bullet, ordered, task] = listRows(topbar);
        expect(task!.classList.contains("tb-list-item--on")).toBe(true);
        expect(bullet!.classList.contains("tb-list-item--on")).toBe(false);
        expect(ordered!.classList.contains("tb-list-item--on")).toBe(false);
    });

    it("a caret in plain text should mark no list row active", async () => {
        // Arrange
        const editor = await makeEditor("just a paragraph");
        const v = view(editor);
        const { topbar, tb } = buildToolbar(() => editor);

        // Act
        v.dispatch(v.state.tr.setSelection(Selection.atEnd(v.state.doc)));
        tb.onSelectionChange(v);

        // Assert
        listRows(topbar).forEach((r) => expect(r.classList.contains("tb-list-item--on")).toBe(false));
    });
});
