/**
 * An inline source-carrying node's CONTENT never inherits the ambient mark.
 *
 * `math_inline` and `wiki_link` both hold their raw source as text content with
 * `marks: ""` (plugins/math.ts, plugins/wikiLinks.ts). Milkdown's parser keeps
 * one ambient mark set across `openNode`, so a node built with `addText` while
 * `strong` is open gets marked content, and `marks: ""` makes that document fail
 * `doc.check()`. Both runners therefore build their text node directly.
 *
 * This is a whole-class gate rather than two spot checks, because the class is
 * what the bug belongs to: any future inline node storing source as content
 * inherits the same trap. Found in MAR-74 — `**$a^2$**` shipped broken and no
 * fixture wrapped an inline atom in a mark, so nothing caught it.
 *
 * Drives the REAL Milkdown editor with the production serialization config.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";

/**
 * Every inline node that stores its source as text content under `marks: ""`,
 * with the syntax that builds one. Adding such a node without adding a row here
 * is the gap this table exists to close; the count assertion below is what makes
 * a shrunken table visible instead of silently passing.
 */
const SOURCE_CONTENT_NODES: ReadonlyArray<{ node: string; inline: string }> = [
    { node: "math_inline", inline: "$a^2$" },
    { node: "wiki_link", inline: "[[page]]" },
];

/** Marks that can wrap an inline node, spelled as their markdown delimiters. */
const WRAPPERS: ReadonlyArray<{ mark: string; wrap: (s: string) => string }> = [
    { mark: "strong", wrap: (s) => `**${s}**` },
    { mark: "emphasis", wrap: (s) => `_${s}_` },
    { mark: "strikethrough", wrap: (s) => `~~${s}~~` },
];

async function make(markdown: string) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, container);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    return { editor, view };
}

describe("inline source-carrying nodes wrapped in a mark", () => {
    it("the enumeration should cover every source-content node and wrapper", () => {
        // A sweep that reached nothing passes; assert its own size (MAR-141).
        expect(SOURCE_CONTENT_NODES.map((n) => n.node).sort()).toEqual([
            "math_inline",
            "wiki_link",
        ]);
        expect(WRAPPERS.length).toBe(3);
    });

    for (const { node, inline } of SOURCE_CONTENT_NODES) {
        for (const { mark, wrap } of WRAPPERS) {
            it(`a ${mark}-wrapped ${node} should build a valid document and round-trip`, async () => {
                // Arrange
                const source = `Alpha ${wrap(inline)} beta.\n`;

                // Act
                const { editor, view } = await make(source);

                // Assert — the content is what breaks: an ambient mark on the
                // node's inner text is invalid against its `marks: ""`.
                expect(() => view.state.doc.check()).not.toThrow();
                expect(editor.action(getMarkdown())).toBe(source);
                await editor.destroy();
            });
        }
    }
});
