/**
 * Tests for the keyboard fold commands (plugins/foldCommands.ts): the
 * directional foldSection/unfoldSection pair and the wholesale
 * foldAllSections/unfoldAllSections, all driving headingFold's plugin state
 * through its metas — plus the `setAll` reducer branch itself.
 *
 * Drives the REAL Milkdown editor (real parser, real schema, the production
 * serialization config) so section ranges and position math match production.
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import type { EditorView } from "@milkdown/prose/view";
import { TextSelection } from "@milkdown/prose/state";
import { configureSerialization, pureCommonmark } from "../serialization";
import { headingFoldPlugin, headingFoldPluginKey, type HeadingFoldMeta } from "../plugins/headingFold";
import {
    foldAllSections,
    foldSection,
    unfoldAllSections,
    unfoldSection,
} from "../plugins/foldCommands";

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
    return headingFoldPluginKey.getState(v.state)!.folded;
}

function setCaret(v: EditorView, pos: number): void {
    v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(pos))));
}

/** Runs a command against the live view, counting dispatched transactions. */
function run(
    v: EditorView,
    cmd: typeof foldSection,
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

describe("foldSection", () => {
    it("a caret inside a section body should fold it and land the caret on the heading text", async () => {
        // Arrange: caret in "alpha body" (the paragraph after H2 A)
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [hA] = headingPositions(v);
        const headingNode = v.state.doc.nodeAt(hA!)!;
        setCaret(v, hA! + headingNode.nodeSize + 2);

        // Act
        const { applied, dispatches } = run(v, foldSection);

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
        const { applied } = run(v, foldSection);

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
        const { applied } = run(v, foldSection);

        // Assert: folded, caret untouched (it was never in the hidden body)
        expect(applied).toBe(true);
        expect(folded(v).has(hA!)).toBe(true);
        expect(v.state.selection.head).toBe(before);
    });

    it("an already-folded section should return false with no dispatch (directional)", async () => {
        // Arrange: fold A, caret on its heading line
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [hA] = headingPositions(v);
        setCaret(v, hA! + 2);
        expect(run(v, foldSection).applied).toBe(true);

        // Act: the fold chord again — must NOT toggle back open
        const { applied, dispatches } = run(v, foldSection);

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
        const { applied, dispatches } = run(v, foldSection);
        expect(applied).toBe(false);
        expect(dispatches).toBe(0);
    });

    it("the fold dispatch should carry addToHistory:false (fold state is not an undo step)", async () => {
        // Arrange
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        setCaret(v, headingPositions(v)[0]! + 2);

        // Act: capture the transaction the command builds
        const captured: Array<{ getMeta(name: string): unknown }> = [];
        foldSection(v.state, (tr) => {
            captured.push(tr);
            v.dispatch(tr);
        }, v);

        // Assert
        expect(captured).toHaveLength(1);
        expect(captured[0]!.getMeta("addToHistory")).toBe(false);
    });
});

describe("unfoldSection", () => {
    it("a caret on a folded heading line should unfold that section", async () => {
        // Arrange: fold A from its body, caret now rests on the heading
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [hA] = headingPositions(v);
        setCaret(v, hA! + 2);
        run(v, foldSection);
        expect(folded(v).has(hA!)).toBe(true);

        // Act
        const { applied } = run(v, unfoldSection);

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
            .setMeta(headingFoldPluginKey, { type: "toggle", pos: hTop! } satisfies HeadingFoldMeta)
            .setMeta("addToHistory", false));
        setCaret(v, v.state.doc.content.size - 2);

        // Act
        const { applied } = run(v, unfoldSection);

        // Assert: Top (the innermost folded section containing the caret)
        // opened; Inner was never folded.
        expect(applied).toBe(true);
        expect(folded(v).has(hTop!)).toBe(false);
        expect(folded(v).has(hInner!)).toBe(false);
    });

    it("both ancestor and own section folded should unfold the innermost first", async () => {
        // Arrange: fold Top AND Inner, caret in Inner's body
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [, hTop, hInner] = headingPositions(v);
        for (const pos of [hTop!, hInner!]) {
            v.dispatch(v.state.tr
                .setMeta(headingFoldPluginKey, { type: "toggle", pos } satisfies HeadingFoldMeta)
                .setMeta("addToHistory", false));
        }
        setCaret(v, v.state.doc.content.size - 2);

        // Act
        const { applied } = run(v, unfoldSection);

        // Assert: Inner opened, Top still folded — repeated chords walk outward.
        expect(applied).toBe(true);
        expect(folded(v).has(hInner!)).toBe(false);
        expect(folded(v).has(hTop!)).toBe(true);
    });

    it("nothing folded around the caret should return false with no dispatch", async () => {
        // Arrange: A folded, but the caret sits in Top's (open) body
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [hA, hTop] = headingPositions(v);
        v.dispatch(v.state.tr
            .setMeta(headingFoldPluginKey, { type: "toggle", pos: hA! } satisfies HeadingFoldMeta)
            .setMeta("addToHistory", false));
        const topNode = v.state.doc.nodeAt(hTop!)!;
        setCaret(v, hTop! + topNode.nodeSize + 2);

        // Act + Assert
        const { applied, dispatches } = run(v, unfoldSection);
        expect(applied).toBe(false);
        expect(dispatches).toBe(0);
        expect(folded(v).has(hA!)).toBe(true);
    });
});

