/**
 * Tests for the hardened block-move primitive (MAR-112, editing/moveBlocks):
 * source-range integrity (the fe6a1fe malformed-range class fails loudly),
 * explicit pre-transaction fit (the code-block-split class is refused before
 * the content guard would see a transaction), fold-hidden target legality
 * through the shared registry the drag UI consumes, the single allowed
 * normalization (dissolving an emptied parent), fold side-state riding the
 * move, and veto awareness (false + no landing flash when a filter kills the
 * dispatch).
 *
 * Drives the REAL Milkdown editor (real parser, real schema, the production
 * serialization config) with the fold and guard plugins registered, exactly
 * like the browser. acquireVsCodeApi is injected by setup.ts.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, parserCtx, serializerCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import type { Node as ProseNode } from "../pm";
import { Plugin } from "../pm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    allFoldablePositions,
    foldedHiddenRanges,
    headingFoldPlugin,
    headingFoldPluginKey,
    isHiddenTargetPos,
    type HeadingFoldMeta,
} from "../plugins/headingFold";
import { historyPlugin } from "../plugins/history";
import {
    checkMove,
    contentGuardKey,
    contentGuardPlugin,
    diffFingerprints,
    fingerprintDoc,
    formatFingerprintDiff,
} from "../plugins/contentGuard";
import { dissolvedMarkersFor, moveBlocks, moveFits } from "../editing/moveBlocks";
import { moveRangeAt } from "../components/blockMenu";
import {
    blockBoundaryPositions,
    visibleBoundaryPositions,
} from "../components/blockMenu/drag";
import { flashRange } from "../components/blockMenu/rangeIndicator";

// The landing flash is a geometry no-op under jsdom; mock it so the "skip
// the flash" contracts are observable.
vi.mock("../components/blockMenu/rangeIndicator", () => ({
    flashRange: vi.fn(),
    showRangeVeil: vi.fn(),
    hideRangeVeil: vi.fn(),
}));

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
        .use(historyPlugin)
        .use(contentGuardPlugin)
        .create();
    editors.push(editor);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function markdown(editor: Editor): string {
    return editor.action(getMarkdown()).trim();
}

/** Position of the first node whose text matches, or -1. */
function nodePos(v: EditorView, text: string, type?: string): number {
    let found = -1;
    v.state.doc.descendants((node: ProseNode, pos: number) => {
        if (found === -1 && node.textContent === text && (!type || node.type.name === type)) {
            found = pos;
        }
        return found === -1;
    });
    return found;
}

/**
 * Text of every block the fold decoration currently hides — the independent
 * observable for "did content vanish". Read from the DOM class the decoration
 * pass stamps (what actually drives display:none), NOT from the fold set or
 * foldedHiddenRanges: those are the state the fix manipulates, so asserting on
 * them would only restate the mechanism.
 */
function hiddenBlockTexts(v: EditorView): string[] {
    return Array.from(v.dom.querySelectorAll(".heading-fold-hidden")).map(
        (el) => el.textContent ?? "",
    );
}

let errorSpy: ReturnType<typeof vi.spyOn>;

/** The [moveBlocks] console.error lines emitted so far. */
function refusals(): string[] {
    return errorSpy.mock.calls
        .map((args) => args.map(String).join(" "))
        .filter((line) => line.includes("[moveBlocks]"));
}

/** The [ContentGuard] console.error lines emitted so far. */
function guardErrors(): string[] {
    return errorSpy.mock.calls
        .map((args) => args.map(String).join(" "))
        .filter((line) => line.includes("[ContentGuard]"));
}

beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
    errorSpy.mockRestore();
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

// ── Contract 2: source range integrity ──────────────────────────────────────

describe("moveBlocks — source range integrity", () => {
    it("a source range starting inside a text block should be a loud no-op", async () => {
        const editor = await makeEditor("Alpha\n\nBravo");
        const v = view(editor);
        const before = markdown(editor);
        // from: 1 points INSIDE the Alpha paragraph, not at a block boundary.
        const alpha = v.state.doc.nodeAt(0)!;
        expect(moveBlocks(v, { from: 1, to: alpha.nodeSize }, v.state.doc.content.size)).toBe(false);
        expect(markdown(editor)).toBe(before);
        expect(refusals().length).toBe(1);
    });

    it("a source range ending mid-child should be refused, never partially deleted", async () => {
        const editor = await makeEditor("Alpha\n\nBravo");
        const v = view(editor);
        const before = markdown(editor);
        const alpha = v.state.doc.nodeAt(0)!;
        // Covers Alpha's start but stops one position short of its end.
        expect(
            moveBlocks(v, { from: 0, to: alpha.nodeSize - 1 }, v.state.doc.content.size),
        ).toBe(false);
        expect(markdown(editor)).toBe(before);
        expect(refusals().some((line) => line.includes("does not cleanly cover"))).toBe(true);
    });

    it("the fe6a1fe class (a nested block's range escaping its container) should be refused loudly", async () => {
        const editor = await makeEditor("> ## Nested\n> after\n\nOutside");
        const v = view(editor);
        const before = markdown(editor);
        const headingPos = nodePos(v, "Nested", "heading");
        expect(headingPos).toBeGreaterThan(-1);
        // The historical bug shape: section semantics computed at the wrong
        // depth hand in a range that starts inside the blockquote but ends
        // at a TOP-LEVEL offset past it. The old primitive would deleteRange
        // the whole span and re-insert only the quote's children — data loss.
        expect(moveBlocks(v, { from: headingPos, to: v.state.doc.content.size }, 0)).toBe(false);
        expect(markdown(editor)).toBe(before);
        expect(refusals().some((line) => line.includes("does not cleanly cover"))).toBe(true);
    });
});

