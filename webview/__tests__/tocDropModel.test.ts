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
    draggedSectionLevel,
    tocDropSlots,
    tocDropTargetFor,
    tocPillLabel,
    tocRelevelDelta,
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

/**
 * Every heading in the doc as a TOC entry, built exactly as production does
 * (components/toc/index.ts's getHeadings): `atDocRoot` is DOC DEPTH, never
 * rank. The distinction is the whole point — an earlier version of this helper
 * modelled it as "level <= N", which made H3s non-root and had the suite
 * exercising a distribution production never produces (in a flat document
 * every heading is at the root, so the whole outline drags). Descends into
 * containers so a heading inside a blockquote/list — the one case that really
 * is non-root — is reported with atDocRoot false.
 */
function outlineOf(doc: ProseNode): TocHeadingEntry[] {
    const headings: TocHeadingEntry[] = [];
    doc.descendants((node: ProseNode, pos: number) => {
        if (node.type.name === "heading") {
            headings.push({
                level: node.attrs["level"] as number,
                text: node.textContent,
                pos,
                atDocRoot: doc.resolve(pos).depth === 0,
            });
        }
        return true;
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
        const headings = outlineOf(doc);
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
        // A flat document: every heading is at the doc root, subsections
        // included, so every one of them drags and gets its own slots. Rank is
        // what makes A1/A2 A's children — and that is a fold-range fact, not a
        // slot-eligibility one.
        const headings = outlineOf(doc);
        expect(headings.every((h) => h.atDocRoot)).toBe(true);
        const slots = tocDropSlots(headings, doc, neverHidden);
        const intoA = slots.find((s) => s.kind === "into" && s.headingPos === headings[0]!.pos)!;
        // A's section spans BOTH H3 subsections — into A appends after them.
        const bPos = headings.find((h) => h.text === "B")!.pos;
        expect(intoA.pos).toBe(bPos);
    });

    it("a heading nested inside a container should produce no slots", async () => {
        // The ONLY way to be non-root: inside a blockquote. Rank never does it
        // — an H3 at the doc root is a perfectly good drop row (above).
        const editor = await makeEditor("# Root\n\nbody\n\n> # Quoted\n>\n> quoted body");
        const doc = view(editor).state.doc;
        const headings = outlineOf(doc);
        const nested = headings.filter((h) => !h.atDocRoot);
        expect(nested.map((h) => h.text)).toEqual(["Quoted"]); // the raw material exists
        const slots = tocDropSlots(headings, doc, neverHidden);
        const nestedPositions = nested.map((h) => h.pos);
        expect(slots.some((s) => s.kind === "gap" && nestedPositions.includes(s.pos))).toBe(false);
        expect(slots.some((s) => s.headingPos !== undefined && nestedPositions.includes(s.headingPos))).toBe(false);
        expect(slots.filter((s) => s.kind === "gap")).toHaveLength(2); // Root + terminal
    });

    it("isHiddenTarget should remove buried slots and keep the rest", async () => {
        const editor = await makeEditor("# A\n\na body\n\n# B\n\nb body");
        const doc = view(editor).state.doc;
        const headings = outlineOf(doc);
        const bPos = headings[1]!.pos;
        // Pretend A's section end (== B's pos) is fold-hidden.
        const slots = tocDropSlots(headings, doc, (pos) => pos === bPos);
        expect(slots.some((s) => s.pos === bPos)).toBe(false);
        // A's gap and the terminal end slot survive.
        expect(slots.some((s) => s.kind === "gap" && s.pos === headings[0]!.pos)).toBe(true);
        expect(slots.some((s) => s.kind === "gap" && s.pos === doc.content.size)).toBe(true);
    });

    it("an outline with no root-level heading should produce no slots (not even the terminal one)", async () => {
        const editor = await makeEditor("just a paragraph\n\n> ### quoted only");
        const doc = view(editor).state.doc;
        expect(tocDropSlots([], doc, neverHidden)).toEqual([]);
        // Every heading nested inside a container: same answer.
        const nestedOnly = outlineOf(doc);
        expect(nestedOnly.length).toBeGreaterThan(0);
        expect(nestedOnly.every((h) => !h.atDocRoot)).toBe(true);
        expect(tocDropSlots(nestedOnly, doc, neverHidden)).toEqual([]);
    });
});

describe("slot target levels (the structural-editor contract)", () => {
    const neverHiddenLocal = (): boolean => false;

    it("a gap slot should carry the level of the heading it sits above", async () => {
        const editor = await makeEditor("# One\n\n### Deep\n\nbody\n\n## Two\n\nbody");
        const doc = view(editor).state.doc;
        const slots = tocDropSlots(outlineOf(doc), doc, neverHiddenLocal);
        const gaps = slots.filter((s) => s.kind === "gap");
        // One gap per heading (H1, H3, H2) + the terminal slot.
        expect(gaps.map((g) => g.targetLevel)).toEqual([1, 3, 2, 2]);
    });

    it("the terminal gap should carry the LAST section's level", async () => {
        const editor = await makeEditor("# One\n\nbody\n\n#### Last\n\nbody");
        const doc = view(editor).state.doc;
        const slots = tocDropSlots(outlineOf(doc), doc, neverHiddenLocal);
        const terminal = slots.find((s) => s.kind === "gap" && s.pos === doc.content.size);
        expect(terminal?.targetLevel).toBe(4);
    });

    it("a COLLAPSED section should still offer its into slot (landings are revealed, not refused)", async () => {
        // The model does not know or care about fold state. A drop into a
        // collapsed section is a slot the user aimed at, and moveBlocks opens
        // the fold over the landing afterwards (clause 4 / revealPosition,
        // MAR-146) — so the hazard has exactly ONE rule, and it is not here.
        // This module's only fold input stays `isHiddenTarget`, which refuses
        // targets that are ALREADY buried.
        const editor = await makeEditor("# One\n\n### Deep\n\ndeep\n\n## Two\n\nbody");
        const doc = view(editor).state.doc;
        const headings = outlineOf(doc);
        const deepPos = headings.find((h) => h.text === "Deep")!.pos;
        const slots = tocDropSlots(headings, doc, neverHiddenLocal);
        expect(slots.some((s) => s.kind === "into" && s.headingPos === deepPos)).toBe(true);
        // Every section gets one — no fold state subtracts from the offer.
        expect(slots.filter((s) => s.kind === "into").length).toBe(headings.length);
        // …and the section is a legal SIBLING target too, as always.
        expect(slots.some((s) => s.kind === "gap" && s.pos === deepPos)).toBe(true);
    });

    it("an into slot should carry its owner's level + 1, clamped at H6", async () => {
        const editor = await makeEditor("# One\n\nbody\n\n###### Deepest\n\nbody");
        const doc = view(editor).state.doc;
        const slots = tocDropSlots(outlineOf(doc), doc, neverHiddenLocal);
        const intos = slots.filter((s) => s.kind === "into");
        // H1 → child H2; H6 → child would be H7, so it clamps to H6.
        expect(intos.map((s) => s.targetLevel)).toEqual([2, 6]);
    });
});

