/**
 * MAR-215 — the gutter chrome's scroll window.
 *
 * The block gutter / drag-handle chrome is a per-block decoration, so on a
 * large document the fold plugin's set held thousands of decorations that
 * ProseMirror had to position-map on every keystroke and diff against the DOM
 * on every redraw. The decoration pass now materializes only the blocks near
 * the viewport (plugins/visibleRange.ts measures it), which is safe only if
 * three things hold, and this file pins all three:
 *
 *   1. an out-of-window block gets NO gutter chrome (the win);
 *   2. a COLLAPSED block keeps its `collapsed` class and its hidden content
 *      stays hidden wherever it sits — fold state is document-wide, only the
 *      affordance is windowed (an expanded off-screen callout would change
 *      the document's scroll height);
 *   3. the structural fingerprint summarizes exactly the blocks the build
 *      materializes, so the plugin's map-instead-of-rebuild fast path can
 *      never disagree with what is rendered.
 *
 * Driven through the REAL Milkdown editor (real parser, real schema) like
 * foldPlugin.test.ts, so position math matches production.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection } from "../pm";
import type { EditorView, Node as ProseNode } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { foldPluginKey, headingFoldPlugin, type FoldMeta } from "../plugins/headingFold";
import {
    buildHeadingFoldDecorations,
    structureFingerprint,
} from "../plugins/headingFold/foldDecorations";
import { computeFoldRanges } from "../plugins/headingFold/foldModel";

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

const view = (editor: Editor): EditorView => editor.action((ctx) => ctx.get(editorViewCtx));

afterEach(() => {
    editors.forEach((editor) => editor.destroy());
    editors = [];
    document.body.innerHTML = "";
});

/** Every decoration the pass emits for `doc`, as plain `{from,to,spec}` rows. */
function decorationsOf(
    doc: ProseNode,
    folded: ReadonlySet<number>,
    windows: readonly { from: number; to: number }[] | null,
): { from: number; to: number; classes: string; widget: boolean }[] {
    return buildHeadingFoldDecorations(doc, folded, true, windows)
        .find()
        .map((d: any) => ({
            from: d.from,
            to: d.to,
            classes: String(d.type?.attrs?.class ?? ""),
            widget: typeof d.type?.toDOM === "function" || d.spec?.key !== undefined,
        }));
}

/** The top-level position of the Nth top-level block. */
function blockPos(doc: ProseNode, index: number): number {
    let pos = -1;
    let i = 0;
    doc.forEach((_node: ProseNode, offset: number) => {
        if (i++ === index) { pos = offset; }
    });
    return pos;
}

/** The document position of the first node of the given type at any depth. */
function deepPosOf(v: EditorView, typeName: string): number {
    let found = -1;
    v.state.doc.descendants((node: ProseNode, pos: number) => {
        if (found === -1 && node.type.name === typeName) { found = pos; }
        return found === -1;
    });
    return found;
}

const PARAGRAPHS = Array.from({ length: 12 }, (_, i) => `Paragraph number ${i}.`).join("\n\n");

describe("MAR-215 windowed gutter chrome", () => {
    it("a null window should materialize the whole document, exactly as before", async () => {
        const editor = await makeEditor(PARAGRAPHS);
        const doc = view(editor).state.doc;

        const all = decorationsOf(doc, new Set(), null);

        // Two decorations per paragraph: the host class + the gutter widget.
        expect(all.length).toBe(doc.childCount * 2);
    });

    it("a block outside the window should get no gutter chrome", async () => {
        const editor = await makeEditor(PARAGRAPHS);
        const doc = view(editor).state.doc;
        const third = blockPos(doc, 2);
        const fourth = blockPos(doc, 3);

        // A window covering exactly the third paragraph.
        const windowed = decorationsOf(doc, new Set(), [{ from: third, to: fourth }]);

        expect(windowed.length).toBe(2);
        expect(windowed.every((d) => d.from >= third && d.to <= fourth)).toBe(true);
    });

    it("two windows should each materialize, so the caret's block survives off screen", async () => {
        const editor = await makeEditor(PARAGRAPHS);
        const doc = view(editor).state.doc;
        const first = blockPos(doc, 0);
        const second = blockPos(doc, 1);
        const last = blockPos(doc, doc.childCount - 1);

        const windowed = decorationsOf(doc, new Set(), [
            { from: first, to: second },
            { from: last, to: doc.content.size },
        ]);

        expect(windowed.length).toBe(4);
        expect(windowed.some((d) => d.from === last)).toBe(true);
    });

    it("a collapsed callout outside the window should keep its collapsed class", async () => {
        const editor = await makeEditor(
            `${PARAGRAPHS}\n\n> [!note] Heads up\n> Body line that the fold hides.\n`,
        );
        const v = view(editor);
        const calloutPos = deepPosOf(v, "callout");
        expect(calloutPos).toBeGreaterThan(-1);

        // Window over the FIRST paragraph only — the callout is far outside it.
        const doc = v.state.doc;
        const windowed = decorationsOf(doc, new Set([calloutPos]), [
            { from: blockPos(doc, 0), to: blockPos(doc, 1) },
        ]);

        const host = windowed.find((d) => d.from === calloutPos && d.classes.includes("block-gutter-host"));
        expect(host).toBeDefined();
        expect(host!.classes).toContain("collapsed");
    });

    it("a collapsed heading outside the window should still hide its section", async () => {
        const editor = await makeEditor(
            `${PARAGRAPHS}\n\n## Section\n\nHidden body paragraph.\n\nAnother hidden one.\n`,
        );
        const v = view(editor);
        const doc = v.state.doc;
        let headingPos = -1;
        doc.forEach((node: ProseNode, offset: number) => {
            if (headingPos === -1 && node.type.name === "heading") { headingPos = offset; }
        });
        expect(headingPos).toBeGreaterThan(-1);

        const windowed = decorationsOf(doc, new Set([headingPos]), [
            { from: blockPos(doc, 0), to: blockPos(doc, 1) },
        ]);

        const hidden = windowed.filter((d) => d.classes.includes("heading-fold-hidden"));
        expect(hidden.length).toBe(2);
        expect(hidden.every((d) => d.from > headingPos)).toBe(true);
    });

    it("the fingerprint should summarize exactly the blocks the build materializes", async () => {
        const editor = await makeEditor(PARAGRAPHS);
        const doc = view(editor).state.doc;
        const ranges = computeFoldRanges(doc);
        const head = [{ from: blockPos(doc, 0), to: blockPos(doc, 2) }];
        const tail = [{ from: blockPos(doc, 8), to: doc.content.size }];

        const headPrint = structureFingerprint(doc, new Set(), ranges, true, head);
        const tailPrint = structureFingerprint(doc, new Set(), ranges, true, tail);
        const wholePrint = structureFingerprint(doc, new Set(), ranges, true, null);

        // Two blocks in the window → two entries plus the enabled flag.
        expect(headPrint.split("|").length).toBe(3);
        expect(headPrint).not.toBe(wholePrint);
        // Same shape, different slice: the fingerprint must not confuse them,
        // or a window move would silently reuse the previous decorations.
        expect(headPrint).not.toBe(tailPrint);
    });
});

