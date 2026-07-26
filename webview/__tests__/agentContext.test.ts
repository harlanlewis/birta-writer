/**
 * buildSelectionContext (webview/agentContext.ts): mapping the live ProseMirror
 * selection into the canonical document-coordinate context the agent bridge
 * carries. The position mapping itself is covered by sourceCaret.test.ts; here
 * we pin the context shape, the frontmatter line offset, and the caret/range
 * distinction.
 */
import { describe, it, expect } from "vitest";
import { Schema } from "../pm";
import type { Node } from "../pm";
import { computeLineMap } from "../../shared/lineMap";
import { buildSelectionContext } from "../agentContext";

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
        text: { group: "inline" },
    },
    marks: {},
});

const p = (t: string) => schema.node("paragraph", null, t ? [schema.text(t)] : []);
const doc = (...blocks: Node[]) => schema.node("doc", null, blocks);

/** Caret `offset` chars into the `index`-th top-level block's text. */
const inBlock = (d: Node, index: number, offset: number): number => {
    let pos = 0;
    for (let i = 0; i < index; i++) { pos += d.child(i).nodeSize; }
    return pos + 1 + offset;
};

/** A minimal EditorView stand-in: buildSelectionContext only reads state.doc/selection. */
const view = (d: Node, anchor: number, head: number) => {
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);
    return {
        state: { doc: d, selection: { anchor, head, from, to, empty: from === to } },
    } as unknown as Parameters<typeof buildSelectionContext>[0];
};

describe("buildSelectionContext", () => {
    it("a caret mid-paragraph should produce a single empty selection at that line/column", () => {
        const source = "First paragraph.\n\nSecond paragraph.\n";
        const d = doc(p("First paragraph."), p("Second paragraph."));
        const pos = inBlock(d, 1, 7);
        const ctx = buildSelectionContext(view(d, pos, pos), computeLineMap(source), source.split("\n"), 0);
        expect(ctx).toEqual({
            selections: [
                {
                    anchor: { line: 3, column: 7 },
                    active: { line: 3, column: 7 },
                    text: "",
                },
            ],
            primary: 0,
            isEmpty: true,
        });
    });

    it("a forward selection should carry anchor, active and the plain selected text", () => {
        const source = "Hello world.\n";
        const d = doc(p("Hello world."));
        const anchor = inBlock(d, 0, 0);
        const head = inBlock(d, 0, 5); // "Hello"
        const ctx = buildSelectionContext(view(d, anchor, head), computeLineMap(source), source.split("\n"), 0)!;
        expect(ctx.isEmpty).toBe(false);
        expect(ctx.selections[0].anchor).toEqual({ line: 1, column: 0 });
        expect(ctx.selections[0].active).toEqual({ line: 1, column: 5 });
        expect(ctx.selections[0].text).toBe("Hello");
    });

    it("should add the frontmatter line offset to the reported document line", () => {
        const source = "Body line.\n";
        const d = doc(p("Body line."));
        const pos = inBlock(d, 0, 0);
        // 4 frontmatter source lines precede the body.
        const ctx = buildSelectionContext(view(d, pos, pos), computeLineMap(source), source.split("\n"), 4)!;
        expect(ctx.selections[0].anchor.line).toBe(5);
    });

    it("should return null when the line map is empty (pre-first-sync)", () => {
        const d = doc(p("x"));
        expect(buildSelectionContext(view(d, 1, 1), [], [], 0)).toBeNull();
    });
});
