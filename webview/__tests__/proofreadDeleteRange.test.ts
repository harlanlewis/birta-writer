import { describe, it, expect } from "vitest";
import { Schema } from "../pm";
import { EditorState } from "../pm";
import type { EditorView } from "../pm";
import { deleteRange } from "../plugins/proofread";

/**
 * deleteRange backs the popup's "Remove" action. It must swallow exactly one
 * adjacent space so removing a flagged word never leaves a doubled space —
 * preferring the leading space, falling back to the trailing one, and touching
 * neither when the span abuts punctuation.
 */

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        text: { group: "inline" },
    },
});

/** Remove [from,to] (document positions) via deleteRange and return the text. */
function afterDelete(text: string, from: number, to: number): string {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text(text)])]);
    let state = EditorState.create({ schema, doc });
    const view = { get state() { return state; }, dispatch: (tr: import("../pm").Transaction) => { state = state.apply(tr); } } as unknown as EditorView;
    // Positions map as 1 + offset (paragraph opens at 0).
    deleteRange(view, 1 + from, 1 + to);
    return state.doc.textContent;
}

describe("deleteRange", () => {
    it("a mid-sentence word should take its leading space", () => {
        // "is really good" → remove "really" (offset 3..9) → "is good"
        expect(afterDelete("is really good", 3, 9)).toBe("is good");
    });

    it("a sentence-initial word should fall back to the trailing space", () => {
        // "really good stuff" → remove "really" (offset 0..6) → "good stuff"
        expect(afterDelete("really good stuff", 0, 6)).toBe("good stuff");
    });

    it("a word abutting punctuation should swallow no space", () => {
        // "(really)" → remove "really" (offset 1..7) → "()"
        expect(afterDelete("(really)", 1, 7)).toBe("()");
    });
});
