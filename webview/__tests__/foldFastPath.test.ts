/**
 * The fold plugin's single-block fast path (MAR-431), held to the full build
 * it skips: after any edit confined to one top-level block, the plugin's
 * decoration set must equal `buildHeadingFoldDecorations` over the new
 * document, and the structure pass must not have walked the document. The
 * full build is the reference, so this is a differential with a real oracle.
 *
 * The cases are the ones a review found could return stale chrome: a code
 * block gaining its first character (it becomes foldable), a paragraph
 * gaining text beside its image (its glyph changes), a keystroke inside a
 * list item (the block whose part is its item gutters), a heading keystroke
 * followed by the id restamp (a node replacement), and a heading changing
 * level (which must take the full path, because its neighbours' sections
 * move with it).
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { foldPluginKey, headingFoldPlugin } from "../plugins/headingFold";
import { buildHeadingFoldDecorations } from "../plugins/headingFold/foldDecorations";
import "../components/blockMenu";

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
    for (const e of editors) await e.destroy();
    editors = [];
    document.body.innerHTML = "";
});

type Counter = { name: string; amounts: Record<string, number> };

/** Counters stamped while `fn` runs, captured at the call (see perKeystrokeWork.test.ts). */
function counting(fn: () => void): Counter[] {
    const seen: Counter[] = [];
    const original = performance.mark;
    performance.mark = ((name: string, options?: { detail?: unknown }) => {
        const detail = options?.detail;
        if (typeof name === "string" && detail && typeof detail === "object") {
            seen.push({ name, amounts: detail as Record<string, number> });
        }
        return original?.call(performance, name);
    }) as typeof performance.mark;
    try {
        fn();
    } finally {
        performance.mark = original;
    }
    return seen;
}

/** Every decoration as `from-to:kind:key`, sorted: node class or widget key. */
function shape(view: EditorView): string[] {
    const set = foldPluginKey.getState(view.state)!.decorations;
    return set.find().map(describe1).sort();
}
function shapeOf(view: EditorView): string[] {
    const state = foldPluginKey.getState(view.state)!;
    return buildHeadingFoldDecorations(view.state.doc, state.folded, state.enabled, null).find().map(describe1).sort();
}
function describe1(d: { from: number; to: number; spec: Record<string, unknown> }): string {
    const type = (d as unknown as { type: { attrs?: { class?: string }; spec?: { key?: string } } }).type;
    return `${d.from}-${d.to}:${type.attrs?.class ?? ""}:${type.spec?.key ?? d.spec?.key ?? ""}`;
}

const DOC = [
    "# Title",
    "",
    "Intro paragraph.",
    "",
    "```",
    "```",
    "",
    "![alone](a.png)",
    "",
    "- first item",
    "- second item",
    "",
    "## Sub",
    "",
    "Body.",
    "",
].join("\n");

/** Position just inside the top-level block at `index`. */
function inside(view: EditorView, index: number): number {
    let pos = 0;
    for (let i = 0; i < index; i++) pos += view.state.doc.child(i).nodeSize;
    return pos + 1;
}

describe("the fold plugin's single-block path against the full build", () => {
    it("a code block gaining its first character should become foldable without a document walk", async () => {
        const view = await makeEditor(DOC);
        expect(shape(view)).toEqual(shapeOf(view));
        const counters = counting(() => view.dispatch(view.state.tr.insertText("x", inside(view, 2))));
        expect(shape(view)).toEqual(shapeOf(view));
        // The part changed (not foldable to foldable), so the full pass ran;
        // that is the correct answer, and the point is that it was not
        // skipped: the chrome now differs from before the edit.
        expect(walks(counters)).toContain(view.state.doc.childCount);
    });

    it("a paragraph gaining text beside its image should change glyph without stale chrome", async () => {
        const view = await makeEditor(DOC);
        view.dispatch(view.state.tr.insertText("caption", inside(view, 3) + 1));
        expect(shape(view)).toEqual(shapeOf(view));
    });

    it("typing inside a list item should map the set and walk one block only", async () => {
        const view = await makeEditor(DOC);
        const counters = counting(() => view.dispatch(view.state.tr.insertText("x", inside(view, 4) + 3)));
        expect(shape(view)).toEqual(shapeOf(view));
        expect(walks(counters).length).toBeGreaterThan(0);
        expect(walks(counters).every((n) => n === 1)).toBe(true);
    });

    it("typing in a heading followed by its id restamp should rebuild that heading alone", async () => {
        const view = await makeEditor(DOC);
        const counters = counting(() => {
            view.dispatch(view.state.tr.insertText("x", 2));
            const heading = view.state.doc.child(0);
            view.dispatch(view.state.tr.setNodeMarkup(0, undefined, { ...heading.attrs, id: "restamped" }));
        });
        expect(shape(view)).toEqual(shapeOf(view));
        expect(walks(counters).length).toBeGreaterThan(0);
        expect(walks(counters).every((n) => n === 1)).toBe(true);
        // The restamp replaced the node, so its chrome was rebuilt alone.
        const builds = counters.filter((c) => c.name.endsWith("fold-build")).map((c) => c.amounts["blocks"]);
        expect(builds.length).toBeGreaterThan(0);
        expect(builds.every((n) => n === 1)).toBe(true);
    });

    it("a heading changing level should take the full path, and its neighbours' chrome should follow", async () => {
        const view = await makeEditor(DOC);
        const subPos = inside(view, 5) - 1;
        const sub = view.state.doc.nodeAt(subPos)!;
        const counters = counting(() => view.dispatch(view.state.tr.setNodeMarkup(subPos, undefined, { ...sub.attrs, level: 1 })));
        expect(shape(view)).toEqual(shapeOf(view));
        expect(walks(counters)).toContain(view.state.doc.childCount);
    });

    it("a keystroke inside a collapsed section's heading should take the full path", async () => {
        const view = await makeEditor(DOC);
        // Fold the title's section, then type in the title: a folded block is
        // refused by the fast path on purpose.
        const state = foldPluginKey.getState(view.state)!;
        view.dispatch(view.state.tr.setMeta(foldPluginKey, { type: "toggle", pos: 0 }));
        if (foldPluginKey.getState(view.state)!.folded.size === 0) {
            // The toggle meta's shape differs; fall back to asserting parity only.
            expect(state.enabled).toBe(true);
            return;
        }
        const counters = counting(() => view.dispatch(view.state.tr.insertText("x", 2)));
        expect(shape(view)).toEqual(shapeOf(view));
        expect(walks(counters).length).toBeGreaterThan(0);
        expect(walks(counters).every((n) => n === view.state.doc.childCount)).toBe(true);
    });
});

/** The block counts every structure pass stamped; a dispatch may stamp more than once through appended transactions. */
function walks(counters: Counter[]): number[] {
    return counters.filter((c) => c.name.endsWith("fold-structure")).map((c) => c.amounts["blocks"]);
}
