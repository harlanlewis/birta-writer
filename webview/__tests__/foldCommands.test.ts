/**
 * Tests for the keyboard fold commands (fold/unfold/foldAll/unfoldAll —
 * plugins/headingFold.ts): the directional foldAtCaret/unfoldAtCaret pair
 * and the wholesale foldAllCommand/unfoldAllCommand, all driving the fold
 * plugin state through its metas. The boundary-head probe (a non-empty
 * FORWARD selection resolves its foldable at head−1, never the block AFTER
 * the selection) is regression-tested here — foldPlugin.test.ts covers the
 * broader grammar (callouts, persistence, reveals).
 *
 * Drives the REAL Milkdown editor (real parser, real schema, the production
 * serialization config) so section ranges and position math match production.
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "@milkdown/prose/view";
import { TextSelection } from "@milkdown/prose/state";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { BlockRangeSelection } from "../plugins/blockRange";
import {
    cachedFoldRanges,
    foldAllCommand,
    foldAtCaret,
    foldPluginKey,
    headingFoldPlugin,
    unfoldAllCommand,
    unfoldAtCaret,
    type FoldMeta,
} from "../plugins/headingFold";

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
        .create();
    editors.push(editor);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
    document.body.className = "";
});

/** Document positions of every heading, in document order. */
function headingPositions(v: EditorView): number[] {
    const positions: number[] = [];
    v.state.doc.forEach((node, offset) => {
        if (node.type.name === "heading") {
            positions.push(offset);
        }
    });
    return positions;
}

function folded(v: EditorView): ReadonlySet<number> {
    return foldPluginKey.getState(v.state)!.folded;
}

function setCaret(v: EditorView, pos: number): void {
    v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(pos))));
}

/** Runs a command against the live view, counting dispatched transactions. */
function run(
    v: EditorView,
    cmd: typeof foldAtCaret,
): { applied: boolean; dispatches: number } {
    let dispatches = 0;
    const applied = cmd(v.state, (tr) => {
        dispatches++;
        v.dispatch(tr);
    }, v);
    return { applied, dispatches };
}

// A three-section outline: H2 A (body), H1 Top (owning H2 Inner), so both
// nesting (Inner inside Top) and siblings (A vs Top) are represented.
const OUTLINE = "## A\n\nalpha body\n\n# Top\n\ntop body\n\n## Inner\n\ninner body";

