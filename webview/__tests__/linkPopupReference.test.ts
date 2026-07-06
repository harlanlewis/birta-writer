/**
 * Reference links ([text][ref]) should resolve to their definition's URL so the
 * link popup / Cmd-click can open them like inline links.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "@milkdown/prose/view";
import { gfm } from "@milkdown/preset-gfm";
import { configureSerialization, pureCommonmark } from "../serialization";
import { resolveReferenceUrl } from "../components/linkPopup/index";

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfm)
        .create();
}

function withView<T>(editor: Editor, fn: (view: EditorView) => T): T {
    let result!: T;
    editor.action((ctx) => {
        result = fn(ctx.get(editorViewCtx));
    });
    return result;
}

const DOC = [
    "A full ref [see the spec][spec] and a shortcut [spec].",
    "",
    '[spec]: https://example.com/spec "Reference definition"',
    "",
].join("\n");

describe("resolveReferenceUrl", () => {
    it("a full reference identifier should resolve to its definition URL", async () => {
        const editor = await makeEditor(DOC);
        const url = withView(editor, (v) => resolveReferenceUrl(v, "spec"));
        expect(url).toBe("https://example.com/spec");
    });

    it("resolution should be case-insensitive (markdown normalizes identifiers)", async () => {
        const editor = await makeEditor(DOC);
        const url = withView(editor, (v) => resolveReferenceUrl(v, "SPEC"));
        expect(url).toBe("https://example.com/spec");
    });

    it("an unknown identifier should resolve to null", async () => {
        const editor = await makeEditor(DOC);
        const url = withView(editor, (v) => resolveReferenceUrl(v, "missing"));
        expect(url).toBeNull();
    });

    it("an empty identifier should resolve to null", async () => {
        const editor = await makeEditor(DOC);
        const url = withView(editor, (v) => resolveReferenceUrl(v, ""));
        expect(url).toBeNull();
    });
});
