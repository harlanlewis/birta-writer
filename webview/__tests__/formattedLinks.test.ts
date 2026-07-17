/**
 * MAR-33: a link containing bold/italic/code children must serialize as ONE
 * link, not several adjacent links that each repeat the URL.
 *
 * These tests assert the RAW serializer output (no minimal-diff layer),
 * driving the REAL Milkdown editor with the production serialization config
 * (`pureCommonmark`, which includes the fidelity serializer) — no mocks.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";

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
        .use(gfmFidelity)
        .create();
}

async function roundTrip(markdown: string): Promise<string> {
    const editor = await makeEditor(markdown);
    const out = editor.action(getMarkdown());
    await editor.destroy();
    return out;
}

/** Number of inline-link occurrences of `url` in serializer output. */
function linkCount(output: string, url: string): number {
    return output.split(`](${url})`).length - 1;
}

describe("fidelity serializer — formatted links stay whole (MAR-33)", () => {
    it("a link with bold and inline-code children should serialize as one link", async () => {
        const input = "[**bold** and `code` tail](https://example.com)";

        const out = await roundTrip(input);

        expect(out).toBe(`${input}\n`);
        expect(linkCount(out, "https://example.com")).toBe(1);
    });

    it("a link with an emphasis child should serialize as one link", async () => {
        const input = "[*em* tail](https://example.com)";

        expect(await roundTrip(input)).toBe(`${input}\n`);
    });

    it("a link with a strikethrough child should serialize as one link", async () => {
        const input = "[~~gone~~ tail](https://example.com)";

        expect(await roundTrip(input)).toBe(`${input}\n`);
    });

    it("a titled link with a bold child should keep its title on one link", async () => {
        const input = '[**bold** titled](https://example.com "The Title")';

        const out = await roundTrip(input);

        expect(out).toBe(`${input}\n`);
        expect(out.split("The Title").length - 1).toBe(1);
    });

    it("a link with CJK text and a bold child should serialize as one link", async () => {
        const input = "[**加粗**链接](https://example.com)";

        expect(await roundTrip(input)).toBe(`${input}\n`);
    });

    it("a strong span containing a link should serialize as one strong run", async () => {
        const input = "**a [l](https://example.com) b**";

        expect(await roundTrip(input)).toBe(`${input}\n`);
    });

    it("whole-link emphasis should canonicalize to emphasis inside the link", async () => {
        expect(await roundTrip("**[x](https://example.com)**")).toBe(
            "[**x**](https://example.com)\n",
        );
        expect(await roundTrip("*[x](https://example.com)*")).toBe(
            "[*x*](https://example.com)\n",
        );
        expect(await roundTrip("~~[x](https://example.com)~~")).toBe(
            "[~~x~~](https://example.com)\n",
        );
        expect(await roundTrip("***[x](https://example.com)***")).toBe(
            "[***x***](https://example.com)\n",
        );
    });

    it("genuinely adjacent same-URL links should NOT merge", async () => {
        const input = "[a](https://example.com) [b](https://example.com)";

        const out = await roundTrip(input);

        expect(out).toBe(`${input}\n`);
        expect(linkCount(out, "https://example.com")).toBe(2);
    });

    it("a reference link with a bold child should serialize as one reference", async () => {
        const input = "[**bold** text][ref]\n\n[ref]: https://example.com";

        const out = await roundTrip(input);

        expect(out).toBe("[**bold** text][ref]\n\n[ref]: https://example.com\n");
        expect(out.split("][ref]").length - 1).toBe(1);
    });

    it("typing inside a formatted link's text should still yield one link", async () => {
        const editor = await makeEditor(
            "[**bold** and `code` tail](https://example.com)",
        );
        const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView;

        // Insert before the final "l" of " tail" (doc: para at 0, inline
        // content from 1: "bold"(1-5) + " and "(5-10) + "code"(10-14) +
        // " tail"(14-19)).
        view.dispatch(view.state.tr.insertText("x", 18));
        const out = editor.action(getMarkdown());

        expect(out).toBe("[**bold** and `code` taixl](https://example.com)\n");
        expect(linkCount(out, "https://example.com")).toBe(1);
        await editor.destroy();
    });

    it("editor-created strong with a trailing space should serialize trimmed", async () => {
        const editor = await makeEditor("bold x");
        const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView;

        // Bold "bold " INCLUDING its trailing space (positions 1-5).
        const strong = view.state.schema.marks["strong"];
        view.dispatch(view.state.tr.addMark(1, 6, strong.create()));
        const out = editor.action(getMarkdown());

        // The space must hoist out of the strong run — `**bold **x` is not
        // valid CommonMark.
        expect(out).toBe("**bold** x\n");
        await editor.destroy();
    });
});
