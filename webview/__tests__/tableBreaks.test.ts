/**
 * Line breaks inside table cells (MAR-17).
 *
 * Two ends of the round trip, both driven through the REAL Milkdown editor
 * with the production serialization config — no mocks:
 *
 *  1. A hardbreak inserted into a cell (the Shift+Enter path) must serialize
 *     back to `<br>` rather than the space that mdast-util-to-markdown's
 *     hardBreak handler emits inside a `tableCell` construct. This is the
 *     data-loss reproduction: without the serializer fix the cell becomes
 *     `a b`.
 *  2. Existing `<br>` / `<br/>` / `<br />` spellings already in a cell (and a
 *     lone `<br />` empty cell) must round-trip byte-identically, and a break
 *     outside any table must keep its inert-html behavior.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, pureCommonmark } from "../serialization";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfm)
        .create();
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Doc position right after the first character of the first text node === text. */
function posAfterFirstChar(v: EditorView, text: string): number {
    let found = -1;
    v.state.doc.descendants((node, pos) => {
        if (found >= 0) return false;
        if (node.isText && node.text === text) {
            found = pos + 1;
            return false;
        }
        return true;
    });
    if (found < 0) throw new Error(`text not found in doc: ${text}`);
    return found;
}

describe("table cell line breaks (MAR-17)", () => {
    it("a hardbreak inserted into a cell should serialize as <br>, not a space", async () => {
        // Arrange — a table with a body cell whose text is "ab".
        const source = [
            "| Head | Note |",
            "| --- | --- |",
            "| ab | keep |",
            "| other | row |",
            "",
        ].join("\n");
        const editor = await makeEditor(source);
        const v = view(editor);

        // Act — split "ab" with a real hardbreak node (the Shift+Enter result).
        const hardbreak = v.state.schema.nodes["hardbreak"]!.create();
        v.dispatch(v.state.tr.insert(posAfterFirstChar(v, "ab"), hardbreak));
        const serialized = editor.action(getMarkdown());

        // Assert — the edited cell keeps the break as `<br>` (NOT `a b`), and
        // the untouched rows are byte-stable.
        expect(serialized).toContain("| a<br>b | keep |");
        expect(serialized).not.toContain("| a b | keep |");
        expect(serialized).toContain("| Head | Note |");
        expect(serialized).toContain("| other | row |");
        await editor.destroy();
    });

    it("existing <br> spellings in cells should round-trip byte-identically", async () => {
        // Arrange — every spelling variant plus a lone `<br />` empty cell, in
        // both a header and body cells.
        const source = [
            "| Line a<br>b | Notes |",
            "| --- | --- |",
            "| a<br/>b | slash spelling |",
            "| a<br />b | spaced spelling |",
            "| <br /> | lone break is an empty cell |",
            "",
        ].join("\n");
        const editor = await makeEditor(source);

        // Act — open then save with no edits (invariant A).
        const serialized = editor.action(getMarkdown());
        const protection = computeRoundTripProtection(source, serialized);
        const merged = applyMinimalChanges(source, serialized, protection);

        // Assert — the RAW serializer already preserves each `<br>` spelling
        // verbatim (each degraded to a space before the fix), and the full
        // merge is byte-identical to the source.
        expect(serialized).toContain("Line a<br>b");
        expect(serialized).toContain("a<br/>b");
        expect(serialized).toContain("a<br />b");
        expect(merged).toBe(source);
        await editor.destroy();
    });
});
