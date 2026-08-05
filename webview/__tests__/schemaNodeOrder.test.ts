/**
 * `paragraph` must be the default fill for a `block+` content match.
 *
 * ProseMirror resolves `createAndFill` on a `block+` slot by walking the
 * content expression and taking the FIRST node type in the group — which is
 * decided by schema registration order, not by anything declarative. Register
 * a block whose own content is also `block+` (a Notion `<aside>` callout, a
 * directive container) ahead of `paragraph`, and the walk recurses forever
 * filling a container with a container. `notionCallouts.ts` and
 * `serialization.ts` both reason about this in prose; nothing checked it.
 *
 * Written for the Milkdown 7.21.2 → 7.22.0 upgrade, which changed the
 * mechanism this rests on. Re-registering a schema id used to move it to the
 * END of `nodesCtx`; upstream's `upsertById` (#2429) now replaces it in place,
 * precisely because the move could reorder the group and hang the walk. Our
 * defence — register overrides after the preset — is unaffected either way,
 * but "unaffected" is a claim worth holding a test to on the version where the
 * mechanism moved.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, schemaCtx } from "@milkdown/core";
import type { Schema } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";

let editors: Editor[] = [];

async function productionSchema(): Promise<Schema> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, "");
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    editors.push(editor);
    return editor.action((ctx) => ctx.get(schemaCtx));
}

afterEach(async () => {
    await Promise.all(editors.map((editor) => editor.destroy()));
    editors = [];
    document.body.innerHTML = "";
});

describe("schema node order", () => {
    it("the doc node's default fill type should be paragraph", async () => {
        const schema = await productionSchema();
        expect(schema.nodes["doc"]?.contentMatch.defaultType?.name).toBe("paragraph");
    });

    it("every block container should fill with paragraph rather than another container", async () => {
        const schema = await productionSchema();
        // A container whose own content is `block+` is the shape that recurses
        // if the group's first member is another such container.
        const containers = Object.values(schema.nodes).filter(
            (type) => type.spec.content === "block+",
        );
        expect(containers.length).toBeGreaterThan(2);
        for (const type of containers) {
            expect(
                type.contentMatch.defaultType?.name,
                `${type.name} fills with a non-paragraph block`,
            ).toBe("paragraph");
        }
    });

    it("creating a doc without content should terminate and produce one paragraph", async () => {
        // The direct consequence, asserted as behavior: if the walk recursed
        // this would hang rather than fail, so keep it last.
        const schema = await productionSchema();
        const doc = schema.nodes["doc"]?.createAndFill();
        expect(doc?.childCount).toBe(1);
        expect(doc?.firstChild?.type.name).toBe("paragraph");
    });
});
