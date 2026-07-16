/**
 * Image attr coercion (plugins/image.ts): a title-less / alt-less image must
 * parse into a node that passes its own schema validation. mdast types
 * alt/title as `string | null`; the stock Milkdown runner forwarded the null
 * into attrs declared `validate: "string"`, so `doc.check()` threw on any
 * document containing `![alt](src)` — found by the corpus move-sampling gate
 * the moment a fixture (tools/quarto.md) contained one.
 */
import { describe, it, expect } from "vitest";
import { makeCorpusEditor, editorView } from "./helpers/moveFuzz";

describe("image attrs — mdast nulls coerce to schema-valid strings", () => {
    it("a title-less and an alt-less image should parse with doc.check()-valid attrs", async () => {
        const editor = await makeCorpusEditor("![Surus](surus.png)\n\n![](hanno.png)\n");
        const view = editorView(editor);

        // The validation the move gate runs after every sampled move.
        expect(() => view.state.doc.check()).not.toThrow();

        const images: { alt: unknown; title: unknown }[] = [];
        view.state.doc.descendants((node) => {
            if (node.type.name === "image") {
                images.push({ alt: node.attrs["alt"], title: node.attrs["title"] });
            }
        });
        expect(images).toEqual([
            { alt: "Surus", title: "" },
            { alt: "", title: "" },
        ]);
        await editor.destroy();
    });
});
