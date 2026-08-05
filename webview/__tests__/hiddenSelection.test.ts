/**
 * Tests for the scoped suppression of an invisible selection's native paint
 * (MAR-258): which blocks get the `pm-hidden-selection` decoration, and the
 * standing rule that nothing may key a style rule off the class ProseMirror
 * toggles on the editor ROOT — that toggle re-styles the whole document on
 * every invisible-selection change.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { GapCursor, NodeSelection, TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { BlockRangeSelection } from "../plugins/blockRange";
import { HIDDEN_SELECTION_CLASS, hiddenSelectionDecorations } from "../plugins/hiddenSelection";

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
        .create();
    editors.push(editor);
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

/** The decorated ranges, as `[from, to]` pairs, for the view's current state. */
function decorated(view: EditorView): Array<[number, number]> {
    const set = hiddenSelectionDecorations(view.state);
    return set.find().map((d) => {
        expect((d as unknown as { type: { attrs: { class: string } } }).type.attrs.class)
            .toBe(HIDDEN_SELECTION_CLASS);
        return [d.from, d.to] as [number, number];
    });
}

/** [start, end) of the nth top-level block. */
function blockAt(view: EditorView, index: number): [number, number] {
    let pos = 0;
    for (let i = 0; i < index; i++) {
        pos += view.state.doc.child(i).nodeSize;
    }
    return [pos, pos + view.state.doc.child(index).nodeSize];
}

describe("hiddenSelectionDecorations", () => {
    it("a visible text selection should decorate nothing", async () => {
        const view = await makeEditor("first para\n\nsecond para\n");
        view.dispatch(view.state.tr.setSelection(
            TextSelection.create(view.state.doc, 1, 6),
        ));
        expect(decorated(view)).toEqual([]);
    });

    it("a block range should decorate every top-level block it spans", async () => {
        const view = await makeEditor("first para\n\nsecond para\n\nthird para\n");
        const [from] = blockAt(view, 0);
        const [, to] = blockAt(view, 1);
        view.dispatch(view.state.tr.setSelection(
            BlockRangeSelection.tryCreate(view.state.doc, from, to)!,
        ));
        expect(decorated(view)).toEqual([blockAt(view, 0), blockAt(view, 1)]);
    });

    it("a node selection on a block leaf should decorate that leaf only", async () => {
        const view = await makeEditor("lead para\n\n---\n\ntail para\n");
        const [from] = blockAt(view, 1);
        expect(view.state.doc.child(1).type.name).toBe("hr");
        view.dispatch(view.state.tr.setSelection(
            NodeSelection.create(view.state.doc, from),
        ));
        expect(decorated(view)).toEqual([blockAt(view, 1)]);
    });

    it("a node selection on an inline node should decorate its containing block", async () => {
        const view = await makeEditor("lead para\n\n![alt](img.png)\n\ntail para\n");
        const [blockFrom] = blockAt(view, 1);
        view.dispatch(view.state.tr.setSelection(
            NodeSelection.create(view.state.doc, blockFrom + 1),
        ));
        expect(decorated(view)).toEqual([blockAt(view, 1)]);
    });

    it("a gap cursor between two top-level blocks should decorate nothing", async () => {
        // The static root rule covers it: the DOM selection is collapsed
        // directly in the editor root, which no node decoration can reach.
        const view = await makeEditor("---\n\n---\n");
        const [, gap] = blockAt(view, 0);
        view.dispatch(view.state.tr.setSelection(
            new GapCursor(view.state.doc.resolve(gap)),
        ));
        expect(view.state.selection.visible).toBe(false);
        expect(decorated(view)).toEqual([]);
    });

    it("a gap cursor inside a container should decorate the container's top-level block", async () => {
        const view = await makeEditor("> ---\n>\n> quoted\n");
        expect(view.state.doc.child(0).type.name).toBe("blockquote");
        view.dispatch(view.state.tr.setSelection(
            new GapCursor(view.state.doc.resolve(1)),
        ));
        expect(decorated(view)).toEqual([blockAt(view, 0)]);
    });
});

describe("the suppression rules in style.css", () => {
    const css = readFileSync(join(__dirname, "..", "style.css"), "utf8");

    it("no rule should key off the class ProseMirror toggles on the editor root", () => {
        // Comments stripped: the header above the rules names the class to say
        // never to use it, which is the opposite of a violation.
        const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
        expect(rules).not.toContain("ProseMirror-hideselection");
    });

    it("the scoped rules should use the class the plugin decorates with", () => {
        expect(css).toContain(`.milkdown .editor .${HIDDEN_SELECTION_CLASS}::selection`);
        expect(css).toContain(`.milkdown .editor .${HIDDEN_SELECTION_CLASS} ::selection`);
        expect(css).toMatch(
            new RegExp(`\\.milkdown \\.editor \\.${HIDDEN_SELECTION_CLASS} \\{\\s*caret-color: transparent;`),
        );
    });

    it("the root caret suppression should be static, and restored on every child", () => {
        // Both halves matter: without the first a gap cursor blinks a second,
        // native caret next to its widget; without the second the caret is
        // invisible everywhere the user actually types.
        expect(css).toMatch(/\.milkdown \.editor \{\s*caret-color: transparent;\s*\}/);
        expect(css).toMatch(/\.milkdown \.editor > \* \{\s*caret-color: auto;\s*\}/);
    });
});
