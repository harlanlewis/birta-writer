/**
 * Inline-math in-place editing (MAR-74) against a REAL editor: the LaTeX source
 * is the node's text content, the caret can sit inside it, reveal is a pure
 * decoration (never a doc change), an emptied formula is deleted when the caret
 * leaves, and — the existential bit — the content model round-trips
 * byte-identically through the save pipeline.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { mathInlineEditPlugin, mathAroundSelection, revealDecorations } from "../plugins/mathInlineEdit";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";
import { runEditorCommand } from "../editorCommands";
import { computeToolbarActiveState } from "../components/toolbar/activeState";

let editors: Editor[] = [];

async function makeEditor(md: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, md);
            configureSerialization(ctx);
        })
        .use(mathInlineEditPlugin)
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    editors.push(editor);
    return editor;
}

const view = (editor: Editor): EditorView =>
    editor.action((ctx) => ctx.get(editorViewCtx));

/** Position of the first math_inline node, or -1. */
function mathPos(v: EditorView): number {
    let pos = -1;
    v.state.doc.descendants((n, p) => {
        if (pos < 0 && n.type.name === "math_inline") { pos = p; }
    });
    return pos;
}

/** Put the caret at an absolute doc position. */
function caretAt(v: EditorView, pos: number): void {
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos)));
}

afterEach(async () => {
    for (const editor of editors) { await editor.destroy(); }
    editors = [];
    document.body.innerHTML = "";
});

describe("math_inline content model", () => {
    it("a loaded formula should hold its LaTeX as text content", async () => {
        const editor = await makeEditor("Inline $E = mc^2$ here.");
        const v = view(editor);
        const pos = mathPos(v);
        expect(pos).toBeGreaterThan(-1);
        const node = v.state.doc.nodeAt(pos)!;
        expect(node.textContent).toBe("E = mc^2");
        expect(node.isAtom).toBe(false);
    });

    it("a formula should round-trip byte-identically through the save pipeline", async () => {
        const src = "Inline $E = mc^2$ here, and $a_1 + b_2$ too.\n";
        const editor = await makeEditor(src);
        const serialized = editor.action(getMarkdown());
        const protection = computeRoundTripProtection(src, serialized);
        expect(applyMinimalChanges(src, serialized, protection)).toBe(src);
    });

    it("editing the source text should serialize the edited formula", async () => {
        const editor = await makeEditor("Inline $a+b$ here.");
        const v = view(editor);
        const pos = mathPos(v);
        // Insert into the source: after "a" (pos+1 is inside-start).
        v.dispatch(v.state.tr.insertText("^2", pos + 2, pos + 2));
        expect(editor.action(getMarkdown())).toContain("$a^2+b$");
    });
});

describe("reveal decorations (pure selection state)", () => {
    it("a caret inside the source should decorate exactly that node as editing", async () => {
        const editor = await makeEditor("x $a+b$ y");
        const v = view(editor);
        const pos = mathPos(v);
        caretAt(v, pos + 1);
        const range = mathAroundSelection(v.state);
        expect(range).toEqual({ pos, end: pos + v.state.doc.nodeAt(pos)!.nodeSize });
        const decos = revealDecorations(v.state).find();
        expect(decos).toHaveLength(1);
        expect(decos[0]!.from).toBe(pos);
    });

    it("a caret outside any formula should produce no reveal decoration", async () => {
        const editor = await makeEditor("x $a+b$ y");
        const v = view(editor);
        caretAt(v, 1);
        expect(mathAroundSelection(v.state)).toBeNull();
        expect(revealDecorations(v.state).find()).toHaveLength(0);
    });

    it("moving the caret through a formula should never change the document", async () => {
        const src = "x $a+b$ y\n";
        const editor = await makeEditor(src);
        const v = view(editor);
        const before = editor.action(getMarkdown());
        const pos = mathPos(v);
        // Walk positions across and inside the node.
        for (const p of [1, pos, pos + 1, pos + 3, pos + 5, pos + 7]) {
            caretAt(v, Math.min(p, v.state.doc.content.size - 1));
        }
        expect(editor.action(getMarkdown())).toBe(before);
    });
});

