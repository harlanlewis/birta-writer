/**
 * Tests for the pure TOC drop model (components/toc/dropModel): outline →
 * slot generation against real docs, and the measured-slot hit test with
 * hand-built geometry (the DOM layer pairs slots with rects; the model
 * itself never touches the DOM).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "@milkdown/prose/view";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    tocDropSlots,
    tocDropTargetFor,
    tocPillLabel,
    type MeasuredTocSlot,
    type TocHeadingEntry,
} from "../components/toc/dropModel";

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
        .create();
    editors.push(editor);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Every heading in the doc as a TOC entry; `topLevelMax` caps which levels
 * count as top-tier outline items (the TOC's own notion, not doc depth). */
function outlineOf(doc: ProseNode, topLevelMax: number): TocHeadingEntry[] {
    const headings: TocHeadingEntry[] = [];
    doc.forEach((node: ProseNode, offset: number) => {
        if (node.type.name === "heading") {
            const level = node.attrs["level"] as number;
            headings.push({ level, text: node.textContent, pos: offset, topLevel: level <= topLevelMax });
        }
    });
    return headings;
}

const neverHidden = (): boolean => false;

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

describe("tocDropSlots", () => {
    it("a flat outline should yield a gap per heading, a terminal end slot, and an into per heading", async () => {
        const editor = await makeEditor("# A\n\na body\n\n# B\n\nb body\n\n# C");
        const doc = view(editor).state.doc;
        const headings = outlineOf(doc, 1);
        const slots = tocDropSlots(headings, doc, neverHidden);
        const gaps = slots.filter((s) => s.kind === "gap");
        const intos = slots.filter((s) => s.kind === "into");
        expect(gaps).toHaveLength(4); // before A, B, C + terminal
        expect(intos).toHaveLength(3);
        expect(gaps.map((s) => s.tocIndex)).toEqual([0, 1, 2, 3]);
        expect(gaps.map((s) => s.pos)).toEqual([
            headings[0]!.pos,
            headings[1]!.pos,
            headings[2]!.pos,
            doc.content.size,
        ]);
        // Each section's into slot lands at its end: the next heading's pos
        // (or the doc's end for the last section).
        expect(intos.map((s) => s.pos)).toEqual([headings[1]!.pos, headings[2]!.pos, doc.content.size]);
        expect(intos.map((s) => s.headingPos)).toEqual(headings.map((h) => h.pos));
    });

    it("an H2 with H3 children should get an into slot past the children's sections", async () => {
        const editor = await makeEditor("## A\n\n### A1\n\nx\n\n### A2\n\ny\n\n## B\n\nz");
        const doc = view(editor).state.doc;
        const headings = outlineOf(doc, 2); // H2s are top-tier; H3s are nested
        const nested = headings.filter((h) => !h.topLevel);
        expect(nested).toHaveLength(2); // the raw material: A1/A2 exist
        const slots = tocDropSlots(headings, doc, neverHidden);
        const intoA = slots.find((s) => s.kind === "into" && s.headingPos === headings[0]!.pos)!;
        // A's section spans BOTH H3 subsections — into A appends after them.
        const bPos = headings.find((h) => h.text === "B")!.pos;
        expect(intoA.pos).toBe(bPos);
    });

    it("a nested (topLevel false) heading should produce no slots", async () => {
        const editor = await makeEditor("## A\n\n### A1\n\nx\n\n### A2\n\ny\n\n## B\n\nz");
        const doc = view(editor).state.doc;
        const headings = outlineOf(doc, 2);
        const slots = tocDropSlots(headings, doc, neverHidden);
        const nestedPositions = headings.filter((h) => !h.topLevel).map((h) => h.pos);
        expect(slots.some((s) => s.kind === "gap" && nestedPositions.includes(s.pos))).toBe(false);
        expect(slots.some((s) => s.headingPos !== undefined && nestedPositions.includes(s.headingPos))).toBe(false);
        expect(slots.filter((s) => s.kind === "gap")).toHaveLength(3); // A, B, terminal
    });

    it("isHiddenTarget should remove buried slots and keep the rest", async () => {
        const editor = await makeEditor("# A\n\na body\n\n# B\n\nb body");
        const doc = view(editor).state.doc;
        const headings = outlineOf(doc, 1);
        const bPos = headings[1]!.pos;
        // Pretend A's section end (== B's pos) is fold-hidden.
        const slots = tocDropSlots(headings, doc, (pos) => pos === bPos);
        expect(slots.some((s) => s.pos === bPos)).toBe(false);
        // A's gap and the terminal end slot survive.
        expect(slots.some((s) => s.kind === "gap" && s.pos === headings[0]!.pos)).toBe(true);
        expect(slots.some((s) => s.kind === "gap" && s.pos === doc.content.size)).toBe(true);
    });

    it("an empty top-level outline should produce no slots (not even the terminal one)", async () => {
        const editor = await makeEditor("just a paragraph\n\n### deep only");
        const doc = view(editor).state.doc;
        expect(tocDropSlots([], doc, neverHidden)).toEqual([]);
        // All-nested outline: same answer.
        const nestedOnly = outlineOf(doc, 2); // the H3 stays topLevel: false
        expect(tocDropSlots(nestedOnly, doc, neverHidden)).toEqual([]);
    });
});

