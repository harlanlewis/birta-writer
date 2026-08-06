/**
 * listOrderSync replaces Milkdown's stock `syncListOrderPlugin` (a whole-doc
 * descendants walk per generic transaction) with a gated, pruned equivalent.
 * The contract is PARITY with the stock plugin's label and conversion output,
 * so the behavioral cases are differential: same document, same edit, driven
 * through a stock-preset editor and ours, list facts compared after. If the
 * gate ever wrongly skips (an edit it thought could not change a label), these
 * go red against the stock output.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import type { EditorView, Node as PmNode } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";

let editors: Editor[] = [];

async function make(markdown: string, stock: boolean): Promise<EditorView> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let builder = Editor.make().config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, markdown);
        if (!stock) configureSerialization(ctx);
    });
    builder = stock ? builder.use(commonmark) : builder.use(pureCommonmark).use(gfmFidelity);
    const editor = await builder.create();
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

/** Every list fact the sync plugin owns, in document order. */
function listFacts(view: EditorView): string[] {
    const facts: string[] = [];
    view.state.doc.descendants((node) => {
        if (node.type.name === "bullet_list" || node.type.name === "ordered_list") {
            facts.push(node.type.name);
            return true;
        }
        if (node.type.name === "list_item") {
            facts.push(`${node.attrs["listType"]}:${node.attrs["label"]}`);
            return true;
        }
        return !node.isTextblock;
    });
    return facts;
}

function findFirst(view: EditorView, name: string): { node: PmNode; pos: number } {
    let hit: { node: PmNode; pos: number } | null = null;
    view.state.doc.descendants((node, pos) => {
        if (hit) return false;
        if (node.type.name === name) {
            hit = { node, pos };
            return false;
        }
        return true;
    });
    if (!hit) throw new Error(`no ${name} in doc`);
    return hit;
}

const DOC = "1. one\n2. two\n3. three\n\nbetween\n\n- alpha\n- beta\n";

describe("listOrderSync parity with the stock plugin", () => {
    it("inserting an item should re-label the later siblings exactly as stock does", async () => {
        const ours = await make(DOC, false);
        const stock = await make(DOC, true);
        for (const view of [ours, stock]) {
            const { node, pos } = findFirst(view, "list_item");
            const schema = view.state.schema;
            const item = schema.nodes["list_item"]!.create(
                { listType: "ordered" },
                schema.nodes["paragraph"]!.create(null, schema.text("inserted")),
            );
            view.dispatch(view.state.tr.insert(pos + node.nodeSize, item));
        }

        expect(listFacts(ours)).toEqual(listFacts(stock));
        // The inserted item and everything after it really were re-labeled.
        expect(listFacts(ours)).toContain("ordered:4.");
    });

    it("deleting an item should re-label the remainder exactly as stock does", async () => {
        const ours = await make(DOC, false);
        const stock = await make(DOC, true);
        for (const view of [ours, stock]) {
            const { node, pos } = findFirst(view, "list_item");
            view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
        }

        expect(listFacts(ours)).toEqual(listFacts(stock));
        expect(listFacts(ours)).not.toContain("ordered:3.");
    });

    it("an inline edit inside an item should change no list fact", async () => {
        const ours = await make(DOC, false);
        const before = listFacts(ours);
        const { pos } = findFirst(ours, "list_item");

        ours.dispatch(ours.state.tr.insertText("X", pos + 2));

        expect(listFacts(ours)).toEqual(before);
    });

    it("a bullet list whose first item turns ordered should convert exactly as stock does", async () => {
        const ours = await make(DOC, false);
        const stock = await make(DOC, true);
        for (const view of [ours, stock]) {
            // The turn-into gesture the conversion branch exists for: mark the
            // bullet list's first item ordered and let the sync rewrite the list.
            const { node, pos } = findFirst(view, "bullet_list");
            const first = node.child(0);
            view.dispatch(view.state.tr.setNodeMarkup(pos + 1, undefined, {
                ...first.attrs, listType: "ordered",
            }));
        }

        expect(listFacts(ours)).toEqual(listFacts(stock));
        expect(listFacts(ours).filter((f) => f === "ordered_list")).toHaveLength(2);
    });
});

describe("listOrderSync registration", () => {
    it("the editor should run our sync and not the stock one", async () => {
        const ours = await make(DOC, false);
        const keys = ours.state.plugins.map((p) =>
            String((p.spec as { key?: { key?: string } }).key?.key ?? ""));

        expect(keys.some((k) => k.includes("BIRTA_KEEP_LIST_ORDER"))).toBe(true);
        expect(keys.some((k) => k.includes("MILKDOWN_KEEP_LIST_ORDER"))).toBe(false);
    });
});
