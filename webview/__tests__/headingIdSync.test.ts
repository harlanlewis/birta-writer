/**
 * headingIdSync replaces Milkdown's stock `syncHeadingIdPlugin` (a whole-doc
 * descendants walk per transaction) with a gated, pruned equivalent. The
 * contract is BYTE PARITY of the id attrs with the stock plugin, so every
 * behavioral case here is differential: the same document and the same edit
 * driven through a stock-preset editor and through ours, ids compared after.
 * If the gate ever wrongly skips (changeTouchesHeading broken), the heading-
 * edit cases go red against the stock output — the gate's load-bearing branch
 * is covered by parity, not by a copy of the expected slug.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import type { EditorView, Node as PmNode } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";

let editors: Editor[] = [];

async function makeOurs(markdown: string): Promise<EditorView> {
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
        .create();
    editors.push(editor);
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

async function makeStock(markdown: string): Promise<EditorView> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
        })
        .use(commonmark)
        .create();
    editors.push(editor);
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

function headingIds(view: EditorView): unknown[] {
    const ids: unknown[] = [];
    view.state.doc.descendants((node) => {
        if (node.type.name === "heading") {
            ids.push(node.attrs["id"]);
            return false;
        }
        return !node.isTextblock;
    });
    return ids;
}

function findTextblock(view: EditorView, text: string): { node: PmNode; pos: number } {
    let hit: { node: PmNode; pos: number } | null = null;
    view.state.doc.descendants((node, pos) => {
        if (hit) return false;
        if (node.isTextblock && node.textContent === text) {
            hit = { node, pos };
            return false;
        }
        return true;
    });
    if (!hit) throw new Error(`no textblock with text "${text}"`);
    return hit;
}

/** The same duplicate-heavy outline both editors open on. */
const DOC = "# Alpha\n\nbody text\n\n## Beta\n\nmore body\n\n## Beta\n\n## Gamma\n";

describe("headingIdSync parity with the stock plugin", () => {
    it("initial documents should carry identical ids, duplicate suffixes included", async () => {
        const ours = await makeOurs(DOC);
        const stock = await makeStock(DOC);

        expect(headingIds(ours)).toEqual(headingIds(stock));
        // Not merely "both empty": the dedup suffix scheme really fired.
        expect(headingIds(ours)).toContain("beta-#2");
    });

    it("editing a heading's text should update its id exactly as the stock plugin does", async () => {
        const ours = await makeOurs(DOC);
        const stock = await makeStock(DOC);
        for (const view of [ours, stock]) {
            const { pos } = findTextblock(view, "Gamma");
            view.dispatch(view.state.tr.insertText("Delta ", pos + 1));
        }

        expect(headingIds(ours)).toEqual(headingIds(stock));
        expect(headingIds(ours)).toContain("delta-gamma");
    });

    it("a paragraph edit should leave every id untouched", async () => {
        const ours = await makeOurs(DOC);
        const before = headingIds(ours);
        const { pos } = findTextblock(ours, "body text");

        ours.dispatch(ours.state.tr.insertText("X", pos + 1));

        expect(headingIds(ours)).toEqual(before);
    });

    it("a new duplicate heading should take the next suffix, as the stock plugin does", async () => {
        const ours = await makeOurs(DOC);
        const stock = await makeStock(DOC);
        for (const view of [ours, stock]) {
            const heading = view.state.schema.nodes["heading"]!;
            view.dispatch(view.state.tr.insert(
                view.state.doc.content.size,
                heading.create({ level: 2 }, view.state.schema.text("Beta")),
            ));
        }

        expect(headingIds(ours)).toEqual(headingIds(stock));
        expect(headingIds(ours)).toContain("beta-#3");
    });

    it("emptying a heading should be skipped by both, leaving its stale id in place", async () => {
        const ours = await makeOurs(DOC);
        const stock = await makeStock(DOC);
        for (const view of [ours, stock]) {
            const { node, pos } = findTextblock(view, "Gamma");
            view.dispatch(view.state.tr.delete(pos + 1, pos + 1 + node.content.size));
        }

        expect(headingIds(ours)).toEqual(headingIds(stock));
    });
});

describe("headingIdSync registration", () => {
    it("the editor should run our sync and not the stock one", async () => {
        const ours = await makeOurs(DOC);
        const keys = ours.state.plugins.map((p) =>
            String((p.spec as { key?: { key?: string } }).key?.key ?? ""));

        expect(keys.some((k) => k.includes("BIRTA_HEADING_ID"))).toBe(true);
        // A silent filter miss would run BOTH walks per keystroke — worse than
        // the stock behavior this module exists to remove.
        expect(keys.some((k) => k.includes("MILKDOWN_HEADING_ID"))).toBe(false);
    });
});