describe("foldAllSections", () => {
    it("an unfolded outline should fold every foldable heading at once", async () => {
        // Arrange
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const positions = headingPositions(v);
        setCaret(v, 2);

        // Act
        const { applied, dispatches } = run(v, foldAllSections);

        // Assert: one transaction, all three sections folded
        expect(applied).toBe(true);
        expect(dispatches).toBe(1);
        expect(folded(v).size).toBe(3);
        for (const pos of positions) {
            expect(folded(v).has(pos)).toBe(true);
        }
    });

    it("a caret deep in a nested body should relocate to the OUTERMOST enclosing heading", async () => {
        // Arrange: caret in "inner body" — after fold-all, Inner's own
        // heading line hides inside Top's folded body; only Top stays visible.
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [, hTop] = headingPositions(v);
        setCaret(v, v.state.doc.content.size - 2);

        // Act
        run(v, foldAllSections);

        // Assert: caret on Top's own text
        const topNode = v.state.doc.nodeAt(hTop!)!;
        expect(v.state.selection.head).toBeGreaterThan(hTop!);
        expect(v.state.selection.head).toBeLessThan(hTop! + topNode.nodeSize);
    });

    it("a caret outside every section should stay where it is", async () => {
        // Arrange: leading paragraph before the first heading
        const editor = await makeEditor("preamble\n\n# One\n\nbody");
        const v = view(editor);
        setCaret(v, 2);
        const before = v.state.selection.head;

        // Act
        const { applied } = run(v, foldAllSections);

        // Assert
        expect(applied).toBe(true);
        expect(v.state.selection.head).toBe(before);
    });

    it("everything already folded should return false with no dispatch", async () => {
        // Arrange
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        setCaret(v, 2);
        expect(run(v, foldAllSections).applied).toBe(true);

        // Act + Assert
        const { applied, dispatches } = run(v, foldAllSections);
        expect(applied).toBe(false);
        expect(dispatches).toBe(0);
    });

    it("a document with no foldable headings should return false", async () => {
        // Arrange: a heading with no body owns nothing (not foldable)
        const editor = await makeEditor("plain paragraph\n\n# Empty");
        const v = view(editor);
        setCaret(v, 2);

        // Act + Assert
        const { applied, dispatches } = run(v, foldAllSections);
        expect(applied).toBe(false);
        expect(dispatches).toBe(0);
    });
});

describe("unfoldAllSections", () => {
    it("a folded outline should unfold everything in one transaction", async () => {
        // Arrange
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        setCaret(v, 2);
        run(v, foldAllSections);
        expect(folded(v).size).toBe(3);

        // Act
        const { applied, dispatches } = run(v, unfoldAllSections);

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
        const { applied, dispatches } = run(v, unfoldAllSections);
        expect(applied).toBe(false);
        expect(dispatches).toBe(0);
    });
});

describe("headingFold setAll meta", () => {
    it("non-heading positions in the folded payload should be filtered out", async () => {
        // Arrange
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [hA] = headingPositions(v);

        // Act: a heading position mixed with a text position (hA+1 resolves
        // to the heading's text node, not a heading) and a paragraph position
        const headingNode = v.state.doc.nodeAt(hA!)!;
        const paragraphPos = hA! + headingNode.nodeSize;
        v.dispatch(v.state.tr
            .setMeta(headingFoldPluginKey, {
                type: "setAll",
                folded: [hA!, hA! + 1, paragraphPos],
            } satisfies HeadingFoldMeta)
            .setMeta("addToHistory", false));

        // Assert: only the real heading survives the reducer
        expect([...folded(v)]).toEqual([hA!]);
    });

    it("an empty folded payload should clear every existing fold entry", async () => {
        // Arrange
        const editor = await makeEditor(OUTLINE);
        const v = view(editor);
        const [hA] = headingPositions(v);
        v.dispatch(v.state.tr
            .setMeta(headingFoldPluginKey, { type: "toggle", pos: hA! } satisfies HeadingFoldMeta)
            .setMeta("addToHistory", false));
        expect(folded(v).size).toBe(1);

        // Act
        v.dispatch(v.state.tr
            .setMeta(headingFoldPluginKey, { type: "setAll", folded: [] } satisfies HeadingFoldMeta)
            .setMeta("addToHistory", false));

        // Assert
        expect(folded(v).size).toBe(0);
    });
});