// ── Contract 3: explicit fit, pre-transaction ───────────────────────────────

describe("moveBlocks — explicit target fit", () => {
    it("a target at a code block's interior boundary should be refused with NO transaction dispatched", async () => {
        const editor = await makeEditor("Alpha\n\n```js\nconst x = 1;\n```");
        const v = view(editor);
        const before = markdown(editor);
        const codePos = nodePos(v, "const x = 1;", "code_block");
        expect(codePos).toBeGreaterThan(-1);
        const dispatchSpy = vi.spyOn(v, "dispatch");
        const range = moveRangeAt(v, 0)!; // the Alpha paragraph
        // codePos + 1: the boundary at the START of the code text — a
        // paragraph "fits" there only by splitting the block (the
        // code-block-split class). canReplace refuses it structurally.
        expect(moveBlocks(v, range, codePos + 1)).toBe(false);
        expect(dispatchSpy).not.toHaveBeenCalled(); // BEFORE the guard, not caught BY it
        expect(guardErrors()).toEqual([]);
        expect(refusals().some((line) => line.includes("cannot hold"))).toBe(true);
        expect(markdown(editor)).toBe(before);
        expect(flashRange).not.toHaveBeenCalled();
    });

    it("a target inside a text node should be refused as a non-boundary", async () => {
        const editor = await makeEditor("Alpha\n\nBravo");
        const v = view(editor);
        const before = markdown(editor);
        const bravoPos = nodePos(v, "Bravo");
        const range = { from: bravoPos, to: bravoPos + v.state.doc.nodeAt(bravoPos)!.nodeSize };
        const dispatchSpy = vi.spyOn(v, "dispatch");
        expect(moveBlocks(v, range, 2)).toBe(false); // inside "Alpha"'s text
        expect(dispatchSpy).not.toHaveBeenCalled();
        expect(refusals().some((line) => line.includes("not at a node boundary"))).toBe(true);
        expect(markdown(editor)).toBe(before);
    });
});

// ── Contract 3, source side: the vacated parent must survive ────────────────