describe("foldAtCaret", () => {
    it("a caret inside a section body should fold it and land the caret on the heading text", async () => {
        // Arrange: caret in "alpha body" (the paragraph after H2 A)
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [hA] = headingPositions(v);
        const headingNode = v.state.doc.nodeAt(hA!)!;
        setCaret(v, hA! + headingNode.nodeSize + 2);

        // Act
        const { applied, dispatches } = run(v, foldAtCaret);

        // Assert: folded, caret rescued onto the heading's own text — never
        // orphaned inside the now-hidden body.
        expect(applied).toBe(true);
        expect(dispatches).toBe(1);
        expect(folded(v).has(hA!)).toBe(true);
        expect(v.state.selection.head).toBeGreaterThan(hA!);
        expect(v.state.selection.head).toBeLessThan(hA! + headingNode.nodeSize);
    });

    it("a caret inside a nested section should fold the INNERMOST section only", async () => {
        // Arrange: caret in "inner body" — inside both Top's and Inner's sections
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [, hTop, hInner] = headingPositions(v);
        setCaret(v, v.state.doc.content.size - 2);

        // Act
        const { applied } = run(v, foldAtCaret);

        // Assert
        expect(applied).toBe(true);
        expect(folded(v).has(hInner!)).toBe(true);
        expect(folded(v).has(hTop!)).toBe(false);
    });

    it("a caret on the heading line itself should fold without moving the caret", async () => {
        // Arrange: caret inside "## A"'s own text
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [hA] = headingPositions(v);
        setCaret(v, hA! + 2);
        const before = v.state.selection.head;

        // Act
        const { applied } = run(v, foldAtCaret);

        // Assert: folded, caret untouched (it was never in the hidden body)
        expect(applied).toBe(true);
        expect(folded(v).has(hA!)).toBe(true);
        expect(v.state.selection.head).toBe(before);
    });

    it("an already-folded innermost section should bubble to the still-open ancestor", async () => {
        // Arrange: fold Inner, caret stays on Inner's (visible) heading line
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [, hTop, hInner] = headingPositions(v);
        setCaret(v, hInner! + 2);
        expect(run(v, foldAtCaret).applied).toBe(true);
        expect(folded(v).has(hInner!)).toBe(true);

        // Act: the fold chord again — VS Code fold-at-cursor bubbling
        const { applied } = run(v, foldAtCaret);

        // Assert: the ancestor folded; Inner stayed folded (never toggled open)
        expect(applied).toBe(true);
        expect(folded(v).has(hTop!)).toBe(true);
        expect(folded(v).has(hInner!)).toBe(true);
    });

    it("an already-folded section with no foldable ancestor should return false with no dispatch (directional)", async () => {
        // Arrange: fold A (a top-level section), caret on its heading line
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [hA] = headingPositions(v);
        setCaret(v, hA! + 2);
        expect(run(v, foldAtCaret).applied).toBe(true);

        // Act: the fold chord again — must NOT toggle back open
        const { applied, dispatches } = run(v, foldAtCaret);

        // Assert
        expect(applied).toBe(false);
        expect(dispatches).toBe(0);
        expect(folded(v).has(hA!)).toBe(true);
    });

    it("a caret outside any section should return false", async () => {
        // Arrange: a document with no headings at all
        const editor = await makeEditor("just a paragraph\n\nanother one");
        const v = view(editor);
        setCaret(v, 2);

        // Act + Assert
        const { applied, dispatches } = run(v, foldAtCaret);
        expect(applied).toBe(false);
        expect(dispatches).toBe(0);
    });

    it("a forward block-range selection over a section's last body block should fold ITS section, not the next", async () => {
        // Arrange: `## A / alpha / ## B / beta`; Escape-select "alpha" — a
        // forward BlockRangeSelection whose head sits at the block's END
        // boundary, a depth-0 position EQUAL to `## B`'s offset. Resolving
        // the head inclusively folded B (regression — the boundary-head
        // probe resolves at head−1 for non-empty forward selections).
        const editor = await makeEditor("## A\n\nalpha\n\n## B\n\nbeta");
        const v = view(editor);
        const [hA, hB] = headingPositions(v);
        const alphaStart = hA! + v.state.doc.nodeAt(hA!)!.nodeSize;
        const range = BlockRangeSelection.tryCreate(v.state.doc, alphaStart, hB!);
        expect(range).not.toBeNull();
        expect(range!.head).toBe(hB!); // the boundary collision under test
        v.dispatch(v.state.tr.setSelection(range!));

        // Act
        const { applied } = run(v, foldAtCaret);

        // Assert: A folded, B untouched — and the caret rescue fired (the
        // selection overlapped A's now-hidden body), landing on A's heading.
        expect(applied).toBe(true);
        expect(folded(v).has(hA!)).toBe(true);
        expect(folded(v).has(hB!)).toBe(false);
        const aNode = v.state.doc.nodeAt(hA!)!;
        expect(v.state.selection.head).toBeGreaterThan(hA!);
        expect(v.state.selection.head).toBeLessThan(hA! + aNode.nodeSize);
    });

    it("a BACKWARD block-range selection should keep resolving at its head (the range start)", async () => {
        // Arrange: backward range over "beta" — head at beta's START, which
        // is inside B's section; the boundary rule must not disturb this.
        const editor = await makeEditor("## A\n\nalpha\n\n## B\n\nbeta");
        const v = view(editor);
        const [hA, hB] = headingPositions(v);
        const betaStart = hB! + v.state.doc.nodeAt(hB!)!.nodeSize;
        const range = BlockRangeSelection.tryCreate(
            v.state.doc, v.state.doc.content.size, betaStart,
        );
        expect(range).not.toBeNull();
        v.dispatch(v.state.tr.setSelection(range!));

        // Act + Assert: B folds (the section the head points into)
        const { applied } = run(v, foldAtCaret);
        expect(applied).toBe(true);
        expect(folded(v).has(hB!)).toBe(true);
        expect(folded(v).has(hA!)).toBe(false);
    });

    it("the fold dispatch should carry addToHistory:false (fold state is not an undo step)", async () => {
        // Arrange
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        setCaret(v, headingPositions(v)[0]! + 2);

        // Act: capture the transaction the command builds
        const captured: Array<{ getMeta(name: string): unknown }> = [];
        foldAtCaret(v.state, (tr) => {
            captured.push(tr);
            v.dispatch(tr);
        }, v);

        // Assert
        expect(captured).toHaveLength(1);
        expect(captured[0]!.getMeta("addToHistory")).toBe(false);
    });
});

