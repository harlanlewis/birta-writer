/**
 * Tests for self-sinking checklists (MAR-175, editing/checklistSink): checking
 * a task item sinks it below the still-unchecked siblings, unchecking floats it
 * back up, both as ONE undo step; the "uncheck all" command clears a list in one
 * step; and the reorder round-trips (whole list_item nodes carry their attrs).
 *
 * Drives the REAL Milkdown editor — real parser, real schema, the production
 * serialization config, plus the fold/history/content-guard/list-spread plugins
 * — exactly like the browser, so the assertions are on serialized markdown and
 * on the live document, not on a mock. acquireVsCodeApi is injected by setup.ts.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import type { Node as ProseNode } from "../pm";
import { TextSelection, undo } from "../pm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import { historyPlugin } from "../plugins/history";
import { contentGuardPlugin } from "../plugins/contentGuard";
import { listSpreadNormalizePlugin } from "../plugins/list";
import { applyTaskToggle, sinkTargetPos, uncheckAllTasks } from "../editing/checklistSink";

// The landing flash is a geometry no-op under jsdom; mock it so the tests assert
// the reorder/undo/serialization, not the visual (moveBlocks.test's idiom).
vi.mock("../editing/rangeIndicator", () => ({
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
        // The list-spread appendTransaction runs in production; include it so the
        // "does not split the undo or loosen the list" contract is exercised.
        .use(listSpreadNormalizePlugin)
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
 * Position of the list_item whose leading paragraph is exactly `text`. A
 * list_item opens one token before its first paragraph, so itemPos = paraPos-1
 * — and matching the PARAGRAPH avoids a parent item's textContent (which
 * concatenates its nested children) shadowing the match.
 */
function itemPos(v: EditorView, text: string): number {
    const paraPos = nodePos(v, text, "paragraph");
    return paraPos - 1;
}

/** The checked attr of the list_item whose leading paragraph is `text`. */
function checkedOf(v: EditorView, text: string): unknown {
    return v.state.doc.nodeAt(itemPos(v, text))!.attrs["checked"];
}

/** Put the caret just inside the block whose text is `text`. */
function caretInto(v: EditorView, text: string, type?: string): void {
    const pos = nodePos(v, text, type);
    v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(pos + 1))));
}

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

// ── Checking sinks below the unchecked group ────────────────────────────────

describe("checklistSink — checking an item", () => {
    it("checking an item should sink it below the still-unchecked siblings", async () => {
        const editor = await makeEditor("- [ ] a\n- [ ] b\n- [ ] c");
        const v = view(editor);
        applyTaskToggle(v, itemPos(v, "a"), true, true);
        expect(markdown(editor)).toBe("- [ ] b\n- [ ] c\n- [x] a");
    });

    it("checking should be ONE undo step that restores the exact prior order", async () => {
        const editor = await makeEditor("- [ ] a\n- [ ] b\n- [ ] c");
        const v = view(editor);
        applyTaskToggle(v, itemPos(v, "a"), true, true);
        expect(markdown(editor)).toBe("- [ ] b\n- [ ] c\n- [x] a");

        // A single undo — not two — restores both the order AND the checkbox.
        undo(v.state, v.dispatch);
        expect(markdown(editor)).toBe("- [ ] a\n- [ ] b\n- [ ] c");
    });

    it("the moved item should keep its checked attr through the reorder and round-trip", async () => {
        const editor = await makeEditor("- [ ] a\n- [ ] b\n- [ ] c");
        const v = view(editor);
        applyTaskToggle(v, itemPos(v, "a"), true, true);
        // The relocated node carries its flipped attr (round-trip: whole
        // list_item nodes carry checked/label/spread — never rewritten).
        expect(checkedOf(v, "a")).toBe(true);
        expect(checkedOf(v, "b")).toBe(false);

        undo(v.state, v.dispatch);
        expect(checkedOf(v, "a")).toBe(false);
    });

    it("checking with no unchecked siblings should flip in place (nothing to sink below)", async () => {
        const editor = await makeEditor("- [x] a\n- [ ] b\n- [x] c");
        const v = view(editor);
        // b is the only unchecked; checking it leaves no unchecked group.
        applyTaskToggle(v, itemPos(v, "b"), true, true);
        expect(markdown(editor)).toBe("- [x] a\n- [x] b\n- [x] c");
    });
});

// ── Unchecking floats back up (the symmetric inverse) ───────────────────────

describe("checklistSink — unchecking an item", () => {
    it("unchecking should float the item to the bottom of the unchecked group", async () => {
        const editor = await makeEditor("- [ ] a\n- [x] b\n- [x] c");
        const v = view(editor);
        // Uncheck c (the last item): it floats up to just after the unchecked a,
        // above the still-checked b.
        applyTaskToggle(v, itemPos(v, "c"), false, true);
        expect(markdown(editor)).toBe("- [ ] a\n- [ ] c\n- [x] b");
    });

    it("unchecking should be one undo step that restores the prior order", async () => {
        const editor = await makeEditor("- [ ] a\n- [x] b\n- [x] c");
        const v = view(editor);
        applyTaskToggle(v, itemPos(v, "c"), false, true);
        expect(markdown(editor)).toBe("- [ ] a\n- [ ] c\n- [x] b");

        undo(v.state, v.dispatch);
        expect(markdown(editor)).toBe("- [ ] a\n- [x] b\n- [x] c");
    });
});