describe("MAR-215 window plumbing through the plugin", () => {
    const setWindow = (v: EditorView, window: { from: number; to: number } | null): void => {
        v.dispatch(
            v.state.tr
                .setMeta(foldPluginKey, { type: "window", window } satisfies FoldMeta)
                .setMeta("addToHistory", false),
        );
    };

    it("with no layout engine the plugin should keep a null window (whole document)", async () => {
        const editor = await makeEditor(PARAGRAPHS);
        const v = view(editor);
        // jsdom reports a zero-size rect, so the observer never commits a
        // window — the pre-windowing behavior every other suite asserts.
        expect(foldPluginKey.getState(v.state)!.window).toBeNull();
        expect(foldPluginKey.getState(v.state)!.decorations.find().length)
            .toBe(v.state.doc.childCount * 2);
    });

    it("a window meta should narrow the decorations to that range", async () => {
        const editor = await makeEditor(PARAGRAPHS);
        const v = view(editor);
        const doc = v.state.doc;

        setWindow(v, { from: blockPos(doc, 0), to: blockPos(doc, 2) });

        expect(foldPluginKey.getState(v.state)!.decorations.find().length).toBe(4);
    });

    it("a caret outside the window should pin its own block into the build", async () => {
        const editor = await makeEditor(PARAGRAPHS);
        const v = view(editor);
        const doc = v.state.doc;
        setWindow(v, { from: blockPos(doc, 0), to: blockPos(doc, 2) });
        expect(foldPluginKey.getState(v.state)!.pinned).toBeNull();

        const farBlock = blockPos(v.state.doc, 9);
        v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(farBlock + 1))));

        const st = foldPluginKey.getState(v.state)!;
        expect(st.pinned).not.toBeNull();
        // The two window blocks plus the caret's own block.
        expect(st.decorations.find().length).toBe(6);
        expect(st.decorations.find().some((d: any) => d.from === farBlock)).toBe(true);
    });

    it("moving the caret back inside the window should drop the pin", async () => {
        const editor = await makeEditor(PARAGRAPHS);
        const v = view(editor);
        const doc = v.state.doc;
        setWindow(v, { from: blockPos(doc, 0), to: blockPos(doc, 2) });
        v.dispatch(v.state.tr.setSelection(
            TextSelection.near(v.state.doc.resolve(blockPos(v.state.doc, 9) + 1)),
        ));
        expect(foldPluginKey.getState(v.state)!.pinned).not.toBeNull();

        v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(1))));

        expect(foldPluginKey.getState(v.state)!.pinned).toBeNull();
        expect(foldPluginKey.getState(v.state)!.decorations.find().length).toBe(4);
    });

    it("an edit above the window should carry the window with its content", async () => {
        const editor = await makeEditor(PARAGRAPHS);
        const v = view(editor);
        const doc = v.state.doc;
        const from = blockPos(doc, 4);
        const to = blockPos(doc, 6);
        setWindow(v, { from, to });

        // Insert text in the FIRST paragraph — everything below shifts.
        v.dispatch(v.state.tr.insertText("xyz", 1));

        const st = foldPluginKey.getState(v.state)!;
        expect(st.window).toEqual({ from: from + 3, to: to + 3 });
        // The two windowed blocks still carry their chrome at their SHIFTED
        // positions — the window travelled with the content, rather than
        // staying at raw offsets and sliding onto the blocks above.
        const positions = st.decorations.find().map((d: any) => d.from);
        expect(positions).toContain(from + 3);
        expect(positions).toContain(blockPos(v.state.doc, 5));
        // Plus the caret's own block: the edit left the selection in the first
        // paragraph, which the window does not cover, so it is pinned in.
        expect(st.pinned).toEqual({ from: 0, to: blockPos(v.state.doc, 1) });
        expect(st.decorations.find().length).toBe(6);
    });
});