describe("tocDropTargetFor", () => {
    // Two items: item 0 spans y 100–140, item 1 spans y 140–180.
    const slots: MeasuredTocSlot[] = [
        { kind: "gap", pos: 0, tocIndex: 0, y: 100, left: 0, width: 200 },
        { kind: "into", pos: 50, tocIndex: 0, headingPos: 0, y: 120, top: 100, height: 40, left: 0, width: 200 },
        { kind: "gap", pos: 50, tocIndex: 1, y: 140, left: 0, width: 200 },
        { kind: "into", pos: 90, tocIndex: 1, headingPos: 50, y: 160, top: 140, height: 40, left: 0, width: 200 },
        { kind: "gap", pos: 90, tocIndex: 2, y: 180, left: 0, width: 200 },
    ];
    const elsewhere = { from: 200, to: 210 }; // a dragged range no slot touches

    it("a pointer in an item's middle band should resolve to its into slot when allowInto", () => {
        // Item 0's middle band is (110, 130).
        const hit = tocDropTargetFor(slots, 120, elsewhere, { allowInto: true });
        expect(hit?.kind).toBe("into");
        expect(hit?.headingPos).toBe(0);
    });

    it("a pointer in an edge band should resolve to the nearest gap even with allowInto", () => {
        // y=105 is inside item 0 but above its 25% line (110) — top edge band.
        const hit = tocDropTargetFor(slots, 105, elsewhere, { allowInto: true });
        expect(hit?.kind).toBe("gap");
        expect(hit?.pos).toBe(0);
        // y=137 is below item 0's 75% line (130) — bottom edge band, gap below.
        const below = tocDropTargetFor(slots, 137, elsewhere, { allowInto: true });
        expect(below?.kind).toBe("gap");
        expect(below?.pos).toBe(50);
    });

    it("allowInto false should always resolve to the nearest gap by y", () => {
        const hit = tocDropTargetFor(slots, 120, elsewhere, { allowInto: false });
        expect(hit?.kind).toBe("gap");
        // 120 is equidistant from the gaps at 100 and 140 — ties break to
        // the larger pos, the dropTargetFor convention.
        expect(hit?.pos).toBe(50);
    });

    it("a winning slot inside the dragged range should yield null (self drop)", () => {
        expect(tocDropTargetFor(slots, 120, { from: 40, to: 60 }, { allowInto: true })).toBeNull();
        expect(tocDropTargetFor(slots, 100, { from: 0, to: 10 }, { allowInto: false })).toBeNull();
    });

    it("a pointer below the last item should resolve to the terminal end slot", () => {
        const hit = tocDropTargetFor(slots, 400, elsewhere, { allowInto: true });
        expect(hit?.kind).toBe("gap");
        expect(hit?.tocIndex).toBe(2);
        expect(hit?.pos).toBe(90);
    });

    it("an into band coincident with a gap's y should prefer the gap", () => {
        // An EMPTY section renders no band of its own: its into slot comes
        // through degenerate (height 0) at the same y as the boundary line.
        const coincident: MeasuredTocSlot[] = [
            { kind: "gap", pos: 0, tocIndex: 0, y: 100, left: 0, width: 200 },
            { kind: "into", pos: 10, tocIndex: 0, headingPos: 0, y: 100, top: 100, height: 0, left: 0, width: 200 },
            { kind: "gap", pos: 10, tocIndex: 1, y: 100, left: 0, width: 200 },
        ];
        const hit = tocDropTargetFor(coincident, 100, elsewhere, { allowInto: true });
        expect(hit?.kind).toBe("gap");
        // Coincident gaps tie-break toward the larger pos too.
        expect(hit?.pos).toBe(10);
        // A real band's EDGE flush with a gap line also resolves to the gap
        // (band containment is strict).
        const edge = tocDropTargetFor(slots, 140, elsewhere, { allowInto: true });
        expect(edge?.kind).toBe("gap");
        expect(edge?.pos).toBe(50);
    });

    it("no slots should yield null", () => {
        expect(tocDropTargetFor([], 100, elsewhere, { allowInto: true })).toBeNull();
    });
});

describe("tocPillLabel", () => {
    it("a short title should pass through trimmed and untruncated", () => {
        expect(tocPillLabel("  Getting started  ")).toBe("Getting started");
        expect(tocPillLabel("Exactly twenty-eight chars!!")).toBe("Exactly twenty-eight chars!!");
    });

    it("a long title should truncate to ~28 chars with an ellipsis", () => {
        const label = tocPillLabel("A very long heading title that keeps going and going");
        expect(label.length).toBeLessThanOrEqual(28);
        expect(label.endsWith("…")).toBe(true);
        expect(label.startsWith("A very long heading")).toBe(true);
    });
});
