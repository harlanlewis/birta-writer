/**
 * List tightness (spread) round-trip fidelity (MAR-48).
 *
 * A tight list (no blank lines between items) must serialize back tight, and a
 * genuinely loose list (blank lines between items) must serialize back loose —
 * top-level, inside a blockquote, and inside directives/asides alike. These
 * run the REAL Milkdown editor with the production serialization config and
 * take the RAW serializer output (no minimalDiff protection), so they prove
 * tightness is preserved BY CONSTRUCTION rather than pinned at load time.
 *
 * Root cause guarded here: Milkdown's list schemas stored the `spread` attr as
 * a STRING ("true"/"false"); mdast-util-to-markdown only tightens output when
 * `spread` is a real boolean, so the string always fell through to the loose
 * separator. The list-schema overrides (plugins/list.ts) now parse `spread` as
 * a real boolean, so a freshly parsed doc is schema-valid (MAR-124) and tight
 * lists stay tight by construction; the fidelity serializer's coercion remains
 * as defense for the string form written by Milkdown's edit-time plugins.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView, Node as ProseNode } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { moveBlockAt } from "../components/blockMenu";

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
}

async function roundTrip(markdown: string): Promise<string> {
    const editor = await makeEditor(markdown);
    // Touch the view so the doc is fully built before serializing.
    editor.action((ctx) => ctx.get(editorViewCtx));
    const out = editor.action(getMarkdown());
    await editor.destroy();
    return out;
}

/** The freshly parsed ProseMirror doc for `markdown` (no edits applied). */
async function parseDoc(markdown: string): Promise<ProseNode> {
    const editor = await makeEditor(markdown);
    const doc = editor.action((ctx) => ctx.get(editorViewCtx)).state.doc as ProseNode;
    await editor.destroy();
    return doc;
}

/** Position of the one `list_item` whose whole text is `text`. */
function itemPosOf(doc: ProseNode, text: string): number {
    const hits: number[] = [];
    doc.descendants((node, pos) => {
        if (node.type.name === "list_item" && node.textContent === text) {
            hits.push(pos);
        }
        return true;
    });
    if (hits.length !== 1) {
        throw new Error(`expected exactly one list item reading "${text}", found ${hits.length}`);
    }
    return hits[0]!;
}

/**
 * Raw serializer output after reordering the item reading `text` by `dirs` —
 * one sibling hop per entry, so `(…, 1, -1)` is "move it down, then put it
 * back". Re-locates the item by its text between hops and throws when the
 * primitive refuses, so a test can never pass by having moved nothing.
 */
async function moveItem(markdown: string, text: string, ...dirs: (-1 | 1)[]): Promise<string> {
    const editor = await makeEditor(markdown);
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView;
    dirs.forEach((dir, step) => {
        if (!moveBlockAt(view, itemPosOf(view.state.doc, text), dir)) {
            throw new Error(`move ${step} of "${text}" (${dir}) was refused`);
        }
    });
    const out = editor.action(getMarkdown());
    await editor.destroy();
    return out;
}

/** typeof the `spread` attr of the first node of `typeName`, or "" if absent. */
function spreadTypeOf(doc: ProseNode, typeName: string): string {
    let found = "";
    doc.descendants((node) => {
        if (found === "" && node.type.name === typeName) {
            found = typeof node.attrs["spread"];
        }
        return found === "";
    });
    return found;
}

