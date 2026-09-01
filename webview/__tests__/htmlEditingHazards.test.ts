/**
 * @vitest-environment jsdom
 *
 * Reaches the real sanitizer: `createHtmlView` renders through `sanitizeInto`,
 * and DOMPurify does not work under happy-dom (see
 * `sanitizeEnvironment.test.ts` for what it does there instead). Nothing here
 * asserts on sanitized output, so this ran green on markup DOMPurify had left
 * untouched. Pinned so the rendered face these seams are exercised through is
 * the one the product has.
 */
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
import { blockSourcePlugin } from "../plugins/blockSource";

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
        // The block-source opener registers per Schema on create. Without it
        // `openBlockSource` returns false for every editor here, and the
        // Mod+/ handoff is unobservable: the refusal test below cannot tell a
        // held-back escalation from one that simply had nowhere to go.
        .use(blockSourcePlugin)
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

    it("the refusal should state its reason in the panel, and withdraw it once the bytes change", async () => {
        const editor = await makeEditor(TABLE);
        const view = getView(editor);
        const { dom } = htmlAtom(view, "<u>");

        const area = commitThrough(dom, '<span title="a|b">');
        const note = dom.querySelector(".html-src-note") as HTMLElement;
        expect(note.classList.contains("html-src-note--error")).toBe(true);
        expect(note.textContent).toContain("break the row");

        area.value = "<span>";
        area.dispatchEvent(new Event("input"));

        expect(note.classList.contains("html-src-note--error")).toBe(false);
        expect(area.getAttribute("aria-invalid")).toBeNull();
        await editor.destroy();
    });

    it("a refused Mod+/ should keep the panel rather than hand off a value it would not take", async () => {
        // The handoff commits first and escalates only if the commit closed
        // the panel. A refusal must therefore leave the user exactly where
        // they were: this panel open, holding the bytes they typed, and no
        // block-source panel opened behind it over a value that never landed.
        const editor = await makeEditor(TABLE);
        const before = editor.action(getMarkdown());
        const view = getView(editor);
        const { dom } = htmlAtom(view, "<u>");

        dom.dispatchEvent(new CustomEvent(HTML_EDIT_EVENT));
        const area = dom.querySelector("textarea.html-src") as HTMLTextAreaElement;
        area.value = '<span title="a|b">';
        area.dispatchEvent(new Event("input"));
        area.dispatchEvent(
            new KeyboardEvent("keydown", { key: "/", metaKey: true, bubbles: true, cancelable: true }),
        );

        expect(dom.querySelector("textarea.html-src")).not.toBeNull();
        expect(area.value).toBe('<span title="a|b">');
        expect(document.querySelector("textarea.block-source-area")).toBeNull();
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

describe("a host that cannot hold two source lines refuses a newline", () => {
    // A table cell was the first such host found, so the guard asked
    // `inTable`. The question it meant to ask is whether the host block can
    // hold more than one source line, and a heading cannot either: the newline
    // ends the heading, and at depth 1 or 2 the serializer's setext fallback
    // puts the underline where the second line's HTML block absorbs it, taking
    // the whole heading with it.
    const ATX = "### Release <span>x</span>\n\nBody.\n";
    // Setext in the SOURCE, not just at a setext-eligible depth: sourceStyle
    // preserves the form a heading was written in, so an ATX `##` round-trips
    // as ATX and never reaches the underline hazard at all.
    const SETEXT = "Release <span>x</span>\n-------\n\nBody.\n";

    it("a newline committed into a heading's tag should be refused, document untouched", async () => {
        const editor = await makeEditor(ATX);
        const before = editor.action(getMarkdown());
        const view = getView(editor);
        const { dom } = htmlAtom(view, "<span>");

        commitThrough(dom, "<span>\n<div>");

        expect(editor.action(getMarkdown())).toBe(before);
        await editor.destroy();
    });

    it("a setext-depth heading should keep its own node rather than becoming paragraphs", async () => {
        const editor = await makeEditor(SETEXT);
        const view = getView(editor);
        const { dom } = htmlAtom(view, "<span>");

        commitThrough(dom, "<span>\n<div>");

        const reparsed = await makeEditor(editor.action(getMarkdown()));
        const names: string[] = [];
        reparsed.action((ctx) => {
            ctx.get(editorViewCtx).state.doc.descendants((n) => { names.push(n.type.name); });
        });
        expect(names).toContain("heading");
        await editor.destroy();
        await reparsed.destroy();
    });

    it("the same multi-line value in an ordinary paragraph still commits", async () => {
        // The guard must stay narrow: a paragraph CAN hold two source lines,
        // and multi-line raw HTML there is the panel's normal mode.
        const editor = await makeEditor("Para <span>x</span> here.\n");
        const view = getView(editor);
        const { dom } = htmlAtom(view, "<span>");

        commitThrough(dom, "<span>\n<div>");

        expect(editor.action(getMarkdown())).toContain("<span>\n<div>");
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

    it("a fence should survive when the edited atom is NOT the paragraph's first child", async () => {
        // The same hazard with the atom in the middle of the line. The gap
        // check used to ask only whether the paragraph's FIRST child was an
        // html node, which is a sound proxy for "can line ONE start with a raw
        // `<`" and no proxy at all for a later line. Since a panel-committed
        // value is routinely multi-line, a text-first paragraph reaches the
        // same absorbed-fence state the atom-first one is guarded against.
        const editor = await makeEditor("- intro <span>x</span>\n  ```\n  code\n  ```\n- second\n");
        const view = getView(editor);
        const { pos } = htmlAtom(view, "<span>");
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { value: "<span>\n<div>" }));

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
