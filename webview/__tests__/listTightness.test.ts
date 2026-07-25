/**
 * MAR-87 regression net: a TIGHT list with a nested sub-list must stay
 * byte-tight through every gutter operation. The originally observed blank
 * line (samples/content-inventory.md, 2026-07-11) could not be reproduced
 * through any of these serializer paths — this suite pins that they stay
 * clean while the live-repro hunt continues on the ticket.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import { moveBlockAt, moveBlockTo } from "../components/blockMenu";
import { contentGuardPlugin } from "../plugins/contentGuard";

let editors: Editor[] = [];

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
        .use(gfmFidelity)
        .use(headingFoldPlugin)
        // Real guard in the loop (MAR-108): these suites exercise guarded ops.
        .use(contentGuardPlugin)
        .create();
    editors.push(editor);
    return editor;
}

const view = (e: Editor): EditorView => e.action((ctx) => ctx.get(editorViewCtx));
const md = (e: Editor): string => e.action(getMarkdown());

afterEach(async () => {
    for (const e of editors) await e.destroy();
    editors = [];
    document.body.innerHTML = "";
});

const SRC = "1. First step\n2. Second step\n   1. Sub-step a\n   2. Sub-step b\n3. Third step";

function itemPos(v: EditorView, text: string): number {
    let found = -1;
    v.state.doc.descendants((node, pos) => {
        if (node.type.name === "list_item" && node.firstChild?.textContent === text) found = pos;
        return true;
    });
    return found;
}

describe("tight nested lists stay tight (MAR-87 net)", () => {
    it("pure round-trip is byte-identical", async () => {
        const e = await makeEditor(SRC);
        expect(md(e)).toBe(SRC + "\n");
    });

    it("typing inside the parent item keeps the list tight", async () => {
        const e = await makeEditor(SRC);
        const v = view(e);
        v.dispatch(v.state.tr.insertText("x", itemPos(v, "Second step") + 2));
        expect(md(e)).not.toContain("\n\n");
    });

    it("moving the subtree item down and back keeps the list tight", async () => {
        const e = await makeEditor(SRC);
        const v = view(e);
        moveBlockAt(v, itemPos(v, "Second step"), 1);
        moveBlockAt(v, itemPos(v, "Second step"), -1);
        expect(md(e)).toBe(SRC + "\n");
    });

    it("refiling a nested item out (and an outer item in) keeps everything tight", async () => {
        const e = await makeEditor(SRC);
        const v = view(e);
        const sub = itemPos(v, "Sub-step a");
        const node = v.state.doc.nodeAt(sub)!;
        moveBlockTo(v, { from: sub, to: sub + node.nodeSize }, itemPos(v, "Third step"));
        expect(md(e)).not.toContain("\n\n");
        const first = itemPos(v, "First step");
        const firstNode = v.state.doc.nodeAt(first)!;
        moveBlockTo(v, { from: first, to: first + firstNode.nodeSize }, itemPos(v, "Sub-step b"));
        expect(md(e)).not.toContain("\n\n");
    });

    it("duplicating the subtree item keeps the list tight", async () => {
        const e = await makeEditor(SRC);
        const v = view(e);
        const pos = itemPos(v, "Second step");
        const node = v.state.doc.nodeAt(pos)!;
        v.dispatch(v.state.tr.insert(pos + node.nodeSize, node));
        expect(md(e)).not.toContain("\n\n");
    });
});

/**
 * MAR-194: a list with ONE interior blank line. Before the per-gap fix these
 * edits wrote blank lines into gaps the author never had — the raw serializer
 * loosened every gap, and minimal-diff only protected the file while nothing
 * in the list changed. An edit that adds or removes a LINE marks the region
 * dirty, and from there the loosened canonical form reached disk.
 */
const PARTLY_LOOSE = "- foo\n- bar\n- baz\n\n- bingo\n- wingo\n";

describe("partly-loose lists survive edits inside them (MAR-194)", () => {
    it("splitting an item keeps every other gap exactly as authored", async () => {
        const e = await makeEditor(PARTLY_LOOSE);
        const v = view(e);
        let mid = -1;
        v.state.doc.descendants((n, p) => {
            if (mid < 0 && n.isText && n.text === "bar") mid = p + 1;
        });
        v.dispatch(v.state.tr.split(mid, 2));
        // The new item joins the TIGHT run; the one authored blank line stays
        // where it was, before "bingo".
        expect(md(e)).toBe("- foo\n- b\n- ar\n- baz\n\n- bingo\n- wingo\n");
    });

    it("deleting an item from the tight run keeps the authored gap", async () => {
        const e = await makeEditor(PARTLY_LOOSE);
        const v = view(e);
        let from = -1;
        let to = -1;
        v.state.doc.descendants((n, p) => {
            if (from < 0 && n.type.name === "list_item" && n.textContent === "baz") {
                from = p;
                to = p + n.nodeSize;
            }
        });
        v.dispatch(v.state.tr.delete(from, to));
        expect(md(e)).toBe("- foo\n- bar\n\n- bingo\n- wingo\n");
    });

    it("typing in an item does not disturb any gap", async () => {
        const e = await makeEditor(PARTLY_LOOSE);
        const v = view(e);
        let at = -1;
        v.state.doc.descendants((n, p) => {
            if (at < 0 && n.isText && n.text === "bar") at = p + 3;
        });
        v.dispatch(v.state.tr.insertText("XX", at));
        expect(md(e)).toBe("- foo\n- barXX\n- baz\n\n- bingo\n- wingo\n");
    });
});
