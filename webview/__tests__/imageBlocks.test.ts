/**
 * The img-block decoration (plugins/imageBlocks.ts): TOP-LEVEL image-only
 * paragraphs get the class that centers standalone images and scopes the
 * per-block width breakout. Built against a REAL Milkdown document so the
 * paragraph/image shapes are the genuine parse results.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getMarkdown } from "@milkdown/utils";
import { editorViewCtx } from "@milkdown/core";
import type { EditorState } from "../pm";
import { makeCorpusEditor, editorView } from "./helpers/moveFuzz";
import { computeImageBlockDecorations } from "../plugins/imageBlocks";

afterEach(() => {
    document.body.innerHTML = "";
});

async function stateFor(markdown: string): Promise<EditorState> {
    const editor = await makeCorpusEditor(markdown);
    return editorView(editor).state;
}

function classesOf(state: EditorState): string[] {
    return computeImageBlockDecorations(state)
        .find()
        .map((d) => (d as unknown as { type: { attrs: { class: string } } }).type.attrs.class);
}

describe("computeImageBlockDecorations", () => {
    it("a standalone image paragraph should get the img-block class", async () => {
        const state = await stateFor("before\n\n![alt](a.png)\n\nafter");
        expect(classesOf(state)).toEqual(["img-block"]);
    });

    it("an image mixed with prose should NOT be marked (the :has() gap this plugin exists for)", async () => {
        const state = await stateFor("some text ![alt](a.png) more text");
        expect(classesOf(state)).toEqual([]);
    });

    it("plain paragraphs and other blocks should produce nothing", async () => {
        const state = await stateFor("# h\n\nplain\n\n```\ncode\n```");
        expect(classesOf(state)).toEqual([]);
    });

    it("a nested image (list item) should NOT be marked — breakout is top-level only", async () => {
        const state = await stateFor("- ![alt](a.png)");
        expect(classesOf(state)).toEqual([]);
    });

    it("multiple standalone images should each be marked", async () => {
        const state = await stateFor("![a](a.png)\n\n![b](b.png)");
        expect(classesOf(state)).toEqual(["img-block", "img-block"]);
    });

    it("a rendered raw-HTML block should be marked html-block (block rhythm)", async () => {
        const state = await stateFor('<p align="center"><strong>Centered</strong></p>\n\nplain');
        expect(classesOf(state)).toEqual(["html-block"]);
    });

    it("HTML mixed with prose should NOT be marked", async () => {
        const state = await stateFor("some text <em>inline</em> more");
        expect(classesOf(state)).toEqual([]);
    });

    it("the decoration must never touch the document (round-trip proof)", async () => {
        const source = "![alt](a.png)\n";
        const editor = await makeCorpusEditor(source);
        const state = editor.action((ctx) => ctx.get(editorViewCtx)).state;
        computeImageBlockDecorations(state);
        expect(editor.action(getMarkdown())).toBe(source);
    });
});
