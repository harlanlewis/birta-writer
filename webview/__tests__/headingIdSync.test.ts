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
import * as fs from "fs";
import * as path from "path";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, editorStateOptionsCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import type { EditorView, Node as PmNode } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { configureHeadingIds } from "../plugins/headingIdSync";

let editors: Editor[] = [];

async function makeOurs(markdown: string): Promise<EditorView> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureHeadingIds(ctx);
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

function headingIds(source: EditorView | PmNode): unknown[] {
    const ids: unknown[] = [];
    const doc = "state" in source ? source.state.doc : source;
    doc.descendants((node) => {
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

    /**
     * The ids are seeded onto the parsed document before the state is built,
     * so the mount pass has nothing left to do and the view never redraws a
     * heading to receive one. DOC IDENTITY is the assertion that can tell the
     * difference: a transaction, however tagged, replaces `state.doc` with a
     * new node, so `toBe` on the seeded document fails the moment the seed
     * stops working and the mount pass starts dispatching again. Asserting the
     * ids alone cannot see that, because both routes arrive at the same ids.
     */
    it("seeding should leave the mount pass nothing to dispatch", async () => {
        const root = document.createElement("div");
        document.body.appendChild(root);
        let seeded: PmNode | undefined;
        const editor = await Editor.make()
            .config((ctx) => {
                ctx.set(rootCtx, root);
                ctx.set(defaultValueCtx, DOC);
                configureHeadingIds(ctx);
                // Runs after the seed, so `doc` here is what the seed produced.
                ctx.update(editorStateOptionsCtx, (prev) => (options) => {
                    const out = prev(options);
                    seeded = out.doc;
                    return out;
                });
                configureSerialization(ctx);
            })
            .use(pureCommonmark)
            .use(gfmFidelity)
            .create();
        editors.push(editor);
        const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView;

        // The seed ran, and ran on a document that actually has headings.
        expect(seeded).toBeDefined();
        expect(headingIds(seeded!)).toContain("beta-#2");

        // Nothing replaced it: the document the view holds IS the seeded one.
        expect(view.state.doc).toBe(seeded);
    });

    /**
     * The control arm for the case above. Without the seed the mount pass has
     * work to do and dispatches, so `state.doc` is NOT the parsed document.
     * Without this, the identity assertion could be passing because nothing
     * ever dispatches at mount for some unrelated reason, and it would go on
     * passing if the seed were deleted.
     */
    it("without the seed, the mount pass should replace the document instead", async () => {
        const root = document.createElement("div");
        document.body.appendChild(root);
        let parsed: PmNode | undefined;
        const editor = await Editor.make()
            .config((ctx) => {
                ctx.set(rootCtx, root);
                ctx.set(defaultValueCtx, DOC);
                // configureHeadingIds deliberately NOT called.
                ctx.update(editorStateOptionsCtx, (prev) => (options) => {
                    const out = prev(options);
                    parsed = out.doc;
                    return out;
                });
                configureSerialization(ctx);
            })
            .use(pureCommonmark)
            .use(gfmFidelity)
            .create();
        editors.push(editor);
        const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView;

        expect(parsed).toBeDefined();
        // The parsed document carries no ids, which is what makes the pass work.
        expect(headingIds(parsed!).every((id) => !id)).toBe(true);
        // And the pass dispatched, so the view holds a different document.
        expect(view.state.doc).not.toBe(parsed);
        expect(headingIds(view)).toContain("beta-#2");
    });

    /**
     * Nothing about the IDS can tell you whether the seed is still wired up.
     * Delete `configureHeadingIds(ctx)` from the composition root and every
     * behavioural case in this file still passes, because the mount pass
     * assigns the same ids a moment later; what is lost is only the second
     * whole-document render, and no assertion about ids can see a render.
     *
     * The launch gate would eventually notice, since its heading-bearing
     * fixtures would slow down, but a delta gate reports that something got
     * slower and this names which thing. Source-level for the same reason
     * pmFunnel and hostProfile are: the property is about a call site, not
     * about a value any test can read back.
     */
    it("the editor's composition root should wire the seed", () => {
        const root = fs.readFileSync(path.resolve(__dirname, "..", "editor.ts"), "utf8");
        expect(root).toContain("configureHeadingIds(ctx)");
    });

    it("a seeded document should still take id maintenance when a heading is edited", async () => {
        const ours = await makeOurs(DOC);
        const before = ours.state.doc;

        const { pos } = findTextblock(ours, "Gamma");
        ours.dispatch(ours.state.tr.insertText("Delta ", pos + 1));

        expect(ours.state.doc).not.toBe(before);      // the edit landed
        expect(headingIds(ours)).toContain("delta-gamma");
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
