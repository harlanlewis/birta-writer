/**
 * utils/blockDom.ts pairs every block node with its element in one walk of
 * the view's DOM, where `view.nodeDOM` walks the view from the root once per
 * position. Two things are held here, and the second is what makes the first
 * worth anything: the answers equal `nodeDOM`'s for every block position, and
 * they were read by the lockstep rather than by falling back to `nodeDOM`
 * per position, because a helper that fell back everywhere would pass the
 * equality trivially while costing exactly what it replaced.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/core";
import type { EditorView, Node as ProseNode } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import { blockDomResolver, topLevelBlockDoms } from "../utils/blockDom";
import { createBoundaryMeasurer } from "../components/blockMenu";

// Every block kind the commonmark and GFM presets render, nested where the
// schema allows: a list inside a list item, a paragraph and a list inside a
// blockquote, a leaf (the rule) between textblocks, and a table, whose cells
// are the deepest blocks here.
const DOC = `# Title

Alpha paragraph with **bold** and a [link](https://example.com).

- one
- two
  - nested a
  - nested b
- three

1. first
2. second

> quoted paragraph
>
> - quoted item

\`\`\`js
const x = 1;
\`\`\`

---

| a | b |
| - | - |
| 1 | 2 |

Omega paragraph.
`;

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
        .use(headingFoldPlugin)
        .create();
    editors.push(editor);
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Every block node's position, textblocks included, their inline content never entered. */
function blockPositions(doc: ProseNode): number[] {
    const out: number[] = [];
    doc.descendants((node, pos) => {
        if (node.isInline) return false;
        out.push(pos);
        return !node.isTextblock;
    });
    return out;
}

afterEach(async () => {
    for (const editor of editors) await editor.destroy();
    editors = [];
    document.body.innerHTML = "";
});

describe("blockDomResolver", () => {
    it("every block position should resolve to the element nodeDOM names, without asking nodeDOM", async () => {
        const view = await makeEditor(DOC);
        const positions = blockPositions(view.state.doc);
        // The corpus has to hold enough kinds for the equality to mean
        // anything: nested lists, a quote's children and table cells all
        // pair through a different content element than a top-level block.
        expect(positions.length).toBeGreaterThan(25);

        const spy = vi.spyOn(view, "nodeDOM");
        const domAt = blockDomResolver(view);
        expect(spy).not.toHaveBeenCalled();

        let reached = 0;
        for (const pos of positions) {
            const expected = view.nodeDOM(pos);
            expect(domAt(pos)).toBe(expected);
            if (expected instanceof HTMLElement) reached++;
        }
        // The equality above is only evidence if the lockstep found the
        // elements itself: `nodeDOM` was called by the assertion's own
        // oracle, once per position, and by nothing else.
        expect(spy).toHaveBeenCalledTimes(positions.length);
        expect(reached).toBe(positions.length);
    });

    it("after structural edits the lockstep should still pair every block itself", async () => {
        // A drag reads the state edits left, never a fresh editor's: the
        // descs of inserted blocks are new, the rest were reconciled, and
        // the walk has to pair every one by identity without a fallback.
        const view = await makeEditor(DOC);
        const paragraph = view.state.schema.nodes["paragraph"]!;
        for (let i = 0; i < 3; i++) {
            const end = view.state.doc.content.size;
            view.dispatch(view.state.tr.insert(end, paragraph.create(null, view.state.schema.text(`added ${i}`))));
        }
        view.dispatch(view.state.tr.delete(0, view.state.doc.child(0).nodeSize));
        const positions = blockPositions(view.state.doc);
        const spy = vi.spyOn(view, "nodeDOM");
        const domAt = blockDomResolver(view);
        const fallbacks = spy.mock.calls.length;
        for (const pos of positions) expect(domAt(pos)).toBe(view.nodeDOM(pos));
        // Every position paired by identity: the resolver asked nothing.
        expect(fallbacks).toBe(0);
    });

    it("a position the walk did not reach should fall through to nodeDOM", async () => {
        const view = await makeEditor(DOC);
        const domAt = blockDomResolver(view);
        const spy = vi.spyOn(view, "nodeDOM");
        // Inside the first paragraph's text: no block starts there.
        const inline = 3;
        expect(domAt(inline)).toBe(view.nodeDOM(inline) instanceof HTMLElement ? view.nodeDOM(inline) : null);
        expect(spy).toHaveBeenCalled();
    });
});

describe("topLevelBlockDoms", () => {
    it("should list the document's children in order with nodeDOM's elements", async () => {
        const view = await makeEditor(DOC);
        const spy = vi.spyOn(view, "nodeDOM");
        const entries = topLevelBlockDoms(view);
        expect(spy).not.toHaveBeenCalled();
        expect(entries.length).toBe(view.state.doc.childCount);
        let offset = 0;
        view.state.doc.forEach((node, pos) => {
            const entry = entries[offset++]!;
            expect(entry.node).toBe(node);
            expect(entry.pos).toBe(pos);
            expect(entry.dom).toBe(view.nodeDOM(pos));
            expect(entry.dom).toBeInstanceOf(HTMLElement);
        });
    });
});

describe("the drag's boundary plan", () => {
    it("should resolve every slot's element through the one walk, not a nodeDOM per slot", async () => {
        const view = await makeEditor(DOC);
        const spy = vi.spyOn(view, "nodeDOM");
        // jsdom has no layout, so every rect is zero and the measurer drops
        // the slots as invisible; the plan behind it still resolved every
        // slot's element, which is what the spy watches.
        createBoundaryMeasurer().measure(view);
        expect(spy).not.toHaveBeenCalled();
    });
});
