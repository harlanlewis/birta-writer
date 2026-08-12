/**
 * The hazard seams of editable HTML (MAR-14), found by adversarial review of
 * the first cut and each reproduced before being fixed:
 *
 *  - a committed value carrying a newline or `|` inside a table cell tears
 *    the row / shifts cells off the end on reparse (the serializer emits
 *    html bytes verbatim, bypassing cell escaping) → the panel refuses;
 *  - a committed value opening an HTML block on a LATER line stepped around
 *    the MAR-296 first-line check, so a fence glued tight after it in a list
 *    item was absorbed as raw HTML on reopen → the gap check now scans the
 *    running open-state across every line;
 *  - a save flush or mode switch while the panel held an uncommitted edit
 *    read stale bytes → both seams bank the panel (blur commits) first.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, nodeViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import { bankOpenHtmlPanel, createHtmlView, HTML_EDIT_EVENT } from "../components/htmlView";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
            ctx.set(nodeViewCtx, [
                ["html", (node, view, getPos) => createHtmlView(node, view, getPos)],
            ]);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
}

function getView(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** DOM + pos of the html atom whose value is `value`. */
function htmlAtom(view: EditorView, value: string): { dom: HTMLElement; pos: number } {
    let found: { dom: HTMLElement; pos: number } | null = null;
    view.state.doc.descendants((node, pos) => {
        if (!found && node.type.name === "html" && node.attrs["value"] === value) {
            found = { dom: view.nodeDOM(pos) as HTMLElement, pos };
            return false;
        }
        return true;
    });
    if (!found) {
        throw new Error(`no html atom with value ${value}`);
    }
    return found;
}

/** Open the atom's panel, type `value`, and blur (the commit gesture). */
function commitThrough(dom: HTMLElement, value: string): HTMLTextAreaElement {
    dom.dispatchEvent(new CustomEvent(HTML_EDIT_EVENT));
    const area = dom.querySelector("textarea.html-src") as HTMLTextAreaElement;
    area.value = value;
    area.dispatchEvent(new Event("blur"));
    return area;
}

const TABLE = "| a <u>x</u> b | kept? |\n| --- | --- |\n| c | d |\n";

describe("table-cell commits are refused when they would tear the row", () => {
    it("a value carrying a pipe should be refused, panel open, document untouched", async () => {
        const editor = await makeEditor(TABLE);
        const before = editor.action(getMarkdown());
        const view = getView(editor);
        const { dom } = htmlAtom(view, "<u>");

        const area = commitThrough(dom, '<span title="a|b">');

        expect(area.getAttribute("aria-invalid")).toBe("true");
        expect(dom.querySelector("textarea.html-src")).not.toBeNull();
        expect(editor.action(getMarkdown())).toBe(before);
        await editor.destroy();
    });

    it("a value carrying a newline should be refused the same way", async () => {
        const editor = await makeEditor(TABLE);
        const before = editor.action(getMarkdown());
        const view = getView(editor);
        const { dom } = htmlAtom(view, "<u>");

        commitThrough(dom, "<u>\nline2");

        expect(editor.action(getMarkdown())).toBe(before);
        await editor.destroy();
    });

    it("the same multi-line value outside a table should commit fine", async () => {
        const editor = await makeEditor("Para <u>x</u> here.\n");
        const view = getView(editor);
        const { dom } = htmlAtom(view, "<u>");

        commitThrough(dom, "<u>\nline2");

        expect(editor.action(getMarkdown())).toContain("<u>\nline2");
        await editor.destroy();
    });
});

describe("a later-line HTML block opener cannot swallow a glued sibling", () => {
    it("a fence tight after the edited paragraph should survive the round trip", async () => {
        const editor = await makeEditor("- <span>x</span> intro\n  ```\n  code\n  ```\n- second\n");
        const view = getView(editor);
        const { pos } = htmlAtom(view, "<span>");
        // The hazard value: line one opens nothing, line two opens a
        // condition-6 block that only a blank line closes.
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { value: "<span>x</span>\n<div>" }));

        const out = editor.action(getMarkdown());
        const reparsed = await makeEditor(out);
        const names: string[] = [];
        reparsed.action((ctx) => {
            ctx.get(editorViewCtx).state.doc.descendants((n) => {
                names.push(n.type.name);
            });
        });
        expect(names).toContain("code_block");
        await editor.destroy();
        await reparsed.destroy();
    });
});

describe("bankOpenHtmlPanel", () => {
    it("an open panel's uncommitted edit should be committed by the bank", async () => {
        const editor = await makeEditor("Note <!-- old --> here.\n");
        const view = getView(editor);
        const { dom } = htmlAtom(view, "<!-- old -->");

        dom.dispatchEvent(new CustomEvent(HTML_EDIT_EVENT));
        const area = dom.querySelector("textarea.html-src") as HTMLTextAreaElement;
        area.value = "<!-- banked -->";
        area.focus();
        bankOpenHtmlPanel(view);

        expect(editor.action(getMarkdown())).toBe("Note <!-- banked --> here.\n");
        await editor.destroy();
    });
});