describe("unfoldAtCaret", () => {
    it("a caret on a folded heading line should unfold that section", async () => {
        // Arrange: fold A from its body, caret now rests on the heading
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [hA] = headingPositions(v);
        setCaret(v, hA! + 2);
        run(v, foldAtCaret);
        expect(folded(v).has(hA!)).toBe(true);

        // Act
        const { applied } = run(v, unfoldAtCaret);

        // Assert
        expect(applied).toBe(true);
        expect(folded(v).has(hA!)).toBe(false);
    });

    it("a caret under an open section inside a folded ancestor should unfold the innermost FOLDED ancestor", async () => {
        // Arrange: fold Top only (Inner stays open); park the caret inside
        // Inner's body — its own section is open, but Top hides it.
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [, hTop, hInner] = headingPositions(v);
        v.dispatch(v.state.tr
            .setMeta(foldPluginKey, { type: "toggle", pos: hTop! } satisfies FoldMeta)
            .setMeta("addToHistory", false));
        setCaret(v, v.state.doc.content.size - 2);

        // Act
        const { applied } = run(v, unfoldAtCaret);

        // Assert: Top (the innermost folded section containing the caret)
        // opened; Inner was never folded.
        expect(applied).toBe(true);
        expect(folded(v).has(hTop!)).toBe(false);
        expect(folded(v).has(hInner!)).toBe(false);
    });

    it("both ancestor and own section folded should progressively reveal: outer fold first, then the inner", async () => {
        // Arrange: fold Top AND Inner, then drop the caret into Inner's
        // (doubly hidden) body. The caret skip-over guard forbids a caret
        // inside hidden content, so it is ejected onto Top's visible heading
        // line BEFORE any command runs — the old "unfold the innermost fold
        // around a hidden caret" state is unreachable for empty carets.
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [, hTop, hInner] = headingPositions(v);
        for (const pos of [hTop!, hInner!]) {
            v.dispatch(v.state.tr
                .setMeta(foldPluginKey, { type: "toggle", pos } satisfies FoldMeta)
                .setMeta("addToHistory", false));
        }
        setCaret(v, v.state.doc.content.size - 2);
        const topNode = v.state.doc.nodeAt(hTop!)!;
        expect(v.state.selection.head).toBeLessThan(hTop! + topNode.nodeSize); // ejected out of hidden content

        // Act: unfold at the ejected caret — the fold AT the caret opens
        const first = run(v, unfoldAtCaret);

        // Assert: Top opened, Inner still folded (progressive disclosure)
        expect(first.applied).toBe(true);
        expect(folded(v).has(hTop!)).toBe(false);
        expect(folded(v).has(hInner!)).toBe(true);

        // Act again from Inner's now-visible heading line: Inner opens too
        setCaret(v, hInner! + 2);
        const second = run(v, unfoldAtCaret);
        expect(second.applied).toBe(true);
        expect(folded(v).has(hInner!)).toBe(false);
    });

    it("an Escape-selected COLLAPSED heading (block range spanning its hidden body) should unfold ITS section, not the next", async () => {
        // Arrange: fold A, then select it the way Escape does on a collapsed
        // heading — a forward block range over heading + hidden body, whose
        // head is the fold range's END boundary (= `## B`'s offset). The
        // inclusive head resolution unfolded B instead (regression).
        const editor = await makeEditor("## A\n\nalpha\n\n## B\n\nbeta");
        const v = view(editor);
        const [hA, hB] = headingPositions(v);
        setCaret(v, hA! + 2);
        run(v, foldAtCaret);
        expect(folded(v).has(hA!)).toBe(true);
        const foldEnd = cachedFoldRanges(v.state.doc).get(hA!)!.to;
        expect(foldEnd).toBe(hB!); // A's hidden body ends where B begins
        const range = BlockRangeSelection.tryCreate(v.state.doc, hA!, foldEnd);
        expect(range).not.toBeNull();
        v.dispatch(v.state.tr.setSelection(range!));

        // Act
        const { applied } = run(v, unfoldAtCaret);

        // Assert: A opened; B (never folded) untouched
        expect(applied).toBe(true);
        expect(folded(v).has(hA!)).toBe(false);
        expect(folded(v).has(hB!)).toBe(false);
    });

    it("nothing folded around the caret should return false with no dispatch", async () => {
        // Arrange: A folded, but the caret sits in Top's (open) body
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [hA, hTop] = headingPositions(v);
        v.dispatch(v.state.tr
            .setMeta(foldPluginKey, { type: "toggle", pos: hA! } satisfies FoldMeta)
            .setMeta("addToHistory", false));
        const topNode = v.state.doc.nodeAt(hTop!)!;
        setCaret(v, hTop! + topNode.nodeSize + 2);

        // Act + Assert
        const { applied, dispatches } = run(v, unfoldAtCaret);
        expect(applied).toBe(false);
        expect(dispatches).toBe(0);
        expect(folded(v).has(hA!)).toBe(true);
    });
});