describe("tight lists stay tight on a raw round trip", () => {
    it("a top-level tight bullet list should not gain blank lines", async () => {
        const doc = "- item\n- item two\n\nAfter.\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a top-level tight ordered list should not gain blank lines", async () => {
        const doc = "1. one\n2. two\n3. three\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a tight list inside a blockquote should not gain blank lines", async () => {
        const doc = "> - item\n> - item two\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a tight list inside a directive should not gain blank lines", async () => {
        const doc = ":::note\n\n- item\n- item two\n\n:::\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a tight list inside an aside should not gain blank lines", async () => {
        const doc = "<aside>\n💡 Lead.\n\n- item\n- item two\n\n</aside>\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a tight nested list should keep the nested items tight", async () => {
        const doc = "- parent\n  - child one\n  - child two\n- sibling\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a tight ordered item with a nested sub-list should not gain a blank line (MAR-87)", async () => {
        // The exact regression: an ordered item followed by its nested ordered
        // sub-list used to gain a blank line between them on save (string
        // `spread` loosening the list), a byte-level round-trip break.
        const doc =
            "1. First step\n2. Second step\n   1. Sub-step a\n   2. Sub-step b\n3. Third step\n";
        expect(await roundTrip(doc)).toBe(doc);
    });
});

describe("loose lists stay loose on a raw round trip (no over-correction)", () => {
    it("a top-level loose bullet list should keep its blank lines", async () => {
        const doc = "- a\n\n- b\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a loose ordered list should keep its blank lines", async () => {
        const doc = "1. one\n\n2. two\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a list item with two paragraphs should keep the inner blank line", async () => {
        const doc = "- first paragraph\n\n  second paragraph\n\n- next item\n";
        expect(await roundTrip(doc)).toBe(doc);
    });
});

describe("partly-loose lists keep each gap as authored (MAR-194)", () => {
    // mdast has ONE `spread` boolean per list, so a list with a single interior
    // blank line parses as fully loose and used to re-emit a blank line between
    // EVERY item. The gap survives parsing as each item's source `position`,
    // which plugins/list.ts records per item and the serializer's join reads
    // back. These take the RAW serializer output, so they prove the gaps are
    // right BY CONSTRUCTION rather than pinned by minimal-diff at save time.

    it("a list with one interior blank line should round-trip byte-identically", async () => {
        const doc = "- foo\n- bar\n- baz\n\n- bingo\n- wingo\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("two lists differing ONLY in where the blank line sits should stay distinct", async () => {
        // The sharpest form of the bug: these parse to identical mdast trees
        // (list.spread true, every item spread false), so before the per-gap
        // fix they serialized to the same fully-loose bytes and one of the two
        // files was silently rewritten into the other.
        const blankEarly = "- a\n\n- b\n- c\n";
        const blankLate = "- a\n- b\n\n- c\n";
        expect(await roundTrip(blankEarly)).toBe(blankEarly);
        expect(await roundTrip(blankLate)).toBe(blankLate);
    });

    it("the partly-loose corpus fixture should serialize back byte-identically", async () => {
        // The corpus gates (roundTripCorpus / corpusMoveSampling) do NOT catch
        // this class: invariant A is a zero-edit save, which minimal-diff's
        // round-trip protection absorbs, and invariant B only checks that
        // significant lines survive — never where a blank line sits. So the
        // fixture is held to the RAW serializer here, which is the layer the
        // bug actually lives in. Verified to fail without the per-gap join.
        const fixture = readFileSync(
            join(__dirname, "fixtures", "partly-loose-lists.md"),
            "utf8",
        );
        expect(await roundTrip(fixture)).toBe(fixture);
    });

    it("a partly-loose ordered list should keep its gap in place", async () => {
        const doc = "1. one\n2. two\n\n3. three\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a partly-loose nested list should keep the nested gap too", async () => {
        // The sub-list needs THREE items to be partly loose: a two-item list has
        // a single gap, which list-level `spread` already describes exactly.
        const doc = "- parent\n  - child one\n  - child two\n\n  - child three\n- sibling\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a fully tight and a fully loose list should still round-trip unchanged", async () => {
        // The per-gap join must not disturb the uniform cases it now also owns.
        expect(await roundTrip("- a\n- b\n- c\n")).toBe("- a\n- b\n- c\n");
        expect(await roundTrip("- a\n\n- b\n\n- c\n")).toBe("- a\n\n- b\n\n- c\n");
    });
});

describe("a reordered item takes the gap it landed in (MAR-210)", () => {
    // The residue of MAR-194. `annotateItemGaps` starts at index 1, so the FIRST
    // item of every list has no recorded gap — there is nothing before it to
    // measure. Deferring to mdast's default for it is not neutral: that default
    // is the LIST-level `spread`, which one interior blank line makes true for
    // the whole list, so a reorder that landed the first item mid-list drew its
    // gap from the whole list and wrote a blank line the author never typed.
    // The serializer's join now reads the gap off the item's new neighbours.

    it("moving the first item of a partly-loose list down should not invent a blank line", async () => {
        // The ticket's repro. The authored blank sits between `c` and `d` and
        // nowhere else; before the fix this emitted `- b\n\n- a\n- c\n\n- d\n`.
        expect(await moveItem("- a\n- b\n- c\n\n- d\n", "a", 1)).toBe("- b\n- a\n- c\n\n- d\n");
    });

    it("moving the last item of a partly-loose list to the front should not invent one either", async () => {
        // The other end of the same hole: `d`'s own recorded blank travels with
        // it and then evaporates (a first item's gap is never emitted), which
        // leaves `a` mid-list with nothing recorded. Before the fix: an invented
        // blank before `a`.
        expect(await moveItem("- a\n- b\n- c\n\n- d\n", "d", -1, -1, -1)).toBe(
            "- d\n- a\n- b\n- c\n",
        );
    });

    it("moving the first item of a partly-loose list to the end should join the run it lands in", async () => {
        // No follower to read, so the nearest evidence is the last recorded gap
        // of the run it joined — `d`'s. The loose tail stays loose.
        expect(await moveItem("- a\n- b\n- c\n\n- d\n", "a", 1, 1, 1)).toBe(
            "- b\n- c\n\n- d\n\n- a\n",
        );
    });

    it("a first item moved into a tight run should keep that run tight", async () => {
        // The predecessor fallback in the other direction: the blank the author
        // wrote belonged to `b`, which is now first, so it is gone and the run
        // `a` joins is tight.
        expect(await moveItem("- a\n\n- b\n- c\n", "a", 1, 1)).toBe("- b\n- c\n- a\n");
    });

    it("a partly-loose ordered list should behave the same", async () => {
        expect(await moveItem("1. a\n2. b\n3. c\n\n4. d\n", "a", 1)).toBe(
            "1. b\n2. a\n3. c\n\n4. d\n",
        );
    });

    it("moving the first item of a FULLY LOOSE list down should keep the blank line", async () => {
        // The over-correction the ticket warns about: recording `false` for the
        // first item would tighten a gap the author really did write.
        expect(await moveItem("- a\n\n- b\n\n- c\n", "a", 1)).toBe("- b\n\n- a\n\n- c\n");
        expect(await moveItem("- a\n\n- b\n\n- c\n", "a", 1, 1)).toBe("- b\n\n- c\n\n- a\n");
    });

    it("moving the first item of a TIGHT list down should keep it tight", async () => {
        expect(await moveItem("- a\n- b\n- c\n", "a", 1)).toBe("- b\n- a\n- c\n");
        expect(await moveItem("- a\n- b\n- c\n", "a", 1, 1)).toBe("- b\n- c\n- a\n");
    });

    // A recorded gap travels with its item, so a hop and its reverse must land
    // back on the source bytes — the property that makes "travel with the item"
    // defensible in the first place, and the one an observational rule for the
    // gapless first item could quietly break. Enumerated over every item and
    // both directions rather than sampled, since the first and last items are
    // exactly the ones with an edge case.
    const REVERSIBLE: Array<{ name: string; doc: string; items: string[] }> = [
        { name: "tight", doc: "- a\n- b\n- c\n", items: ["a", "b", "c"] },
        { name: "fully loose", doc: "- a\n\n- b\n\n- c\n", items: ["a", "b", "c"] },
        { name: "partly loose, gap late", doc: "- a\n- b\n- c\n\n- d\n", items: ["a", "b", "c", "d"] },
        { name: "partly loose, gap early", doc: "- a\n\n- b\n- c\n- d\n", items: ["a", "b", "c", "d"] },
        { name: "ordered, partly loose", doc: "1. a\n2. b\n3. c\n\n4. d\n", items: ["a", "b", "c", "d"] },
    ];
    for (const shape of REVERSIBLE) {
        for (const [index, text] of shape.items.entries()) {
            for (const dir of [-1, 1] as const) {
                // Skip the hop that does not exist at the list's edges.
                if (dir === -1 && index === 0) continue;
                if (dir === 1 && index === shape.items.length - 1) continue;
                const way = dir === 1 ? "down" : "up";
                it(`${shape.name}: moving "${text}" ${way} and back should restore the source bytes`, async () => {
                    expect(await moveItem(shape.doc, text, dir, -dir as -1 | 1)).toBe(shape.doc);
                });
            }
        }
    }
});

describe("freshly parsed lists carry a boolean spread attr (MAR-124)", () => {
    // Milkdown's stock runners stored `spread` as the STRING "true"/"false",
    // which fails the schema's own `validate: "boolean"` on every parsed list
    // — so doc.check() threw before a single edit. The list-schema overrides
    // (plugins/list.ts) coerce it to a real boolean at parse time.
    it("a doc with a bullet list passes doc.check()", async () => {
        const doc = await parseDoc("- a\n- b\n\nAfter.\n");
        expect(() => doc.check()).not.toThrow();
    });

    it("a doc with an ordered list passes doc.check()", async () => {
        const doc = await parseDoc("1. one\n2. two\n");
        expect(() => doc.check()).not.toThrow();
    });

    it("a doc with a loose list and nested sublist passes doc.check()", async () => {
        const doc = await parseDoc("- a\n\n- b\n  - nested\n  - nested two\n");
        expect(() => doc.check()).not.toThrow();
    });

    it("stores bullet_list and list_item spread as real booleans", async () => {
        const doc = await parseDoc("- a\n\n- b\n"); // loose → spread true
        expect(spreadTypeOf(doc, "bullet_list")).toBe("boolean");
        expect(spreadTypeOf(doc, "list_item")).toBe("boolean");
    });

    it("stores ordered_list spread as a real boolean", async () => {
        const doc = await parseDoc("1. one\n2. two\n");
        expect(spreadTypeOf(doc, "ordered_list")).toBe("boolean");
    });
});
