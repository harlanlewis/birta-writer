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
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import type { EditorView } from "@milkdown/prose/view";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { Plugin } from "@milkdown/prose/state";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../serialization";
import {
    allFoldablePositions,
    foldedHiddenRanges,
    headingFoldPlugin,
    headingFoldPluginKey,
    isHiddenTargetPos,
    type HeadingFoldMeta,
} from "../plugins/headingFold";
import { historyPlugin } from "../plugins/history";
import { contentGuardKey, contentGuardPlugin } from "../plugins/contentGuard";
import { moveBlocks } from "../editing/moveBlocks";
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
        .use(gfm)
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
