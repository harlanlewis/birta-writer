/**
 * Tests for the caret-side link machinery (components/linkPopup):
 * linkAtCaret's doc-model resolution and openLinkAtCaret's routing — the
 * keyboard analog of Cmd+Click (MAR-118). Drives the REAL Milkdown editor
 * with the production serialization config (link_ref registered) plus the
 * wikilinks plugin; opens are asserted against the mocked VS Code postMessage
 * (setup.ts), matching linkPopup.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView, Node as PMNode } from "../pm";
import { NodeSelection, TextSelection } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { wikiLinksPlugin } from "../plugins/wikiLinks";
import { linkAtCaret, openLinkAtCaret } from "../components/linkPopup";
import { mockVscodeApi } from "./setup";

let editors: Editor[] = [];

async function makeEditor(markdown: string): Promise<EditorView> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(wikiLinksPlugin)
        .create();
    editors.push(editor);
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Position of the first node the predicate accepts (descendants order). */
function posWhere(view: EditorView, match: (node: PMNode) => boolean): number {
    let found = -1;
    view.state.doc.descendants((node, pos) => {
        if (found === -1 && match(node)) {
            found = pos;
        }
        return found === -1;
    });
    expect(found, "no matching node in doc").toBeGreaterThanOrEqual(0);
    return found;
}

function caretAt(view: EditorView, pos: number): void {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

describe("linkAtCaret", () => {
    it("a caret inside an inline link should resolve the mark's href", async () => {
        const view = await makeEditor("before [site](https://example.com/x) after");
        const linkPos = posWhere(view, (n) => n.marks.some((m) => m.type.name === "link"));
        caretAt(view, linkPos + 2);

        expect(linkAtCaret(view)).toEqual({ href: "https://example.com/x", wiki: false });
    });

    it("a caret at the link's trailing edge should still count as on it", async () => {
        const view = await makeEditor("[site](https://example.com/x) after");
        const linkPos = posWhere(view, (n) => n.marks.some((m) => m.type.name === "link"));
        const node = view.state.doc.nodeAt(linkPos)!;
        caretAt(view, linkPos + node.nodeSize); // just past the last linked char

        expect(linkAtCaret(view)).toEqual({ href: "https://example.com/x", wiki: false });
    });

    it("a caret on plain text should resolve to null", async () => {
        const view = await makeEditor("plain text [site](https://example.com/x)");
        caretAt(view, 3);

        expect(linkAtCaret(view)).toBeNull();
    });

    it("a reference link should resolve through its definition", async () => {
        const view = await makeEditor("see [text][ref]\n\n[ref]: https://example.com/ref");
        const refPos = posWhere(view, (n) => n.marks.some((m) => m.type.name === "link_ref"));
        caretAt(view, refPos + 1);

        expect(linkAtCaret(view)).toEqual({ href: "https://example.com/ref", wiki: false });
    });

    it("a selected wikilink atom should resolve its target", async () => {
        const view = await makeEditor("go [[Other Note]] now");
        const wikiPos = posWhere(view, (n) => n.type.name === "wiki_link");
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, wikiPos)));

        expect(linkAtCaret(view)).toEqual({ href: "Other Note", wiki: true });
    });

    it("a caret right beside a wikilink atom should count as on it", async () => {
        const view = await makeEditor("go [[Other Note]] now");
        const wikiPos = posWhere(view, (n) => n.type.name === "wiki_link");
        caretAt(view, wikiPos);

        expect(linkAtCaret(view)).toEqual({ href: "Other Note", wiki: true });
    });
});

describe("openLinkAtCaret", () => {
    it("an external link should open through openUrl", async () => {
        const view = await makeEditor("[site](https://example.com/x)");
        const linkPos = posWhere(view, (n) => n.marks.some((m) => m.type.name === "link"));
        caretAt(view, linkPos + 1);

        expect(openLinkAtCaret(view)).toBe(true);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "openUrl",
            url: "https://example.com/x",
        });
    });

    it("a relative path should open through openFile", async () => {
        const view = await makeEditor("[doc](notes/other.md)");
        const linkPos = posWhere(view, (n) => n.marks.some((m) => m.type.name === "link"));
        caretAt(view, linkPos + 1);

        expect(openLinkAtCaret(view)).toBe(true);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "openFile",
            path: "notes/other.md",
        });
    });

    it("a wikilink should open through the host's wiki resolution", async () => {
        const view = await makeEditor("[[Other Note]]");
        const wikiPos = posWhere(view, (n) => n.type.name === "wiki_link");
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, wikiPos)));

        expect(openLinkAtCaret(view)).toBe(true);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "openFile",
            path: "Other Note",
            wiki: true,
        });
    });

    it("an in-document anchor should scroll, never leaving the webview", async () => {
        const view = await makeEditor("[jump](#target)\n\n## Target\n\nbody");
        const linkPos = posWhere(view, (n) => n.marks.some((m) => m.type.name === "link"));
        caretAt(view, linkPos + 1);

        expect(openLinkAtCaret(view)).toBe(true);
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalled();
    });

    it("a caret on no link should return false and send nothing", async () => {
        const view = await makeEditor("plain text");
        caretAt(view, 2);

        expect(openLinkAtCaret(view)).toBe(false);
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalled();
    });
});
