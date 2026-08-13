/**
 * The fold-level commands and the recursive (Alt+click) fold — MAR-116.
 *
 * `foldLevels.test.ts` settles what "level" MEANS; this file drives the
 * commands that act on it, through the real fold plugin state, and covers the
 * three obligations a new fold producer inherits:
 *
 *   - it folds the right regions and leaves the others alone,
 *   - the folds it produces persist through the anchors bag like any other, so
 *     reopening the file does not silently drop them,
 *   - it reports false rather than dispatching an empty transaction, so a
 *     palette entry that can do nothing says so.
 *
 * Drives the REAL Milkdown editor; acquireVsCodeApi is injected by setup.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    computeFoldAnchors,
    foldPluginKey,
    foldSubtreeAt,
    foldToLevel,
    foldablesAtLevel,
    headingFoldPlugin,
    resolveFoldAnchors,
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

const view = (editor: Editor): EditorView => editor.ctx.get(editorViewCtx);
const foldedOf = (v: EditorView): Set<number> =>
    new Set(foldPluginKey.getState(v.state)?.folded ?? []);

/** Run a ProseMirror Command against the live view. */
function run(v: EditorView, cmd: (s: any, d: any) => boolean): boolean {
    return cmd(v.state, v.dispatch.bind(v));
}

const NESTED = "# One\n\ntext\n\n## Two\n\ntext\n\n### Three\n\ntext\n\n# Four\n\ntext\n";

afterEach(async () => {
    await Promise.all(editors.map((e) => e.destroy()));
    editors = [];
    document.body.innerHTML = "";
});

describe("foldToLevel", () => {
    it("folding level 1 should fold both outermost sections and nothing else", async () => {
        const v = view(await makeEditor(NESTED));
        const expected = foldablesAtLevel(v.state.doc, 1);
        expect(expected).toHaveLength(2);
        expect(run(v, foldToLevel(1))).toBe(true);
        expect([...foldedOf(v)].sort((a, b) => a - b)).toEqual(expected);
    });

    it("folding level 2 should fold the inner section and leave level 1 open", async () => {
        const v = view(await makeEditor(NESTED));
        const level1 = foldablesAtLevel(v.state.doc, 1);
        const level2 = foldablesAtLevel(v.state.doc, 2);
        expect(level2).toHaveLength(1);
        expect(run(v, foldToLevel(2))).toBe(true);
        const folded = foldedOf(v);
        expect([...folded]).toEqual(level2);
        // The shallower regions are untouched: this command adds folds, it
        // never opens one, which is VS Code's behaviour too.
        for (const pos of level1) {
            expect(folded.has(pos)).toBe(false);
        }
    });

    it("folding a level with nothing at it should report false and fold nothing", async () => {
        const v = view(await makeEditor(NESTED));
        expect(run(v, foldToLevel(7))).toBe(false);
        expect(foldedOf(v).size).toBe(0);
    });

    it("folding a level already folded should report false rather than re-dispatch", async () => {
        const v = view(await makeEditor(NESTED));
        expect(run(v, foldToLevel(1))).toBe(true);
        expect(run(v, foldToLevel(1))).toBe(false);
    });

    it("folding level 1 should reach a non-heading foldable at the top level", async () => {
        const v = view(await makeEditor("```js\nconst a = 1;\n```\n\n# One\n\ntext\n"));
        expect(run(v, foldToLevel(1))).toBe(true);
        // Two regions at level 1: the code block and the section. A heading-
        // rank reading of "level" could never have folded the code block.
        expect(foldedOf(v).size).toBe(2);
    });
});

describe("foldSubtreeAt (the Alt+click gesture)", () => {
    it("folding a section recursively should fold it and every nested region", async () => {
        const v = view(await makeEditor(NESTED));
        const [outer] = foldablesAtLevel(v.state.doc, 1);
        expect(foldSubtreeAt(v.state, v.dispatch.bind(v), outer!, true)).toBe(true);
        const folded = foldedOf(v);
        // h1 + its h2 + that h2's h3 = 3, and NOT the sibling section.
        expect(folded.size).toBe(3);
        const siblings = foldablesAtLevel(v.state.doc, 1);
        expect(folded.has(siblings[1]!)).toBe(false);
    });

    it("unfolding recursively should open the whole subtree in one gesture", async () => {
        const v = view(await makeEditor(NESTED));
        const [outer] = foldablesAtLevel(v.state.doc, 1);
        foldSubtreeAt(v.state, v.dispatch.bind(v), outer!, true);
        expect(foldedOf(v).size).toBe(3);
        expect(foldSubtreeAt(v.state, v.dispatch.bind(v), outer!, false)).toBe(true);
        expect(foldedOf(v).size).toBe(0);
    });

    it("the whole subtree should follow the clicked region, not each descendant's own state", async () => {
        const v = view(await makeEditor(NESTED));
        const [outer] = foldablesAtLevel(v.state.doc, 1);
        const inner = foldablesAtLevel(v.state.doc, 2);
        // Pre-fold ONE descendant, then recursively fold the outer region.
        foldSubtreeAt(v.state, v.dispatch.bind(v), inner[0]!, true);
        expect(foldedOf(v).has(inner[0]!)).toBe(true);
        foldSubtreeAt(v.state, v.dispatch.bind(v), outer!, true);
        // A per-descendant toggle would have OPENED the pre-folded one. One
        // gesture is one intent: everything ends up folded.
        expect(foldedOf(v).size).toBe(3);
    });

    it("a position that folds nothing should report false", async () => {
        const v = view(await makeEditor("plain paragraph\n"));
        expect(foldSubtreeAt(v.state, v.dispatch.bind(v), 0, true)).toBe(false);
    });
});

describe("the folds these produce persist like any other", () => {
    it("a level fold should survive an anchors round trip", async () => {
        const v = view(await makeEditor(NESTED));
        run(v, foldToLevel(1));
        const before = foldedOf(v);
        expect(before.size).toBe(2);
        // The persistence seam: positions out to anchors, anchors back to
        // positions. A fold producer that skipped it would drop on reopen.
        const anchors = computeFoldAnchors(v.state.doc, before);
        const restored = resolveFoldAnchors(v.state.doc, anchors);
        expect(new Set(restored)).toEqual(before);
    });

    it("a recursive fold should survive an anchors round trip", async () => {
        const v = view(await makeEditor(NESTED));
        const [outer] = foldablesAtLevel(v.state.doc, 1);
        foldSubtreeAt(v.state, v.dispatch.bind(v), outer!, true);
        const before = foldedOf(v);
        expect(before.size).toBe(3);
        const restored = resolveFoldAnchors(
            v.state.doc,
            computeFoldAnchors(v.state.doc, before),
        );
        expect(new Set(restored)).toEqual(before);
    });
});
