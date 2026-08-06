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

    // ── The conversion branch: deliberate divergence from stock ─────────────
    // Stock passes the sub-walk's RELATIVE child positions to setNodeMarkup,
    // which is only correct for a list at document position 0. The shape below
    // (content before the bullet list) is reachable by dragging an ordered
    // item into a bullet list's first slot and then making any structural
    // list edit; in stock the append THROWS and the user's edit dies. Ours
    // converts correctly. The stock-behavior tests are TRIPWIRES: when a
    // Milkdown upgrade fixes upstream, they fail, and the divergence notes in
    // listOrderSync.ts come out.
    const CONVERT_DOC = "# Head\n\nProse before the list.\n\n- alpha\n- beta\n- gamma\n";

    function armConversion(view: EditorView): void {
        const { node, pos } = findFirst(view, "bullet_list");
        view.dispatch(view.state.tr.setNodeMarkup(pos + 1, undefined, {
            ...node.child(0).attrs, listType: "ordered",
        }));
    }

    it("a mid-document bullet list whose first item turns ordered should convert in place", async () => {
        const ours = await make(CONVERT_DOC, false);
        armConversion(ours);

        const facts = listFacts(ours);
        expect(facts[0]).toBe("ordered_list");
        // Labels are re-derived in place. The non-first items' listType attr
        // stays stale until a later generic pass — upstream's design, kept:
        // the sub-walk fixes labels only, and the conversion transaction is
        // history-exempt so the sync skips its own output. The serializer
        // keys off the list node type, so the file is right regardless.
        expect(facts.slice(1)).toEqual(["ordered:1.", "bullet:2.", "bullet:3."]);
        // The heading before the list is untouched (the mis-target's victim).
        expect(findFirst(ours, "heading").node.textContent).toBe("Head");
    });

    it("TRIPWIRE: stock still throws on the same gesture (drop the divergence when this fails)", async () => {
        const stock = await make(CONVERT_DOC, true);

        expect(() => armConversion(stock)).toThrowError(/text nodes/);
    });

    it("an item with a stale listType but a correct label should still be corrected", async () => {
        const ours = await make(DOC, false);
        const { node, pos } = findFirst(ours, "list_item"); // first ordered item
        // Poison the listType while keeping the label right, then make a
        // structural list edit so the sync pass runs.
        ours.dispatch(ours.state.tr.setNodeMarkup(pos, undefined, {
            ...node.attrs, listType: "bullet",
        }));
        const last = (() => { let l = { node, pos }; ours.state.doc.descendants((n, p) => {
            if (n.type.name === "list_item") l = { node: n, pos: p }; return true; }); return l; })();
        ours.dispatch(ours.state.tr.delete(last.pos, last.pos + last.node.nodeSize));

        expect(listFacts(ours)).toContain("ordered:1.");
        expect(listFacts(ours)).not.toContain("bullet:1.");
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
