/**
 * onSelectionChange wiring: the toolbar reflects the caret's state — inline-mark
 * buttons light up, the container the caret is in fills its dropdown row and
 * lights its trigger, and the text-hierarchy control greys out where it can't
 * act. Drives the REAL editor + real toolbar. acquireVsCodeApi via setup.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { Selection, TextSelection, NodeSelection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { insertCalloutCommand } from "../plugins/callouts";
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
        .use(insertCalloutCommand)
        .create();
    editors.push(editor);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function setup(md: string): Promise<{ editor: Editor; topbar: HTMLElement; tb: ReturnType<typeof initToolbar> }> {
    return makeEditor(md).then((editor) => {
        const topbar = document.createElement("div");
        topbar.className = "editor-topbar";
        document.body.appendChild(topbar);
        const tb = initToolbar(topbar, () => editor);
        return { editor, topbar, tb };
    });
}

function caretInText(editor: Editor, text: string): void {
    const v = view(editor);
    let pos = -1;
    v.state.doc.descendants((n, p) => {
        if (pos < 0 && n.isText && (n.text ?? "").includes(text)) { pos = p; }
    });
    v.dispatch(v.state.tr.setSelection(Selection.near(v.state.doc.resolve(pos + 1))));
}

const q = (topbar: HTMLElement, sel: string): HTMLElement => topbar.querySelector<HTMLElement>(sel)!;
const active = (el: HTMLElement): boolean => el.classList.contains("tb-btn--active");

afterEach(async () => {
    for (const editor of editors) { await editor.destroy(); }
    editors = [];
    document.body.innerHTML = "";
});

describe("toolbar reflects caret state", () => {
    it("selecting bold text should light the Bold button and not Italic", async () => {
        const { editor, topbar, tb } = await setup("**strong** plain");
        const v = view(editor);
        let from = -1;
        v.state.doc.descendants((n, p) => { if (from < 0 && n.isText && (n.text ?? "").includes("strong")) { from = p; } });
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from + 1, from + 4)));
        tb.onSelectionChange(v);
        expect(active(q(topbar, '[data-item-id="bold"] .tb-btn'))).toBe(true);
        expect(active(q(topbar, '[data-item-id="italic"] .tb-btn'))).toBe(false);
    });

    it("a caret in a bullet list should light the Lists trigger and fill the Bullet row", async () => {
        const { editor, topbar, tb } = await setup("- one\n- two");
        caretInText(editor, "one");
        tb.onSelectionChange(view(editor));
        expect(active(q(topbar, '[data-item-id="listMenu"] .tb-fmt-btn'))).toBe(true);
        const [bullet, ordered] = Array.from(topbar.querySelectorAll<HTMLElement>('[data-item-id="listMenu"] .tb-list-item'));
        expect(bullet!.classList.contains("tb-list-item--on")).toBe(true);
        expect(ordered!.classList.contains("tb-list-item--on")).toBe(false);
    });

    it("a caret in a blockquote should light the Quote trigger and fill the Blockquote row", async () => {
        const { editor, topbar, tb } = await setup("> quoted");
        caretInText(editor, "quoted");
        tb.onSelectionChange(view(editor));
        expect(active(q(topbar, '[data-item-id="quote"] .tb-fmt-btn'))).toBe(true);
        const rows = Array.from(topbar.querySelectorAll<HTMLElement>('[data-item-id="quote"] .tb-callout-item'));
        expect(rows[0]!.classList.contains("tb-callout-item--on")).toBe(true); // Blockquote row
        expect(rows.slice(1).some((r) => r.classList.contains("tb-callout-item--on"))).toBe(false);
    });

    it("a caret in a callout should fill only that callout's row", async () => {
        const { editor, topbar, tb } = await setup("> [!TIP]\n> hint");
        caretInText(editor, "hint");
        tb.onSelectionChange(view(editor));
        const rows = Array.from(topbar.querySelectorAll<HTMLElement>('[data-item-id="quote"] .tb-callout-item'));
        // rows: Blockquote, Note, Tip, Important, Warning, Caution → Tip is index 2
        expect(rows.map((r) => r.classList.contains("tb-callout-item--on"))).toEqual([false, false, true, false, false, false]);
    });

    it("a caret in a mermaid block should fill the Mermaid row and grey the P/H control", async () => {
        const { editor, topbar, tb } = await setup("```mermaid\ngraph TD\n```");
        caretInText(editor, "graph");
        tb.onSelectionChange(view(editor));
        expect(active(q(topbar, '[data-item-id="codeBlock"] .tb-fmt-btn'))).toBe(true);
        const rows = Array.from(topbar.querySelectorAll<HTMLElement>('[data-item-id="codeBlock"] .tb-callout-item'));
        // rows: Code Block, Mermaid, Math → Mermaid is index 1
        expect(rows.map((r) => r.classList.contains("tb-callout-item--on"))).toEqual([false, true, false]);
        expect(q(topbar, '[data-item-id="format"] .tb-fmt-wrap').classList.contains("tb-fmt-wrap--disabled")).toBe(true);
    });

    it("a caret in a table cell should light the Table button and grey the P/H control with no checkmark", async () => {
        const { editor, topbar, tb } = await setup("| a | b |\n| - | - |\n| c | d |");
        caretInText(editor, "c");
        tb.onSelectionChange(view(editor));
        expect(active(q(topbar, '[data-item-id="table"] .tb-btn'))).toBe(true);
        expect(q(topbar, '[data-item-id="format"] .tb-fmt-wrap').classList.contains("tb-fmt-wrap--disabled")).toBe(true);
        // No format row is filled where the type can't become a heading (N/A → "—").
        expect(topbar.querySelectorAll('[data-item-id="format"] .tb-fmt-item--on').length).toBe(0);
    });

    it("a selected image should light the Image button and grey the P/H control", async () => {
        const { editor, topbar, tb } = await setup("![alt](https://example.com/x.png)");
        const v = view(editor);
        let pos = -1;
        v.state.doc.descendants((n, p) => { if (pos < 0 && n.type.name === "image") { pos = p; } });
        v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, pos)));
        tb.onSelectionChange(v);
        expect(active(q(topbar, '[data-item-id="image"] .tb-btn'))).toBe(true);
        expect(q(topbar, '[data-item-id="format"] .tb-fmt-wrap').classList.contains("tb-fmt-wrap--disabled")).toBe(true);
    });

    it("setDetached should blank the bar after it reflected a real block", async () => {
        // Focus in a callout-title island freezes the PM selection; the bar must
        // stop asserting the (now-stale) block it last reflected.
        const { editor, topbar, tb } = await setup("> [!TIP]\n> hint");
        caretInText(editor, "hint");
        tb.onSelectionChange(view(editor));
        expect(active(q(topbar, '[data-item-id="quote"] .tb-fmt-btn'))).toBe(true); // precondition

        tb.setDetached();
        expect(topbar.querySelectorAll(".tb-btn--active").length).toBe(0);
        expect(q(topbar, '[data-item-id="format"] .tb-fmt-wrap').classList.contains("tb-fmt-wrap--disabled")).toBe(true);
        expect(topbar.querySelectorAll('[data-item-id="format"] .tb-fmt-item--on').length).toBe(0);
        expect(topbar.querySelectorAll('[data-item-id="quote"] .tb-callout-item--on').length).toBe(0);
    });

    it("a caret in plain text should light nothing and fill the P row (no checkmark column)", async () => {
        const { editor, topbar, tb } = await setup("plain paragraph here");
        caretInText(editor, "plain");
        tb.onSelectionChange(view(editor));
        expect(topbar.querySelectorAll(".tb-btn--active").length).toBe(0);
        expect(q(topbar, '[data-item-id="format"] .tb-fmt-wrap').classList.contains("tb-fmt-wrap--disabled")).toBe(false);
        // Exactly the P row is filled (the caret is a paragraph) — via the fill
        // idiom, not a checkmark: the Format menu has no .menu-check column.
        const filled = topbar.querySelectorAll<HTMLElement>('[data-item-id="format"] .tb-fmt-item--on');
        expect(filled.length).toBe(1);
        expect(filled[0]!.textContent!.trim()).toBe("P");
        expect(topbar.querySelectorAll('[data-item-id="format"] .menu-check').length).toBe(0);
    });
});
