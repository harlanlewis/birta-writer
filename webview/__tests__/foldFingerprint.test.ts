/**
 * Invalidation guard for the fold-decoration cache (cache review, 2026-07-24).
 *
 * The fold plugin reuses its DecorationSet (merely position-mapping the widget
 * DOM) while `structureFingerprint` is unchanged, and rebuilds it when the
 * fingerprint changes. That is only correct if EVERY input the decorations
 * depend on is folded into the fingerprint — a decoration input left out would
 * silently reuse stale widgets. These tests pin the currently-known inputs
 * (enabled, folded/collapsed, heading level, foldability) so a refactor that
 * drops one from the fingerprint fails, and pin that POSITION is deliberately
 * NOT an input (so a plain text edit reuses-and-maps rather than rebuilds).
 *
 * They cannot anticipate a NEW decoration input added in the future — that
 * still needs its own case here — but they lock the guard's current contract.
 *
 * Driven through the real Milkdown editor so the doc + ranges match production.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { headingFoldPlugin, foldRevealKeymapPlugin } from "../plugins/headingFold";
import { computeFoldRanges, isHeadingNode } from "../plugins/headingFold/foldModel";
import { structureFingerprint } from "../plugins/headingFold/foldDecorations";

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
        .use(foldRevealKeymapPlugin)
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(headingFoldPlugin)
        .create();
    editors.push(editor);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Every top-level heading's doc position, in order. */
function headingPositions(doc: any): number[] {
    const positions: number[] = [];
    doc.forEach((node: any, offset: number) => {
        if (isHeadingNode(node)) { positions.push(offset); }
    });
    return positions;
}

/** The fingerprint for a doc at a given (folded, enabled), ranges computed. */
function fp(doc: any, folded: Set<number>, enabled: boolean): string {
    return structureFingerprint(doc, folded, computeFoldRanges(doc), enabled);
}

afterEach(async () => {
    for (const e of editors) { await e.destroy(); }
    editors = [];
    document.body.innerHTML = "";
});

describe("structureFingerprint — every decoration input is captured", () => {
    it("toggling the enabled flag should change the fingerprint", async () => {
        const doc = view(await makeEditor("# Alpha\n\nbody\n\n## Beta\n\nmore")).state.doc;
        expect(fp(doc, new Set(), true)).not.toBe(fp(doc, new Set(), false));
    });

    it("folding a heading should change the fingerprint (the collapsed flag)", async () => {
        const doc = view(await makeEditor("# Alpha\n\nbody\n\n## Beta\n\nmore")).state.doc;
        const [firstHeading] = headingPositions(doc);
        const unfolded = fp(doc, new Set(), true);
        const folded = fp(doc, new Set([firstHeading]), true);
        expect(folded).not.toBe(unfolded);
    });

    it("a different heading level should change the fingerprint", async () => {
        const h1 = view(await makeEditor("# Alpha\n\nbody")).state.doc;
        const h2 = view(await makeEditor("## Alpha\n\nbody")).state.doc;
        expect(fp(h1, new Set(), true)).not.toBe(fp(h2, new Set(), true));
    });

    it("gaining foldable content should change the fingerprint (foldability flag)", async () => {
        // A trailing heading with no section body is not foldable; add a body
        // and it becomes foldable — the fingerprint must reflect that.
        const noBody = view(await makeEditor("# Alpha\n\nbody\n\n## Beta")).state.doc;
        const withBody = view(await makeEditor("# Alpha\n\nbody\n\n## Beta\n\nnow has a section")).state.doc;
        const betaNoBody = headingPositions(noBody)[1];
        const betaWithBody = headingPositions(withBody)[1];
        // Isolate the foldability change by fingerprinting each doc's own Beta;
        // structure is identical except Beta gained a foldable range.
        const a = structureFingerprint(noBody, new Set(), computeFoldRanges(noBody), true);
        const b = structureFingerprint(withBody, new Set(), computeFoldRanges(withBody), true);
        expect(a).not.toBe(b);
        // And the ranges map genuinely differs at Beta (the guard's input).
        expect(Boolean(computeFoldRanges(noBody).get(betaNoBody))).toBe(false);
        expect(Boolean(computeFoldRanges(withBody).get(betaWithBody))).toBe(true);
    });

    it("a position-only edit (same structure, shifted text) should NOT change the fingerprint", async () => {
        // The load-bearing invariant behind reuse-and-map: two docs with
        // identical heading structure but different body lengths fingerprint
        // identically, so a plain text edit maps the cached widgets forward
        // instead of rebuilding them.
        const short = view(await makeEditor("# Alpha\n\nx\n\n## Beta\n\ny")).state.doc;
        const long = view(await makeEditor(
            "# Alpha\n\na much longer paragraph body\n\n## Beta\n\nanother longer body here",
        )).state.doc;
        expect(fp(short, new Set(), true)).toBe(fp(long, new Set(), true));
    });
});