describe("moveBlocks — explicit source fit", () => {
    /**
     * The arrangement the source-side clause exists to prevent, reached the
     * way the primitive USED to reach it (deleteRange + insert, no fit check
     * on the vacated parent). This is the "why" pin: it demonstrates that
     * every other defense passes the corrupt result, so removing the clause
     * cannot be made safe by leaning on the guard or on doc.check().
     */
    it("stranding a list item's leading paragraph should survive both other defenses yet break round-trip", async () => {
        const editor = await makeEditor("- item one\n\n  > quoted inside item\n\n- item two");
        const v = view(editor);
        const paraPos = nodePos(v, "item one", "paragraph");
        const para = v.state.doc.nodeAt(paraPos)!;
        const quotePos = paraPos + para.nodeSize;
        const quoteEnd = quotePos + v.state.doc.nodeAt(quotePos)!.nodeSize;

        // The raw steps the primitive would have taken: hop the leading
        // paragraph past the blockquote inside its own item.
        const tr = v.state.tr.deleteRange(paraPos, paraPos + para.nodeSize);
        tr.insert(tr.mapping.map(quoteEnd), para);
        const stranded = tr.doc;

        // `list_item` is `paragraph block*`, so the remainder no longer fits —
        // and replaceStep REPAIRS it rather than refusing, re-heading the item
        // with an EMPTY paragraph nobody asked for.
        const item = stranded.child(0).child(0);
        expect(item.type.name).toBe("list_item");
        expect(item.child(0).type.name).toBe("paragraph");
        expect(item.child(0).textContent).toBe(""); // the injected filler
        expect(item.child(1).type.name).toBe("blockquote");

        // Defense 1 — the schema: passes. The filler makes it VALID.
        expect(() => stranded.check()).not.toThrow();

        // Defense 2 — the content guard: passes. Asked through the guard's OWN
        // oracle (checkMove — the function the runtime guard runs), not a
        // hand-rolled equivalent. Its fingerprint ignores empty paragraphs
        // (MAR-123: they serialize to nothing, so they are not content), so the
        // injected filler is invisible to conservation.
        expect(
            checkMove(
                diffFingerprints(fingerprintDoc(v.state.doc), fingerprintDoc(stranded)),
                new Set(dissolvedMarkersFor(v.state.doc, { from: paraPos, to: paraPos + para.nodeSize })),
            ),
        ).toBeNull();

        // Defense 3 — the round trip: FAILS. The empty leading paragraph
        // serializes to a bare `-` marker line, which on reparse ends the list
        // and splits the rest into a second one. Silent corruption at
        // save+reopen — invisible until the file is reopened.
        const serialized = editor.action((ctx) => ctx.get(serializerCtx)(stranded));
        expect(serialized).toMatch(/^-\s*$/m); // the bare, contentless marker
        const reparsed = editor.action((ctx) => ctx.get(parserCtx)(serialized))!;
        expect(
            formatFingerprintDiff(
                diffFingerprints(fingerprintDoc(stranded), fingerprintDoc(reparsed)),
            ),
        ).toBe("lost: (none); gained: count:bullet_list");
    });

    it("a move that would strand its source parent should be refused with NO transaction dispatched", async () => {
        const editor = await makeEditor("- item one\n\n  > quoted inside item\n\n- item two");
        const v = view(editor);
        const before = markdown(editor);
        const docBefore = v.state.doc;
        const paraPos = nodePos(v, "item one", "paragraph");
        const para = v.state.doc.nodeAt(paraPos)!;
        const quotePos = paraPos + para.nodeSize;
        const quoteEnd = quotePos + v.state.doc.nodeAt(quotePos)!.nodeSize;
        const dispatchSpy = vi.spyOn(v, "dispatch");

        expect(moveBlocks(v, { from: paraPos, to: paraPos + para.nodeSize }, quoteEnd)).toBe(false);

        expect(dispatchSpy).not.toHaveBeenCalled(); // BEFORE the guard, not caught BY it
        expect(guardErrors()).toEqual([]);
        expect(refusals().some((line) => line.includes("would strand list_item"))).toBe(true);
        expect(v.state.doc).toBe(docBefore); // a refused move is a PERFECT no-op
        expect(markdown(editor)).toBe(before);
        expect(flashRange).not.toHaveBeenCalled();
    });

    // The dissolution exemption this clause must NOT swallow (a move that
    // empties its source parent entirely) is pinned by the two "allowed
    // normalization" tests below — not duplicated here.

    it("moveFits should agree with the primitive on a stranding move", async () => {
        const editor = await makeEditor("- item one\n\n  > quoted inside item\n\n- item two");
        const v = view(editor);
        const paraPos = nodePos(v, "item one", "paragraph");
        const para = v.state.doc.nodeAt(paraPos)!;
        const quotePos = paraPos + para.nodeSize;
        const quoteEnd = quotePos + v.state.doc.nodeAt(quotePos)!.nodeSize;
        const range = { from: paraPos, to: paraPos + para.nodeSize };

        // The UI's question and the primitive's answer come from one place, so
        // a row can never render live over a move that will be refused.
        expect(moveFits(v.state, range, quoteEnd)).toBe(false);
        expect(moveBlocks(v, range, quoteEnd)).toBe(false);
    });
});

// ── Contract 4: fold-hidden target legality ─────────────────────────────────