describe("draggedSectionLevel", () => {
    it("a range starting at a heading should report that heading's level", async () => {
        const editor = await makeEditor("# One\n\nbody\n\n### Three\n\nbody");
        const doc = view(editor).state.doc;
        const headings = outlineOf(doc);
        expect(draggedSectionLevel(doc, { from: headings[0]!.pos, to: headings[1]!.pos })).toBe(1);
        expect(draggedSectionLevel(doc, { from: headings[1]!.pos, to: doc.content.size })).toBe(3);
    });

    it("a range starting at a non-heading should report null (nothing to relevel)", async () => {
        const editor = await makeEditor("a paragraph\n\n# One");
        const doc = view(editor).state.doc;
        expect(draggedSectionLevel(doc, { from: 0, to: 13 })).toBeNull();
    });
});

describe("tocRelevelDelta", () => {
    const slot = (targetLevel: number): MeasuredTocSlot => ({
        kind: "gap", pos: 0, tocIndex: 0, targetLevel, y: 0, left: 0, width: 100,
    });

    it("a heading run should shift by the gap between its rank and the target", () => {
        expect(tocRelevelDelta(slot(4), 2)).toBe(2);   // H2 dropped under an H3 → H4
        expect(tocRelevelDelta(slot(1), 3)).toBe(-2);  // H3 promoted to a top-level sibling
        expect(tocRelevelDelta(slot(2), 2)).toBe(0);   // already the right rank
    });

    it("a non-heading run should never relevel", () => {
        expect(tocRelevelDelta(slot(4), null)).toBe(0);
    });
});

describe("tocDropTargetFor", () => {
    // Two items: item 0 spans y 100–140, item 1 spans y 140–180.
    const slots: MeasuredTocSlot[] = [
        { kind: "gap", pos: 0, tocIndex: 0, targetLevel: 1, y: 100, left: 0, width: 200 },
        { kind: "into", pos: 50, tocIndex: 0, headingPos: 0, targetLevel: 2, y: 120, top: 100, height: 40, left: 0, width: 200 },
        { kind: "gap", pos: 50, tocIndex: 1, targetLevel: 1, y: 140, left: 0, width: 200 },
        { kind: "into", pos: 90, tocIndex: 1, headingPos: 50, targetLevel: 2, y: 160, top: 140, height: 40, left: 0, width: 200 },
        { kind: "gap", pos: 90, tocIndex: 2, targetLevel: 1, y: 180, left: 0, width: 200 },
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

    it("a drop at the dragged range's own start should survive when it relevels", () => {
        // Dropping a section ONTO the heading directly above it commits at
        // the section's own start (the put-it-back position) — but the rank
        // changes, so it is a real edit, not a no-op. Once drops relevel,
        // "same position" stops implying "nothing happened".
        // Slot 1 is into(pos 50, targetLevel 2); a range starting AT 50
        // carrying an H4 means delta = 2 - 4 = -2 ≠ 0 ⇒ the drop stands.
        const hit = tocDropTargetFor(slots, 120, { from: 50, to: 80 }, {
            allowInto: true,
            draggedLevel: 4,
        });
        expect(hit?.kind).toBe("into");
        expect(hit?.pos).toBe(50);
    });

    it("a drop at the dragged range's own start with NO rank change should stay a no-op", () => {
        // Same geometry, but the carried section is already an H2 — target
        // level 2, delta 0: nothing would change, so it is the put-it-back
        // gesture and must resolve to null.
        expect(
            tocDropTargetFor(slots, 120, { from: 50, to: 80 }, { allowInto: true, draggedLevel: 2 }),
        ).toBeNull();
    });

    it("a drop strictly inside the dragged range should stay null even when it would relevel", () => {
        // A section cannot nest inside its own subtree: only the range's
        // START is exempt, never a position within it.
        expect(
            tocDropTargetFor(slots, 120, { from: 20, to: 80 }, { allowInto: true, draggedLevel: 4 }),
        ).toBeNull();
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
            { kind: "gap", pos: 0, tocIndex: 0, targetLevel: 1, y: 100, left: 0, width: 200 },
            { kind: "into", pos: 10, tocIndex: 0, headingPos: 0, targetLevel: 2, y: 100, top: 100, height: 0, left: 0, width: 200 },
            { kind: "gap", pos: 10, tocIndex: 1, targetLevel: 1, y: 100, left: 0, width: 200 },
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
