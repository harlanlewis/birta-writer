/**
 * What asking "is anything foldable?" costs (MAR-439).
 *
 * The gutter block menu draws a Fold All row, and decides whether to draw it
 * enabled by running `foldAllCommand` with no dispatch. That dry run calls
 * `allFoldablePositions`, which walks every descendant. The walk itself is the
 * design and is fine; what is not is asking the document to re-derive a node
 * the walk already handed over. `doc.nodeAt` scans the fragment, so a
 * per-descendant `nodeAt` is the block count paid once per node, and on a few
 * thousand blocks it was the whole cost of opening the menu.
 *
 * A differential between two fixtures whose only difference is size, in the
 * idiom of structuralEditWork.test.ts: no stored figure, so nothing here can
 * go stale, and each case asserts its own reach before reading a number,
 * because an instrument that measured nothing satisfies every "did not grow"
 * comparison by having no numbers to compare.
 *
 * Counts, never durations. The machine these run on is shared, and what a
 * pass VISITS does not depend on machine load.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { allFoldablePositions, foldAllCommand, headingFoldPlugin } from "../plugins/headingFold";

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

afterEach(async () => {
    vi.restoreAllMocks();
    for (const e of editors) { await e.destroy(); }
    editors = [];
    document.body.innerHTML = "";
});

beforeAll(() => {
    if (typeof globalThis.ResizeObserver === "undefined") {
        globalThis.ResizeObserver = class {
            observe(): void {}
            unobserve(): void {}
            disconnect(): void {}
        } as unknown as typeof ResizeObserver;
    }
});

/**
 * A note of `sections` sections, carrying foldables of both kinds: headings
 * own their sections, and the code block and the list item fold on their own.
 * Two sizes of the same shape is the whole instrument; anything else different
 * between them would give a count that grew a second explanation.
 */
function note(sections: number): string {
    let acc = "";
    for (let i = 1; i <= sections; i++) {
        acc += `## Section ${i}\n\nParagraph ${i} carries ordinary prose.\n\n`
            + `- item a${i}\n  - nested b${i}\n- item c${i}\n\n`
            + "```js\nconst x = 1;\n```\n\n";
    }
    return acc;
}

const SMALL = note(4);
const LARGE = note(40);

it("the larger fixture should be the larger fixture", () => {
    expect(LARGE.length).toBeGreaterThan(SMALL.length * 5);
});

/**
 * Counts `nodeAt` calls, spied on the live document's own prototype rather
 * than on an import: it is the lookup being removed, and it is ProseMirror's,
 * so counting it is independent of any counter this change added.
 */
function nodeAtCalls(view: EditorView) {
    const proto = Object.getPrototypeOf(view.state.doc) as { nodeAt: unknown };
    const spy = vi.spyOn(proto as never, "nodeAt" as never);
    return {
        count: () => spy.mock.calls.length,
        reset: () => spy.mockClear(),
    };
}

describe("the Fold All row's enablement probe", () => {
    async function probeWork(markdown: string): Promise<{ lookups: number; foldables: number; blocks: number }> {
        const view = await makeEditor(markdown);
        // Reach, taken BEFORE the spy so its own lookups are not counted: the
        // walk really does find foldables in this document, so a flat lookup
        // count below cannot be the walk having nothing to visit.
        const foldables = allFoldablePositions(view.state.doc).length;
        const calls = nodeAtCalls(view);
        // The instrument is live, asserted rather than assumed: after the fix
        // the counts below are near zero, and a spy that had attached to
        // nothing would report exactly that and satisfy every "did not grow"
        // comparison by having no numbers to compare.
        calls.reset();
        view.state.doc.nodeAt(0);
        expect(calls.count()).toBeGreaterThan(0);
        calls.reset();
        // The gesture, not the helper: this is the call the menu makes to
        // decide whether to draw the row enabled (blockMenu/menu.ts,
        // `disabled: !foldAllCommand(view.state)`), with no dispatch.
        const enabled = foldAllCommand(view.state, undefined);
        expect(enabled).toBe(true);
        return { lookups: calls.count(), foldables, blocks: view.state.doc.childCount };
    }

    it("should not re-derive a node the walk already holds, so its lookups should not grow with the document", async () => {
        const small = await probeWork(SMALL);
        const large = await probeWork(LARGE);

        // Reach first. Both documents have foldables, and the larger really is
        // larger in the unit the defect scaled with.
        expect(small.foldables).toBeGreaterThan(0);
        expect(large.foldables).toBeGreaterThan(small.foldables * 5);
        expect(large.blocks).toBeGreaterThan(small.blocks * 5);

        // The claim. Before the fix this walk asked `nodeAt` once per
        // descendant, so the count tracked the document; the ten-fold fixture
        // must not cost ten times the lookups.
        expect(large.lookups).toBeLessThanOrEqual(small.lookups + 2);
    });
});