describe("moveBlocks — fold-hidden target legality", () => {
    async function makeFolded(): Promise<{
        editor: Editor;
        v: EditorView;
        headingEnd: number;
        sectionEnd: number;
    }> {
        const editor = await makeEditor(
            "Intro\n\n## Section\n\nBody one\n\nBody two\n\n## Next\n\nAfter",
        );
        const v = view(editor);
        const hPos = nodePos(v, "Section", "heading");
        const headingEnd = hPos + v.state.doc.nodeAt(hPos)!.nodeSize;
        const sectionEnd = nodePos(v, "Next", "heading");
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, {
            type: "toggle",
            pos: hPos,
        } satisfies HeadingFoldMeta));
        expect(headingFoldPluginKey.getState(v.state)!.folded.has(hPos)).toBe(true);
        return { editor, v, headingEnd, sectionEnd };
    }

    it("a target inside a collapsed heading section should be refused pre-transaction", async () => {
        const { editor, v, headingEnd } = await makeFolded();
        const before = markdown(editor);
        const dispatchSpy = vi.spyOn(v, "dispatch");
        expect(moveBlocks(v, moveRangeAt(v, 0)!, headingEnd)).toBe(false);
        expect(dispatchSpy).not.toHaveBeenCalled();
        expect(refusals().some((line) => line.includes("fold-hidden"))).toBe(true);
        expect(markdown(editor)).toBe(before);
    });

    it("the first visible boundary after a collapsed section should stay a legal target", async () => {
        const { editor, v, sectionEnd } = await makeFolded();
        expect(moveBlocks(v, moveRangeAt(v, 0)!, sectionEnd)).toBe(true);
        expect(markdown(editor)).toBe(
            "## Section\n\nBody one\n\nBody two\n\nIntro\n\n## Next\n\nAfter",
        );
        expect(refusals()).toEqual([]);
    });

    /**
     * MAR-146. The markdown above is right, but a section's end boundary is
     * INSIDE the section it ends: fold extents derive from heading ranks, so
     * "Intro" landing before `## Next` joins Section's range, and a collapsed
     * Section would hide the block the user just placed — reading as a delete.
     * The slot is one the user can see and aim at (it renders at the visible
     * `## Next` line), so the move REVEALS instead of refusing or hiding.
     *
     * Asserted on the fold registry rather than "the move succeeded": the move
     * succeeded before this fix too — while the landing sat at display:none.
     */
    it("landing at a collapsed section's end should reveal the section, not hide the landing", async () => {
        const { editor, v, sectionEnd } = await makeFolded();
        const hPos = nodePos(v, "Section", "heading");
        expect(moveBlocks(v, moveRangeAt(v, 0)!, sectionEnd)).toBe(true);

        expect(headingFoldPluginKey.getState(v.state)!.folded.has(hPos)).toBe(false);
        // Asserted on the DECORATION, not the fold set: the set is what the
        // fix manipulates, so checking it (or foldedHiddenRanges, which is
        // derived from it) only restates the mechanism. The class the fold
        // plugin's decoration pass stamps is what actually makes the block
        // display:none — the thing the user would lose.
        expect(hiddenBlockTexts(v)).toEqual([]);
        expect(markdown(editor)).toBe(
            "## Section\n\nBody one\n\nBody two\n\nIntro\n\n## Next\n\nAfter",
        );
    });

    /**
     * The rank that decides is the one the run LANDS with, not the one it
     * started with: a TOC outline drop relevels in the same transaction
     * (clause 3), so the drop that MAKES a section a child is exactly the one
     * that can bury it. The pair below differs only in post-relevel rank —
     * reading `moved` instead of `content` would be a live TOC bug that the
     * rest of the suite sleeps through.
     */
    it("a relevel that makes the run a child of a collapsed section should reveal it", async () => {
        const editor = await makeEditor("## Deep\n\ndeep body\n\n## Mover\n\nmover body");
        const v = view(editor);
        const deepPos = nodePos(v, "Deep", "heading");
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, {
            type: "set", pos: deepPos, folded: true,
        } satisfies HeadingFoldMeta));
        expect(hiddenBlockTexts(v)).toEqual(["deep body"]);

        // The TOC's "make this a child of the one above" gesture: an in-place
        // relevel at the run's own start, which is Deep's section end. H2 -> H3
        // lands it INSIDE collapsed Deep — pre-relevel its rank tied Deep's and
        // would have looked safe.
        const moverPos = nodePos(v, "Mover", "heading");
        expect(moveBlocks(v, moveRangeAt(v, moverPos)!, moverPos, { relevelDelta: 1 })).toBe(true);

        expect(markdown(editor)).toBe("## Deep\n\ndeep body\n\n### Mover\n\nmover body");
        expect(hiddenBlockTexts(v), "the relevelled run was buried in the fold").toEqual([]);
    });

    /**
     * MAR-156. Entries relocated by the move meta skipped the MAR-149 guard
     * entirely, so moving a COLLAPSED section somewhere its rank-derived
     * extent grows buried the destination's blocks. (The ticket's written
     * repro — the bare heading moving away from its body — is unreachable:
     * moveRangeAt carries the whole collapsed unit. The burial survives via
     * that whole-unit path whenever nothing at the destination out-ranks the
     * moved heading before the next visible block.)
     */
    it("a moved collapsed section whose extent grows at the destination should expand, not bury", async () => {
        const editor = await makeEditor(
            "# One\n\nvisible A\n\n## Two\n\ntwo text\n\n### Deep\n\ndeep text",
        );
        const v = view(editor);
        const deepPos = nodePos(v, "Deep", "heading");
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, {
            type: "set", pos: deepPos, folded: true,
        } satisfies HeadingFoldMeta));
        expect(hiddenBlockTexts(v)).toEqual(["deep text"]);

        // Move the collapsed unit (heading + hidden body) up so it lands
        // before "two text": nothing between Deep (H3) and doc end now
        // out-ranks it, so its derived extent would swallow the visible
        // "two text" — a block the user never touched.
        const target = nodePos(v, "two text");
        expect(moveBlocks(v, moveRangeAt(v, deepPos)!, target)).toBe(true);

        expect(markdown(editor)).toBe(
            "# One\n\nvisible A\n\n## Two\n\n### Deep\n\ndeep text\n\ntwo text",
        );
        expect(
            hiddenBlockTexts(v),
            "the destination's block was buried in the moved fold",
        ).toEqual([]);
    });

    it("a moved collapsed section whose extent is unchanged should stay collapsed (the fold travels)", async () => {
        const editor = await makeEditor(
            "# One\n\nvisible A\n\n### Deep\n\ndeep text\n\n## Two\n\ntwo text",
        );
        const v = view(editor);
        const deepPos = nodePos(v, "Deep", "heading");
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, {
            type: "set", pos: deepPos, folded: true,
        } satisfies HeadingFoldMeta));
        expect(hiddenBlockTexts(v)).toEqual(["deep text"]);

        // Move the collapsed unit to the top of the document: `# One`
        // terminates the H3 extent exactly as `## Two` did, so the fold
        // hides the same content — it must travel, not expand
        // (e2e/foldVerify's "the fold entry travelled" contract).
        expect(moveBlocks(v, moveRangeAt(v, deepPos)!, 0)).toBe(true);

        expect(markdown(editor)).toBe(
            "### Deep\n\ndeep text\n\n# One\n\nvisible A\n\n## Two\n\ntwo text",
        );
        expect(
            hiddenBlockTexts(v),
            "the fold should travel with the moved unit",
        ).toEqual(["deep text"]);
    });

    /**
     * The guard compares hidden CONTENT, not size: a caller that passes a
     * bare-heading range (bypassing moveRangeAt's whole-unit expansion)
     * strands the fold's body and re-derives an extent over whatever
     * follows the destination. When that content differs — even at the
     * same size — the fold must expand rather than silently hide blocks
     * it never hid before. (No shipped mover passes such a range today;
     * this pins the plugin-level guard's entry-point independence.)
     */
    it("a relocated fold hiding same-size but DIFFERENT content should expand, not bury", async () => {
        const editor = await makeEditor("## Alpha\n\nxx\n\n# Bravo\n\nyy");
        const v = view(editor);
        const alphaPos = nodePos(v, "Alpha", "heading");
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, {
            type: "set", pos: alphaPos, folded: true,
        } satisfies HeadingFoldMeta));
        expect(hiddenBlockTexts(v)).toEqual(["xx"]);

        // Bare heading range: exactly the node, not the collapsed unit.
        const bare = {
            from: alphaPos,
            to: alphaPos + v.state.doc.nodeAt(alphaPos)!.nodeSize,
        };
        expect(moveBlocks(v, bare, nodePos(v, "yy"))).toBe(true);

        // "yy" has the same size as the stranded "xx" — a size-only guard
        // keeps the fold and buries it.
        expect(markdown(editor)).toBe("xx\n\n# Bravo\n\n## Alpha\n\nyy");
        expect(hiddenBlockTexts(v), "same-size destination content was buried").toEqual([]);
    });

    /**
     * The in-place TOC promote is a relocation too (move meta with
     * insertAt === from), so the exemption buried through it as well: a
     * collapsed `## A` promoted to `# A` out-ranks the `## B` next door and
     * swallows B's whole section. The guard sees the hidden text change and
     * expands instead.
     */
    it("an in-place relevel that grows a collapsed section should expand it, not bury the neighbor", async () => {
        const editor = await makeEditor("## A\n\na body\n\n## B\n\nb body");
        const v = view(editor);
        const aPos = nodePos(v, "A", "heading");
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, {
            type: "set", pos: aPos, folded: true,
        } satisfies HeadingFoldMeta));
        expect(hiddenBlockTexts(v)).toEqual(["a body"]);

        expect(moveBlocks(v, moveRangeAt(v, aPos)!, aPos, { relevelDelta: -1 })).toBe(true);

        expect(markdown(editor)).toBe("# A\n\na body\n\n## B\n\nb body");
        expect(hiddenBlockTexts(v), "B's section was buried by the promote").toEqual([]);
    });

    it("a relevel that still out-ranks a collapsed section should NOT reveal it", async () => {
        const editor = await makeEditor("## Deep\n\ndeep body\n\n# Mover\n\nmover body");
        const v = view(editor);
        const deepPos = nodePos(v, "Deep", "heading");
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, {
            type: "set", pos: deepPos, folded: true,
        } satisfies HeadingFoldMeta));

        // H1 -> H2 ties Deep's rank, so it still ends Deep's section: visible
        // where it lands, and Deep stays folded.
        const moverPos = nodePos(v, "Mover", "heading");
        expect(moveBlocks(v, moveRangeAt(v, moverPos)!, moverPos, { relevelDelta: 1 })).toBe(true);

        expect(markdown(editor)).toBe("## Deep\n\ndeep body\n\n## Mover\n\nmover body");
        expect(hiddenBlockTexts(v), "Deep must stay collapsed").toEqual(["deep body"]);
    });

    /**
     * The same hazard with nothing after the section: a collapsed LAST section
     * runs to doc end, so the end-of-document slot — which the drag UI offers
     * and every "move this to the bottom" gesture aims at — lands inside it.
     */
    it("landing at doc end should reveal a collapsed last section", async () => {
        const editor = await makeEditor("# One\n\nalpha\n\n# Last\n\nlast body");
        const v = view(editor);
        const lastPos = nodePos(v, "Last", "heading");
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, {
            type: "set", pos: lastPos, folded: true,
        } satisfies HeadingFoldMeta));
        expect(foldedHiddenRanges(v.state)).toHaveLength(1);

        const alpha = moveRangeAt(v, nodePos(v, "alpha", "paragraph"))!;
        expect(moveBlocks(v, alpha, v.state.doc.content.size)).toBe(true);

        expect(markdown(editor)).toBe("# One\n\n# Last\n\nlast body\n\nalpha");
        const alphaPos = nodePos(v, "alpha", "paragraph");
        expect(
            foldedHiddenRanges(v.state).filter(
                (r) => alphaPos >= r.from && alphaPos < r.to,
            ),
            "the block moved to the end of the document landed inside the collapsed last section",
        ).toEqual([]);
    });

    /**
     * Scope guard, not an MAR-146 regression pin (it passes on the unfixed
     * code too): a heading ranked at or above the collapsed one TERMINATES its
     * section, so it stays visible on its own and the fold must survive the
     * move. It kills the two tempting over-corrections — "reveal whenever a
     * fold is near the target" and `>=` where the rule needs `>`.
     */
    it("a heading that out-ranks a collapsed section should land at its end WITHOUT revealing it", async () => {
        const editor = await makeEditor("# Mover\n\nmover body\n\n# Keep\n\nkept body");
        const v = view(editor);
        const keepPos = nodePos(v, "Keep", "heading");
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, {
            type: "set", pos: keepPos, folded: true,
        } satisfies HeadingFoldMeta));
        // Keep is the LAST section, so its range runs to doc end and the end
        // slot lands "inside" it — but `# Mover` ties Keep's rank, ending its
        // section where it lands, so it needs no reveal to stay visible.
        expect(moveBlocks(v, moveRangeAt(v, 0)!, v.state.doc.content.size)).toBe(true);

        expect(markdown(editor)).toBe("# Keep\n\nkept body\n\n# Mover\n\nmover body");
        expect(
            headingFoldPluginKey.getState(v.state)!.folded.size,
            "moving a section past a collapsed one must not reveal it",
        ).toBe(1);
    });

    it("targets inside a collapsed callout body (end-of-body slot included) should be refused", async () => {
        const editor = await makeEditor("Alpha\n\n> [!NOTE]\n> callout body\n\nOmega");
        const v = view(editor);
        const calloutPos = nodePos(v, "callout body", "callout");
        expect(calloutPos).toBeGreaterThan(-1);
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, {
            type: "set",
            pos: calloutPos,
            folded: true,
        } satisfies HeadingFoldMeta));
        const hidden = foldedHiddenRanges(v.state).find((r) => r.pos === calloutPos);
        expect(hidden).toBeDefined();
        const before = markdown(editor);
        const range = moveRangeAt(v, 0)!; // the Alpha paragraph
        // Inside the body — and the end-of-body slot, which for a callout is
        // still inside the collapsed node (inclusive, unlike heading ranges).
        expect(moveBlocks(v, range, hidden!.from)).toBe(false);
        expect(moveBlocks(v, range, hidden!.to)).toBe(false);
        expect(refusals().length).toBe(2);
        expect(markdown(editor)).toBe(before);
    });
});

