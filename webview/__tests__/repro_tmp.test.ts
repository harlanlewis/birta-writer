import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../../webview/serialization";

async function roundTrip(markdown: string): Promise<string> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, container);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfm)
        .create();
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    // dump spread attrs
    view.state.doc.descendants((node) => {
        if (node.type.name === "bullet_list" || node.type.name === "list_item") {
            console.log(node.type.name, "spread=", JSON.stringify(node.attrs.spread), typeof node.attrs.spread);
        }
        return true;
    });
    const out = editor.action(getMarkdown());
    await editor.destroy();
    return out;
}

describe("repro", () => {
    it("tight list top level", async () => {
        console.log(JSON.stringify(await roundTrip("- item\n- item two\n\nAfter.\n")));
    });
    it("loose list top level", async () => {
        console.log(JSON.stringify(await roundTrip("- a\n\n- b\n")));
    });
});
