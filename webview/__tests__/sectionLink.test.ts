/**
 * Section-link picker (MAR-176). Drives the REAL Milkdown editor with the
 * production serialization config — no mocks — so the doc walk, the shared
 * slug computation, and the end-to-end insert through the link editor are all
 * exercised against real ProseMirror state.
 *
 * Two concerns:
 *   - collectDocHeadings: the shared outline walk (also behind the TOC).
 *   - openSectionLinkPicker: caret vs selection link text, the `#slug` href
 *     including the duplicate-heading `-N` case, keyboard confirm, and the
 *     graceful no-headings state.
 *
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import { TextSelection, Selection } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { setupLinkPopup } from "../components/linkPopup";
import { openSectionLinkPicker } from "../components/sectionLink";
import { collectDocHeadings } from "../utils/headingUtils";

async function makeEditor(markdown: string): Promise<{
    editor: Editor;
    container: HTMLElement;
    view: EditorView;
}> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, container);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    // The picker inserts through the shared link editor (the hover popup
    // singleton); wire it to this editor's view.
    setupLinkPopup(container, () => view);
    return { editor, container, view };
}

/** The rendered suggest dropdown, or null. */
function suggestMenu(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".link-target-menu");
}

/** The rendered heading rows. */
function menuRows(): HTMLElement[] {
    return Array.from(
        document.querySelectorAll<HTMLElement>(".link-target-menu li.fm-suggest-item"),
    );
}

/** The (visible) link editor popup, or null. */
function linkPopup(): HTMLElement | null {
    return Array.from(document.querySelectorAll<HTMLElement>(".lp-root")).find(
        (p) => p.style.display !== "none",
    ) ?? null;
}

function urlInput(): HTMLInputElement {
    return linkPopup()!.querySelector<HTMLInputElement>(".lp-url-input")!;
}
function textInput(): HTMLInputElement {
    return linkPopup()!.querySelector<HTMLInputElement>(".lp-text-input")!;
}

/** Commit the link editor's prefilled fields (Enter on the URL input). */
function commit(): void {
    urlInput().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
}

/** Put the caret just inside the first text node equal to `text`. */
function caretInText(v: EditorView, text: string): void {
    let pos = -1;
    v.state.doc.descendants((n, p) => {
        if (pos < 0 && n.isText && n.text === text) pos = p;
    });
    if (pos < 0) throw new Error(`text not found: ${text}`);
    v.dispatch(v.state.tr.setSelection(Selection.near(v.state.doc.resolve(pos + 1))));
}

/** Select the whole first text node equal to `text`. */
function selectText(v: EditorView, text: string): void {
    let from = -1;
    v.state.doc.descendants((n, p) => {
        if (from < 0 && n.isText && n.text === text) from = p;
    });
    if (from < 0) throw new Error(`text not found: ${text}`);
    v.dispatch(
        v.state.tr.setSelection(TextSelection.create(v.state.doc, from, from + text.length)),
    );
}

const md = (editor: Editor): string => editor.action(getMarkdown()).trim();

describe("collectDocHeadings", () => {
    let editor: Editor | null = null;
    beforeEach(() => { document.body.innerHTML = ""; });
    afterEach(async () => { if (editor) { await editor.destroy(); editor = null; } });

    it("should collect headings in document order with level, text, and increasing pos", async () => {
        const made = await makeEditor("# One\n\nbody\n\n## Two\n\n### Three\n");
        editor = made.editor;
        const headings = collectDocHeadings(made.view.state.doc);
        expect(headings.map((h) => h.level)).toEqual([1, 2, 3]);
        expect(headings.map((h) => h.text)).toEqual(["One", "Two", "Three"]);
        // Positions are strictly increasing (document order).
        expect(headings[0].pos).toBeLessThan(headings[1].pos);
        expect(headings[1].pos).toBeLessThan(headings[2].pos);
    });

    it("a document with no headings should return an empty list", async () => {
        const made = await makeEditor("just a paragraph\n");
        editor = made.editor;
        expect(collectDocHeadings(made.view.state.doc)).toEqual([]);
    });
});