// ── Contract 3b: the single allowed normalization + contract 5 side-state ───

describe("moveBlocks — allowed normalization and side-state", () => {
    it("moving a list's last item into another list should dissolve the emptied source list", async () => {
        const editor = await makeEditor("- only\n\n1. b1");
        const v = view(editor);
        const onlyPos = nodePos(v, "only", "list_item");
        const b1Pos = nodePos(v, "b1", "list_item");
        const item = v.state.doc.nodeAt(onlyPos)!;
        expect(moveBlocks(v, { from: onlyPos, to: onlyPos + item.nodeSize }, b1Pos)).toBe(true);
        expect(markdown(editor)).toBe("1. only\n2. b1");
        expect(guardErrors()).toEqual([]); // the dissolution is a DECLARED allowance
    });

    it("moving the only child out of a TITLED callout should dissolve it via the declared exemption", async () => {
        // The marker carries user title bytes, so the bare-marker fallback
        // cannot exempt this — only moveBlocks' dissolvedMarkers declaration
        // lets the legitimate dissolution through, while a buggy unwrap of
        // the same callout (undeclared) still vetoes (contentGuard.test.ts).
        const editor = await makeEditor("> [!note] My Title\n> only body\n\ntail");
        const v = view(editor);
        const bodyPos = nodePos(v, "only body", "paragraph");
        const body = v.state.doc.nodeAt(bodyPos)!;
        expect(
            moveBlocks(v, { from: bodyPos, to: bodyPos + body.nodeSize }, v.state.doc.content.size),
        ).toBe(true);
        expect(markdown(editor)).toBe("tail\n\nonly body");
        expect(guardErrors()).toEqual([]); // declared dissolution, not a warning
    });

    it("a collapsed heading's fold entry should travel with its moved section", async () => {
        const editor = await makeEditor("## A\n\nbody A\n\n## B\n\nbody B");
        const v = view(editor);
        const aPos = nodePos(v, "A", "heading");
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, {
            type: "toggle",
            pos: aPos,
        } satisfies HeadingFoldMeta));
        expect(headingFoldPluginKey.getState(v.state)!.folded.has(aPos)).toBe(true);
        // Move section A (heading + hidden body) to the document end.
        expect(moveBlocks(v, moveRangeAt(v, aPos)!, v.state.doc.content.size)).toBe(true);
        expect(markdown(editor)).toBe("## B\n\nbody B\n\n## A\n\nbody A");
        const newAPos = nodePos(v, "A", "heading");
        const folded = headingFoldPluginKey.getState(v.state)!.folded;
        expect(folded.has(newAPos)).toBe(true); // the fold followed the section
        expect(folded.size).toBe(1); // and nothing else inherited it
    });
});

