import { describe, it, expect } from "vitest";
import { blockPlainText } from "../plugins/proofread";
import { INLINE_PLACEHOLDER } from "../../shared/proofreadFilter";

/** Minimal structural stand-in for a ProseMirror textblock node. */
type FakeChild = {
    isText: boolean;
    text?: string;
    nodeSize: number;
    marks: Array<{ type: { name: string } }>;
};

function textChild(text: string, markNames: string[] = []): FakeChild {
    return {
        isText: true,
        text,
        nodeSize: text.length,
        marks: markNames.map((name) => ({ type: { name } })),
    };
}

function leafChild(nodeSize = 1): FakeChild {
    return { isText: false, nodeSize, marks: [] };
}

function fakeBlock(children: FakeChild[]) {
    return {
        forEach(cb: (child: FakeChild) => void) {
            children.forEach(cb);
        },
    } as unknown as Parameters<typeof blockPlainText>[0];
}

describe("blockPlainText", () => {
    it("plain text children should be concatenated verbatim", () => {
        const block = fakeBlock([textChild("Hello "), textChild("world")]);

        expect(blockPlainText(block)).toBe("Hello world");
    });

    it("inline-code text should be masked with spaces of equal length", () => {
        const block = fakeBlock([
            textChild("run "),
            textChild("pnpm", ["inlineCode"]),
            textChild(" now"),
        ]);

        const text = blockPlainText(block);

        expect(text).toBe("run      now");
        expect(text.length).toBe("run pnpm now".length);
    });

    it("a non-text inline node should become placeholder chars matching its nodeSize", () => {
        const block = fakeBlock([textChild("see "), leafChild(1), textChild(" here")]);

        const text = blockPlainText(block);

        expect(text).toBe(`see ${INLINE_PLACEHOLDER} here`);
        // Total length must equal the block's content size so offsets map to doc positions
        expect(text.length).toBe(4 + 1 + 5);
    });

    it("emphasized (non-code) marks should keep their text checkable", () => {
        const block = fakeBlock([textChild("very", ["em", "strong"]), textChild(" nice")]);

        expect(blockPlainText(block)).toBe("very nice");
    });
});