describe("openSectionLinkPicker", () => {
    let editor: Editor | null = null;
    beforeEach(() => { document.body.innerHTML = ""; });
    afterEach(async () => { if (editor) { await editor.destroy(); editor = null; } });

    it("no headings should show a graceful empty-state row and open no link editor", async () => {
        const made = await makeEditor("just text\n");
        editor = made.editor;
        caretInText(made.view, "just text");

        openSectionLinkPicker(made.view);

        const rows = menuRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toBe("No headings in this document");
        // Clicking the inert row closes without touching the document.
        rows[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(linkPopup()).toBeNull();
        expect(md(editor)).toBe("just text");
    });

    it("the menu should list every heading title in document order", async () => {
        const made = await makeEditor("# Alpha\n\n## Beta\n\nbody\n");
        editor = made.editor;
        caretInText(made.view, "body");

        openSectionLinkPicker(made.view);

        // H1 has no indent; the H2's nbsp indent is display-only — its trailing
        // title is still "Beta".
        const labels = menuRows().map((r) => r.textContent?.replace(/ /g, "").trim());
        expect(labels).toEqual(["Alpha", "Beta"]);
    });

    it("picking a heading at a caret should insert [title](#slug) with the heading title as text", async () => {
        const made = await makeEditor("# Alpha\n\n## Beta\n\nbody\n");
        editor = made.editor;
        caretInText(made.view, "body");

        openSectionLinkPicker(made.view);
        // Pick "Beta" (the second row).
        menuRows()[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        // The link editor opens prefilled with the anchor href + heading title.
        expect(urlInput().value).toBe("#beta");
        expect(textInput().value).toBe("Beta");
        commit();
        expect(md(editor)).toContain("[Beta](#beta)");
    });

    it("picking a heading with text selected should keep the selection as the link text", async () => {
        const made = await makeEditor("# Alpha\n\nselect me here\n");
        editor = made.editor;
        selectText(made.view, "select me here");

        openSectionLinkPicker(made.view);
        menuRows()[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        expect(urlInput().value).toBe("#alpha");
        expect(textInput().value).toBe("select me here");
        commit();
        expect(md(editor)).toContain("[select me here](#alpha)");
    });

    it("a duplicate heading title should mint the matching -N slug (and label the row (2))", async () => {
        const made = await makeEditor("# Foo\n\n# Foo\n\nbody\n");
        editor = made.editor;
        caretInText(made.view, "body");

        openSectionLinkPicker(made.view);
        const rows = menuRows();
        // Identical titles are disambiguated in the display so the picker can
        // tell them apart; the SECOND "Foo" resolves to the -1 slug.
        expect(rows[0].textContent).toBe("Foo");
        expect(rows[1].textContent).toBe("Foo (2)");
        rows[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        expect(urlInput().value).toBe("#foo-1");
        commit();
        expect(md(editor)).toContain("[Foo](#foo-1)");
    });

    it("Enter should confirm the pre-highlighted first heading", async () => {
        const made = await makeEditor("# Alpha\n\n## Beta\n\nbody\n");
        editor = made.editor;
        caretInText(made.view, "body");

        openSectionLinkPicker(made.view);
        // No arrow key first: the first row is pre-highlighted, so Enter picks it.
        made.view.dom.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );

        expect(urlInput().value).toBe("#alpha");
        expect(textInput().value).toBe("Alpha");
    });

    it("Escape should dismiss the picker without opening the link editor", async () => {
        const made = await makeEditor("# Alpha\n\nbody\n");
        editor = made.editor;
        caretInText(made.view, "body");

        openSectionLinkPicker(made.view);
        expect(suggestMenu()).not.toBeNull();
        made.view.dom.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );

        expect(suggestMenu()).toBeNull();
        expect(linkPopup()).toBeNull();
    });

    it("a heading with an inline atom should resolve back to itself (FID-1: producer and resolver agree)", async () => {
        // The wikilink atom renders display text ("Display") in the DOM but is
        // an atom: it contributes NOTHING to the heading's MODEL text. So the
        // model slug is "cost", while a DOM-sourced slug would be "cost-display".
        // The picker mints from the model; the resolver must too, or the freshly
        // inserted `#cost` link resolves to nothing.
        const made = await makeEditor("# Cost [[metric|Display]]\n\nbody\n");
        editor = made.editor;
        caretInText(made.view, "body");

        openSectionLinkPicker(made.view);
        const rows = menuRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toBe("Cost");
        rows[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        // The minted href is the MODEL slug.
        expect(urlInput().value).toBe("#cost");
        // The link editor's anchor hint proves the resolver found the SAME
        // heading from that same model slug. Under the old DOM-based resolver the
        // heading slugs to "cost-display", so "#cost" resolves to nothing and the
        // hint stays empty/hidden.
        const hint = linkPopup()!.querySelector<HTMLElement>(".lp-anchor-hint")!;
        expect(hint.textContent).toBe("→ Cost");
        expect(hint.style.display).not.toBe("none");
    });

    it("a heading whose title slugifies to empty should be omitted (FID-2: unaddressable)", async () => {
        // "🚀" slugifies to "" (no anchor), so it must not be offered — a bare
        // "#" href would resolve to nothing. The addressable "Real" heading stays.
        const made = await makeEditor("# 🚀\n\n## Real\n\nbody\n");
        editor = made.editor;
        caretInText(made.view, "body");

        openSectionLinkPicker(made.view);
        const labels = menuRows().map((r) => r.textContent?.replace(/\s/g, ""));
        expect(labels).toEqual(["Real"]);
    });

    it("a document of only unaddressable headings should show the empty-state row (FID-2)", async () => {
        const made = await makeEditor("# 🚀\n\n## +++\n\nbody\n");
        editor = made.editor;
        caretInText(made.view, "body");

        openSectionLinkPicker(made.view);
        const rows = menuRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toBe("No headings in this document");
        // Inert: clicking it opens no link editor.
        rows[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(linkPopup()).toBeNull();
    });

    it("Tab should accept the highlighted heading, not fall through to the editor (UI-2)", async () => {
        const made = await makeEditor("# Alpha\n\nbody\n");
        editor = made.editor;
        caretInText(made.view, "body");

        openSectionLinkPicker(made.view);
        const ev = new KeyboardEvent("keydown", {
            key: "Tab",
            bubbles: true,
            cancelable: true,
        });
        made.view.dom.dispatchEvent(ev);

        // Tab is consumed (never reaches ProseMirror's indent) and picks the
        // pre-highlighted first heading, opening the link editor.
        expect(ev.defaultPrevented).toBe(true);
        expect(urlInput().value).toBe("#alpha");
    });

    it("a stray printable keypress should close the picker without consuming it (FID-3)", async () => {
        const made = await makeEditor("# Alpha\n\nbody\n");
        editor = made.editor;
        caretInText(made.view, "body");

        openSectionLinkPicker(made.view);
        expect(suggestMenu()).not.toBeNull();

        const ev = new KeyboardEvent("keydown", {
            key: "a",
            bubbles: true,
            cancelable: true,
        });
        made.view.dom.dispatchEvent(ev);

        // Closing eliminates the stale-range window; the key is NOT consumed, so
        // it reaches the editor as normal input.
        expect(suggestMenu()).toBeNull();
        expect(ev.defaultPrevented).toBe(false);
    });

    it("a bare modifier keypress should NOT close the picker (FID-3)", async () => {
        const made = await makeEditor("# Alpha\n\nbody\n");
        editor = made.editor;
        caretInText(made.view, "body");

        openSectionLinkPicker(made.view);
        made.view.dom.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Shift", bubbles: true, cancelable: true }),
        );

        // Holding Shift before a chord (e.g. Shift+ArrowDown) must not dismiss.
        expect(suggestMenu()).not.toBeNull();
    });
});