// ── Contract 1: veto awareness ──────────────────────────────────────────────

// ── Contract 3's declared exception: caller-requested relevel ───────────────

describe("moveBlocks — opt-in heading relevel", () => {
    it("no relevelDelta should leave heading levels untouched (the literal move)", async () => {
        const editor = await makeEditor("# A\n\nbody a\n\n## B\n\nbody b");
        const v = view(editor);
        const from = nodePos(v, "B", "heading");
        expect(moveBlocks(v, { from, to: v.state.doc.content.size }, 0)).toBe(true);
        expect(markdown(editor)).toBe("## B\n\nbody b\n\n# A\n\nbody a");
    });

    it("a relevelDelta should shift every heading in the moved run by the same amount", async () => {
        const editor = await makeEditor("# A\n\nbody a\n\n## B\n\nbody b\n\n### C\n\nbody c");
        const v = view(editor);
        const from = nodePos(v, "B", "heading");
        // B's section carries C: both shift +1 together, preserving the
        // section's internal hierarchy (B > C stays B > C).
        expect(
            moveBlocks(v, { from, to: v.state.doc.content.size }, 0, { relevelDelta: 1 }),
        ).toBe(true);
        expect(markdown(editor)).toBe("### B\n\nbody b\n\n#### C\n\nbody c\n\n# A\n\nbody a");
        expect(refusals()).toEqual([]);
    });

    it("a relevel should clamp at H6 rather than refuse or emit an H7", async () => {
        const editor = await makeEditor("# A\n\nbody a\n\n##### E\n\nbody e\n\n###### F\n\nbody f");
        const v = view(editor);
        const from = nodePos(v, "E", "heading");
        expect(
            moveBlocks(v, { from, to: v.state.doc.content.size }, 0, { relevelDelta: 3 }),
        ).toBe(true);
        // E: H5+3 = H8 → H6. F: H6+3 = H9 → H6. Both floor at H6; the
        // distinction between them is lost, which is the accepted cost of a
        // drop that never blocks.
        expect(markdown(editor)).toBe("###### E\n\nbody e\n\n###### F\n\nbody f\n\n# A\n\nbody a");
    });

    it("a relevel should not trip the content guard (ranks are attrs, not content)", async () => {
        const editor = await makeEditor("# A\n\nbody a\n\n## B\n\nbody b");
        const v = view(editor);
        const from = nodePos(v, "B", "heading");
        const before = v.state.doc;
        expect(
            moveBlocks(v, { from, to: v.state.doc.content.size }, 0, { relevelDelta: 2 }),
        ).toBe(true);
        // The move actually applied (no veto — a veto leaves doc identity).
        expect(v.state.doc).not.toBe(before);
        expect(guardErrors()).toEqual([]);
        expect(markdown(editor)).toBe("#### B\n\nbody b\n\n# A\n\nbody a");
    });

    it("a target at the source's own start should relevel IN PLACE instead of no-opping", async () => {
        // The TOC's "make this section a child of the one above it" gesture:
        // the run does not move, only its rank changes. Without the exemption
        // the put-it-back guard would swallow it entirely.
        const editor = await makeEditor("# A\n\nbody a\n\n## B\n\nbody b");
        const v = view(editor);
        const from = nodePos(v, "B", "heading");
        expect(
            moveBlocks(v, { from, to: v.state.doc.content.size }, from, { relevelDelta: 1 }),
        ).toBe(true);
        expect(markdown(editor)).toBe("# A\n\nbody a\n\n### B\n\nbody b");
        expect(refusals()).toEqual([]);
    });

    it("a target at the source's own start with no relevel should stay a no-op", async () => {
        const editor = await makeEditor("# A\n\nbody a\n\n## B\n\nbody b");
        const v = view(editor);
        const from = nodePos(v, "B", "heading");
        const before = markdown(editor);
        expect(moveBlocks(v, { from, to: v.state.doc.content.size }, from)).toBe(false);
        expect(markdown(editor)).toBe(before);
        expect(refusals()).toEqual([]); // a quiet no-op, never a refusal
    });
});