describe("Shift+Arrow selection stepping across a formula", () => {
    // Native shift-extension treats the hidden source as one opaque unit; the
    // plugin steps the head one POSITION at a time through the node instead.
    function pressShiftArrow(v: EditorView, key: "ArrowLeft" | "ArrowRight"): boolean {
        const event = new KeyboardEvent("keydown", { key, shiftKey: true });
        return v.someProp("handleKeyDown", (f) => f(v, event)) ?? false;
    }

    it("extending right across a formula should grow the head by one position per press", async () => {
        const editor = await makeEditor("x $abc$ y");
        const v = view(editor);
        const pos = mathPos(v);
        // Anchor just before the node.
        caretAt(v, pos);
        const heads: number[] = [];
        for (let i = 0; i < 5; i++) {
            expect(pressShiftArrow(v, "ArrowRight")).toBe(true);
            heads.push(v.state.selection.head);
        }
        // Into the node, then a/b/c, then out: strictly +1 each press.
        expect(heads).toEqual([pos + 1, pos + 2, pos + 3, pos + 4, pos + 5]);
        expect(v.state.selection.anchor).toBe(pos); // anchor never moves
    });

    it("a shift-press far from any formula should defer to native handling", async () => {
        const editor = await makeEditor("plain text only");
        const v = view(editor);
        caretAt(v, 3);
        expect(pressShiftArrow(v, "ArrowRight")).toBe(false);
    });
});

describe("toolbar state with the caret inside a formula", () => {
    // Lives here (not toolbarActiveState.test.ts) because a caret INSIDE the
    // source only exists under the content model this plugin introduces.
    it("a caret inside the source should light inlineMath and grey the format control", async () => {
        const editor = await makeEditor("x $a+b$ y");
        const v = view(editor);
        caretAt(v, mathPos(v) + 2);
        const s = computeToolbarActiveState(v.state);
        expect(s.inlineMath).toBe(true);
        expect(s.formatApplicable).toBe(false);
        expect(s.wikiLink).toBe(false);
    });
});

describe("emptied formula cleanup", () => {
    it("deleting all source then leaving the node should remove it", async () => {
        const editor = await makeEditor("x $ab$ y");
        const v = view(editor);
        const pos = mathPos(v);
        // Caret inside, then delete the whole source (node kept while inside).
        caretAt(v, pos + 1);
        v.dispatch(v.state.tr.delete(pos + 1, pos + 3));
        expect(mathPos(v)).toBe(pos); // still there, empty, caret inside
        expect(v.state.doc.nodeAt(pos)!.content.size).toBe(0);
        // Leave the node → appendTransaction removes the empty shell.
        caretAt(v, 1);
        expect(mathPos(v)).toBe(-1);
        expect(editor.action(getMarkdown())).not.toContain("$");
    });

    it("an emptied formula should survive while the caret stays inside", async () => {
        const editor = await makeEditor("x $ab$ y");
        const v = view(editor);
        const pos = mathPos(v);
        caretAt(v, pos + 1);
        v.dispatch(v.state.tr.delete(pos + 1, pos + 3));
        // Retype without leaving — the node is still there to receive it.
        v.dispatch(v.state.tr.insertText("c^2", pos + 1, pos + 1));
        expect(editor.action(getMarkdown())).toContain("$c^2$");
    });
});

describe("insertInlineMathCommand (content model)", () => {
    it("wrapping a selection should serialize as $...$ and place the caret inside", async () => {
        const editor = await makeEditor("energy is E = mc^2 here\n");
        const v = view(editor);
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 11, 19)));
        runEditorCommand("insertMath", () => editor);
        expect(editor.action(getMarkdown())).toContain("$E = mc^2$");
        // Caret inside the source (reveal state), not a NodeSelection.
        expect(view(editor).state.selection.empty).toBe(true);
        expect(mathAroundSelection(view(editor).state)).not.toBeNull();
    });

    it("with the caret inside a formula the command should unwrap it to plain text", async () => {
        const editor = await makeEditor("x $a+b$ y\n");
        const v = view(editor);
        caretAt(v, mathPos(v) + 2);
        runEditorCommand("insertMath", () => editor);
        const out = editor.action(getMarkdown());
        expect(out).toContain("a+b");
        expect(out).not.toContain("$");
        expect(mathPos(view(editor))).toBe(-1);
    });

    it("with an empty selection the command should insert an empty formula with the caret inside", async () => {
        const editor = await makeEditor("hello\n");
        const v = view(editor);
        caretAt(v, 6); // end of "hello"
        runEditorCommand("insertMath", () => editor);
        const pos = mathPos(view(editor));
        expect(pos).toBeGreaterThan(-1);
        // Caret inside the empty node, ready to type (cleanup waits for exit).
        expect(mathAroundSelection(view(editor).state)?.pos).toBe(pos);
    });
});