// ── Nesting: a parent moves with its subtree ────────────────────────────────

describe("checklistSink — nested subtrees", () => {
    it("checking a parent item should carry its nested children as one subtree", async () => {
        const editor = await makeEditor(
            "- [ ] alpha\n  - [ ] a1\n  - [ ] a2\n- [ ] beta\n- [ ] gamma",
        );
        const v = view(editor);
        applyTaskToggle(v, itemPos(v, "alpha"), true, true);
        // alpha sinks below beta/gamma, and a1/a2 stay nested beneath it as one
        // subtree (the nested sublist rides inside the moved list_item). A parent
        // item carrying a sublist makes the outer list loose, so listSpread-
        // NormalizePlugin canonicalizes the items to blank-line separation — an
        // edit-triggered spread fix orthogonal to the reorder.
        expect(markdown(editor)).toBe(
            "- [ ] beta\n\n- [ ] gamma\n\n- [x] alpha\n\n  - [ ] a1\n  - [ ] a2",
        );

        // A single undo restores the subtree to the top, in the same canonical
        // (loose) form — the ORDER is restored exactly in one step; the spread
        // normalization is the unrelated plugin's doing, not a second undo step.
        undo(v.state, v.dispatch);
        expect(markdown(editor)).toBe(
            "- [ ] alpha\n\n  - [ ] a1\n  - [ ] a2\n\n- [ ] beta\n\n- [ ] gamma",
        );
    });
});

// ── Setting OFF: the plain in-place flip (unchanged behavior) ────────────────

describe("checklistSink — sink disabled", () => {
    it("with sink off, checking should flip in place with no reorder", async () => {
        const editor = await makeEditor("- [ ] a\n- [ ] b\n- [ ] c");
        const v = view(editor);
        applyTaskToggle(v, itemPos(v, "a"), true, false);
        // a stays at the top — exactly the historical plain flip.
        expect(markdown(editor)).toBe("- [x] a\n- [ ] b\n- [ ] c");
    });
});

// ── Uncheck-all clears the list in one undo step ────────────────────────────

describe("checklistSink — uncheck all", () => {
    it("should clear every checked item in the caret's list in one undo step", async () => {
        const editor = await makeEditor("- [x] a\n- [x] b\n- [ ] c");
        const v = view(editor);
        caretInto(v, "a", "paragraph");
        expect(uncheckAllTasks(v)).toBe(true);
        expect(markdown(editor)).toBe("- [ ] a\n- [ ] b\n- [ ] c");

        undo(v.state, v.dispatch);
        expect(markdown(editor)).toBe("- [x] a\n- [x] b\n- [ ] c");
    });

    it("should be a no-op when the caret is not inside a list", async () => {
        const editor = await makeEditor("plain paragraph\n\n- [x] a");
        const v = view(editor);
        caretInto(v, "plain paragraph", "paragraph");
        const before = markdown(editor);
        expect(uncheckAllTasks(v)).toBe(false);
        expect(markdown(editor)).toBe(before);
    });
});

// ── The list-spread normalizer must not split the undo or loosen the list ───

describe("checklistSink — list-spread interaction", () => {
    it("a sink on a tight list should stay tight and remain one undo step", async () => {
        const editor = await makeEditor("- [ ] a\n- [ ] b\n- [ ] c");
        const v = view(editor);
        applyTaskToggle(v, itemPos(v, "a"), true, true);
        const after = markdown(editor);
        // Tight: no blank line between items (a loosened list would gain them).
        expect(after).toBe("- [ ] b\n- [ ] c\n- [x] a");
        expect(after).not.toMatch(/\n\n/);
        // The appendTransaction normalizer did not add a second history event.
        undo(v.state, v.dispatch);
        expect(markdown(editor)).toBe("- [ ] a\n- [ ] b\n- [ ] c");
    });
});

// ── The pure target rule (documents the check/uncheck symmetry) ─────────────

describe("checklistSink — sinkTargetPos", () => {
    it("checking with no unchecked siblings should return null (no move)", async () => {
        const editor = await makeEditor("- [x] a\n- [ ] b\n- [x] c");
        const v = view(editor);
        expect(sinkTargetPos(v.state.doc, itemPos(v, "b"), true)).toBeNull();
    });

    it("a top-level (non-list) position should return null", async () => {
        const editor = await makeEditor("just a paragraph");
        const v = view(editor);
        expect(sinkTargetPos(v.state.doc, 0, true)).toBeNull();
    });
});