describe("moveBlocks — veto awareness", () => {
    it("a filtered (vetoed) dispatch should return false and skip the landing flash", async () => {
        const editor = await makeEditor("Alpha\n\nBravo");
        const v = view(editor);
        const before = markdown(editor);
        // Stand-in for the guard's last line of defense: a filter that kills
        // every guard-tagged transaction. The primitive must detect that the
        // doc never changed and report a truthful no-op.
        v.updateState(v.state.reconfigure({
            plugins: [
                ...v.state.plugins,
                new Plugin({
                    filterTransaction: (tr) => tr.getMeta(contentGuardKey) === undefined,
                }),
            ],
        }));
        vi.mocked(flashRange).mockClear();
        expect(moveBlocks(v, moveRangeAt(v, 0)!, v.state.doc.content.size)).toBe(false);
        expect(markdown(editor)).toBe(before);
        expect(flashRange).not.toHaveBeenCalled();
    });

    /**
     * "Returns false with the document untouched" covers side state too: a
     * vetoed move must not leave a section spuriously expanded — a visible
     * change from a gesture that reported doing nothing.
     *
     * Holds by construction today (the MAR-146 reveal reads the POST-move doc,
     * so a move that never lands has nothing to reveal), which makes this a
     * contract spec more than a live tripwire. Kept because it is not
     * hypothetical: it caught exactly this bug in the first cut of MAR-146,
     * which predicted the reveal up front and committed it before dispatch.
     * Anything that returns to predicting fails here again.
     */
    it("a vetoed move should not reveal the fold it would have landed in", async () => {
        const editor = await makeEditor("# One\n\nalpha\n\n# Last\n\nlast body");
        const v = view(editor);
        const lastPos = nodePos(v, "Last", "heading");
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, {
            type: "set", pos: lastPos, folded: true,
        } satisfies HeadingFoldMeta));
        v.updateState(v.state.reconfigure({
            plugins: [
                ...v.state.plugins,
                new Plugin({
                    filterTransaction: (tr) => tr.getMeta(contentGuardKey) === undefined,
                }),
            ],
        }));
        const before = markdown(editor);

        const alpha = moveRangeAt(v, nodePos(v, "alpha", "paragraph"))!;
        expect(moveBlocks(v, alpha, v.state.doc.content.size)).toBe(false);

        expect(markdown(editor)).toBe(before);
        expect(
            hiddenBlockTexts(v),
            "the fold was opened for a move that never happened",
        ).toEqual(["last body"]);
    });

    it("a legal move should apply, flash its landing, and report success", async () => {
        const editor = await makeEditor("Alpha\n\nBravo");
        const v = view(editor);
        vi.mocked(flashRange).mockClear();
        expect(moveBlocks(v, moveRangeAt(v, 0)!, v.state.doc.content.size)).toBe(true);
        expect(markdown(editor)).toBe("Bravo\n\nAlpha");
        expect(flashRange).toHaveBeenCalledTimes(1);
        expect(refusals()).toEqual([]);
        expect(guardErrors()).toEqual([]);
    });
});

