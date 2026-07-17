import { describe, it, expect } from "vitest";
import { Schema } from "../pm";
import { computeDecorations, DEFAULT_CONFIG } from "../plugins/proofread";
import { ignoreStyleSession, isStyleSuppressed } from "../proofread/engine";
import type { ProofreadConfig } from "../../shared/messages";

/**
 * Style-check session ignore: clicking "Ignore" on a style finding suppresses
 * that category+text for the session (mirroring the Harper lint ignore).
 * Vitest isolates module state per file, so the engine's `styleIgnores` set
 * starts empty here and mutations don't leak into the other proofread specs.
 */

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        text: { group: "inline" },
    },
});

const CONFIG: ProofreadConfig = {
    ...DEFAULT_CONFIG,
    spellCheck: false,
    grammarCheck: false,
};

function decoratedTexts(text: string): string[] {
    const doc = schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text(text)]),
    ]);
    return computeDecorations(doc, CONFIG).find().map((d) => doc.textBetween(d.from, d.to));
}

describe("ignoreStyleSession / isStyleSuppressed", () => {
    it("a category+text should read as suppressed only after it is ignored", () => {
        expect(isStyleSuppressed("fillers", "really")).toBe(false);
        ignoreStyleSession("fillers", "really");
        expect(isStyleSuppressed("fillers", "really")).toBe(true);
    });

    it("the ignore should be case-insensitive on the flagged text", () => {
        ignoreStyleSession("fillers", "Basically");
        expect(isStyleSuppressed("fillers", "basically")).toBe(true);
    });

    it("a different category with the same text should not be suppressed", () => {
        ignoreStyleSession("fillers", "clean");
        expect(isStyleSuppressed("redundancies", "clean")).toBe(false);
    });
});

describe("computeDecorations honours a style ignore", () => {
    it("an ignored filler should drop out of the decorations", () => {
        expect(decoratedTexts("This is actually good.")).toEqual(["actually"]);
        ignoreStyleSession("fillers", "actually");
        expect(decoratedTexts("This is actually good.")).toEqual([]);
    });
});
