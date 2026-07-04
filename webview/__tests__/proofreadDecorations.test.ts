import { describe, it, expect } from "vitest";
import { Schema } from "@milkdown/prose/model";
import { computeDecorations } from "../plugins/proofread";
import type { ProofreadConfig } from "../../shared/messages";

/**
 * End-to-end check of the decoration pipeline against a real ProseMirror
 * document: block traversal, inline-code masking, image placeholders, and
 * the offset→position mapping (blockPos + 1 + offset).
 * Spell check stays off here (the dictionary is lazy-loaded at runtime).
 */

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        code_block: { group: "block", content: "text*", marks: "" },
        text: { group: "inline" },
        image: { group: "inline", inline: true },
    },
    marks: {
        inlineCode: {},
        strong: {},
    },
});

const CONFIG: ProofreadConfig = {
    styleCheck: true,
    fillers: true,
    redundancies: true,
    cliches: true,
    styleExceptions: [],
    spellCheck: false,
    userWords: [],
};

function decoratedTexts(doc: import("@milkdown/prose/model").Node, config = CONFIG): string[] {
    const set = computeDecorations(doc, config);
    return set.find().map((d) => doc.textBetween(d.from, d.to));
}

describe("computeDecorations", () => {
    it("a filler in a paragraph should be decorated at the exact document range", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text("This is really good.")]),
        ]);

        expect(decoratedTexts(doc)).toEqual(["really"]);
    });

    it("offsets in a later paragraph should account for preceding blocks", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text("Clean first paragraph.")]),
            schema.node("paragraph", null, [schema.text("The end result was fine.")]),
        ]);

        expect(decoratedTexts(doc)).toEqual(["end result"]);
    });

    it("a filler inside a code block should not be decorated", () => {
        const doc = schema.node("doc", null, [
            schema.node("code_block", null, [schema.text("really = very + just")]),
        ]);

        expect(decoratedTexts(doc)).toEqual([]);
    });

    it("a filler inside inline code should not be decorated", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [
                schema.text("run "),
                schema.text("really", [schema.mark("inlineCode")]),
                schema.text(" fast"),
            ]),
        ]);

        expect(decoratedTexts(doc)).toEqual([]);
    });

    it("an inline image before a filler should not shift the decorated range", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [
                schema.text("see "),
                schema.node("image"),
                schema.text(" this is really it"),
            ]),
        ]);

        expect(decoratedTexts(doc)).toEqual(["really"]);
    });

    it("a bold (non-code) filler should still be decorated", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [
                schema.text("very", [schema.mark("strong")]),
                schema.text(" nice"),
            ]),
        ]);

        expect(decoratedTexts(doc)).toEqual(["very"]);
    });

    it("style check disabled should produce no decorations", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text("This is really good.")]),
        ]);

        expect(decoratedTexts(doc, { ...CONFIG, styleCheck: false })).toEqual([]);
    });

    it("a repeated word should be decorated even with all phrase categories off", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text("We saw the the dog.")]),
        ]);

        const config = { ...CONFIG, fillers: false, redundancies: false, cliches: false };
        expect(decoratedTexts(doc, config)).toEqual(["the"]);
    });

    it("a phrase in styleExceptions should not be decorated", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text("This is really good.")]),
        ]);

        expect(decoratedTexts(doc, { ...CONFIG, styleExceptions: ["really"] })).toEqual([]);
    });
});