// ── Registry exhaustiveness (the gutterCoverage idiom) ──────────────────────

/**
 * Every fold-capable kind the fold plugin can hide MUST be covered by the
 * hidden-range registry (foldedHiddenRanges / isHiddenTargetPos) that both
 * the move primitive and the drag slot filter consume. A future fold kind
 * that forgets to register fails HERE, not when a user's block vanishes
 * into display:none. When adding a fold kind: extend foldHiddenRange
 * (plugins/headingFold), add the kind to FOLD_CAPABLE_KINDS, and give the
 * fixture below an instance of it.
 */
const FOLD_CAPABLE_KINDS = new Set(["heading", "callout"]);

const KITCHEN_SINK =
    "Intro\n\n## Section\n\nBody one\n\n> [!NOTE]\n> callout body\n\n## Next\n\nAfter";

describe("hidden-range registry exhaustiveness", () => {
    it("the fixture should exercise exactly the registered fold-capable kinds", async () => {
        const editor = await makeEditor(KITCHEN_SINK);
        const v = view(editor);
        const kinds = new Set(
            allFoldablePositions(v.state.doc).map(
                (pos) => v.state.doc.nodeAt(pos)!.type.name,
            ),
        );
        expect(
            kinds,
            "Foldable kinds drifted from FOLD_CAPABLE_KINDS. Update foldHiddenRange, " +
                "this allowlist, AND the KITCHEN_SINK fixture together.",
        ).toEqual(FOLD_CAPABLE_KINDS);
    });

    it("every folded foldable should register a hidden range that the primitive refuses", async () => {
        const editor = await makeEditor(KITCHEN_SINK);
        const v = view(editor);
        const foldables = allFoldablePositions(v.state.doc);
        expect(foldables.length).toBeGreaterThan(1);
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, {
            type: "foldAll",
        } satisfies HeadingFoldMeta));
        const hidden = foldedHiddenRanges(v.state);
        const before = markdown(editor);
        for (const pos of foldables) {
            const range = hidden.find((r) => r.pos === pos);
            expect(
                range,
                `foldable at ${pos} (${v.state.doc.nodeAt(pos)!.type.name}) registered no hidden range`,
            ).toBeDefined();
            // A boundary inside the hidden range is illegal for the
            // primitive and never offered by the drag UI.
            expect(isHiddenTargetPos(v.state, range!.from)).toBe(true);
            expect(moveBlocks(v, moveRangeAt(v, 0)!, range!.from)).toBe(false);
            expect(markdown(editor)).toBe(before);
        }
    });

    it("drag slots and primitive legality should agree boundary-for-boundary", async () => {
        const editor = await makeEditor(KITCHEN_SINK);
        const v = view(editor);
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, {
            type: "foldAll",
        } satisfies HeadingFoldMeta));
        // The drag UI's slot list must be EXACTLY the full boundary list
        // minus the positions the shared registry declares hidden — any
        // other relationship means UI slots and primitive legality drifted.
        expect(visibleBoundaryPositions(v.state)).toEqual(
            blockBoundaryPositions(v.state.doc).filter(
                ({ pos }) => !isHiddenTargetPos(v.state, pos),
            ),
        );
    });
});