describe("foldAllCommand", () => {
    it("an unfolded outline should fold every foldable heading at once", async () => {
        // Arrange
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const positions = headingPositions(v);
        setCaret(v, 2);

        // Act
        const { applied, dispatches } = run(v, foldAllCommand);

        // Assert: one transaction, all three sections folded
        expect(applied).toBe(true);
        expect(dispatches).toBe(1);
        expect(folded(v).size).toBe(3);
        for (const pos of positions) {
            expect(folded(v).has(pos)).toBe(true);
        }
    });

    it("a caret deep in a nested body should be ejected out of the hidden content", async () => {
        // Arrange: caret in "inner body" — after fold-all, Inner's own
        // heading line hides inside Top's folded body; only Top stays
        // visible. The skip-over guard must not leave the caret stranded
        // inside display:none content.
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        setCaret(v, v.state.doc.content.size - 2);

        // Act
        run(v, foldAllCommand);

        // Assert: the caret sits outside every hidden range
        const hiddenRanges = [...cachedFoldRanges(v.state.doc)]
            .filter(([pos, range]) => range !== null && folded(v).has(pos))
            .map(([, range]) => range!);
        const head = v.state.selection.head;
        for (const range of hiddenRanges) {
            expect(head < range.from || head >= range.to).toBe(true);
        }
    });

    it("a caret outside every section should stay where it is", async () => {
        // Arrange: leading paragraph before the first heading
        const editor = await makeEditor("preamble\n\n# One\n\nbody");
        const v = view(editor);
        setCaret(v, 2);
        const before = v.state.selection.head;

        // Act
        const { applied } = run(v, foldAllCommand);

        // Assert
        expect(applied).toBe(true);
        expect(v.state.selection.head).toBe(before);
    });

    it("running twice should be idempotent (same folded set, no toggling open)", async () => {
        // Arrange
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        setCaret(v, 2);
        expect(run(v, foldAllCommand).applied).toBe(true);
        const after = [...folded(v)].sort((a, b) => a - b);

        // Act + Assert: fold-all again never unfolds anything
        run(v, foldAllCommand);
        expect([...folded(v)].sort((a, b) => a - b)).toEqual(after);
    });

    it("a document with no foldable headings should return false", async () => {
        // Arrange: a heading with no body owns nothing (not foldable)
        const editor = await makeEditor("plain paragraph\n\n# Empty");
        const v = view(editor);
        setCaret(v, 2);

        // Act + Assert
        const { applied, dispatches } = run(v, foldAllCommand);
        expect(applied).toBe(false);
        expect(dispatches).toBe(0);
    });
});

describe("unfoldAllCommand", () => {
    it("a folded outline should unfold everything in one transaction", async () => {
        // Arrange
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        setCaret(v, 2);
        run(v, foldAllCommand);
        expect(folded(v).size).toBe(3);

        // Act
        const { applied, dispatches } = run(v, unfoldAllCommand);

        // Assert
        expect(applied).toBe(true);
        expect(dispatches).toBe(1);
        expect(folded(v).size).toBe(0);
    });

    it("nothing folded should return false with no dispatch", async () => {
        // Arrange
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);

        // Act + Assert
        const { applied, dispatches } = run(v, unfoldAllCommand);
        expect(applied).toBe(false);
        expect(dispatches).toBe(0);
    });
});
