/**
 * Container directives: `:::name … :::` paragraph runs parse to
 * container_directive nodes and serialize back to the exact source bytes.
 * Real Milkdown editor with the production serialization config (the
 * wikiLinks/callouts harness) — byte-identity is the design contract.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "@milkdown/prose/view";
import type { Node as PMNode } from "@milkdown/prose/model";
import { TextSelection } from "@milkdown/prose/state";
import { configureSerialization, pureCommonmark } from "../serialization";
import {
    closeFenceColons,
    directiveTitle,
    parseOpenFence,
} from "../plugins/directives";

async function makeEditor(markdown: string): Promise<{
    editor: Editor;
    view: EditorView;
}> {
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
    return { editor, view };
}

async function roundTrip(markdown: string): Promise<string> {
    const { editor } = await makeEditor(markdown);
    const out = editor.action(getMarkdown());
    await editor.destroy();
    return out;
}

function findDirectives(view: EditorView): PMNode[] {
    const found: PMNode[] = [];
    view.state.doc.descendants((node) => {
        if (node.type.name === "container_directive") found.push(node);
        return true;
    });
    return found;
}

describe("parseOpenFence / closeFenceColons / directiveTitle", () => {
    it("parses name, colon count, and raw rest", () => {
        expect(parseOpenFence(":::note")).toEqual({ colons: 3, name: "note", rest: "" });
        expect(parseOpenFence("::::tip A title")).toEqual({
            colons: 4, name: "tip", rest: " A title",
        });
        expect(parseOpenFence(':::info{title="x"}')).toEqual({
            colons: 3, name: "info", rest: '{title="x"}',
        });
    });

    it("rejects non-fences: spaced names, escapes, references, short fences", () => {
        expect(parseOpenFence("::: note")).toBeNull();
        expect(parseOpenFence("::note")).toBeNull();
        expect(parseOpenFence(":::note \\*x\\*")).toBeNull();
        expect(parseOpenFence(":::note a &amp; b")).toBeNull();
    });

    it("closing fences are colons only", () => {
        expect(closeFenceColons(":::")).toBe(3);
        expect(closeFenceColons("::::")).toBe(4);
        expect(closeFenceColons("::: x")).toBe(0);
        expect(closeFenceColons("::")).toBe(0);
    });

    it("directiveTitle strips a trailing attribute block", () => {
        expect(directiveTitle(" My title")).toBe("My title");
        expect(directiveTitle(' Title {title="x"}')).toBe("Title");
        expect(directiveTitle('{title="x"}')).toBe("");
    });
});

describe("directive parsing", () => {
    it("a single-paragraph directive parses with attached fences", async () => {
        const { editor, view } = await makeEditor(":::note\nBody text.\n:::\n");
        const [node] = findDirectives(view);
        expect(node).toBeDefined();
        expect(node!.attrs["name"]).toBe("note");
        expect(node!.attrs["openFence"]).toBe(":::note");
        expect(node!.attrs["closeFence"]).toBe(":::");
        expect(node!.attrs["openAttached"]).toBe(true);
        expect(node!.attrs["closeAttached"]).toBe(true);
        await editor.destroy();
    });

    it("a titled fence records the display title", async () => {
        const { editor, view } = await makeEditor(":::tip Pro tip\nBody.\n:::\n");
        const [node] = findDirectives(view);
        expect(node!.attrs["title"]).toBe("Pro tip");
        await editor.destroy();
    });

    it("blank-line separated fences record detached flags", async () => {
        const { editor, view } = await makeEditor(":::warning\n\nBody.\n\n:::\n");
        const [node] = findDirectives(view);
        expect(node!.attrs["openAttached"]).toBe(false);
        expect(node!.attrs["closeAttached"]).toBe(false);
        await editor.destroy();
    });

    it("multi-block content (paragraphs + list) is contained", async () => {
        const { editor, view } = await makeEditor(
            ":::note\nFirst.\n\nSecond.\n\n- item\n\n:::\n",
        );
        const nodes = findDirectives(view);
        expect(nodes).toHaveLength(1);
        expect(nodes[0]!.childCount).toBe(3);
        await editor.destroy();
    });

    it("4-colon fences nest a 3-colon directive inside", async () => {
        const { editor, view } = await makeEditor(
            "::::danger Outer\nOuter body.\n\n:::note Inner\nInner body.\n:::\n\n::::\n",
        );
        const nodes = findDirectives(view);
        expect(nodes).toHaveLength(2);
        const names = nodes.map((n) => n.attrs["name"]);
        expect(names).toContain("danger");
        expect(names).toContain("note");
        await editor.destroy();
    });

    it("an unclosed fence stays ordinary paragraphs", async () => {
        const { editor, view } = await makeEditor(":::note\nNo closer here.\n");
        expect(findDirectives(view)).toHaveLength(0);
        await editor.destroy();
    });

    it("a spaced name is not a directive", async () => {
        const { editor, view } = await makeEditor("::: note\nBody.\n:::\n");
        expect(findDirectives(view)).toHaveLength(0);
        await editor.destroy();
    });

    it("a formatted fence line is not a directive", async () => {
        const { editor, view } = await makeEditor(":::note **bold** rest\nBody.\n:::\n");
        expect(findDirectives(view)).toHaveLength(0);
        await editor.destroy();
    });

    it("directives inside a blockquote parse too", async () => {
        const { editor, view } = await makeEditor("> :::note\n> Quoted body.\n> :::\n");
        expect(findDirectives(view)).toHaveLength(1);
        await editor.destroy();
    });
});

describe("directive round-trip byte-identity", () => {
    const FORMS = [
        ":::note\nBody text.\n:::\n",
        ":::tip Pro tip title\nBody.\n:::\n",
        ":::warning\n\nDetached body.\n\n:::\n",
        ':::info{title="Attrs"}\nBody.\n:::\n',
        ":::note\nFirst.\n\nSecond with **bold**.\n\n:::\n",
        // Fence adjacent to a non-paragraph block (no blank lines anywhere).
        ":::note\n```js\ncode();\n```\n:::\n",
        "::::danger Outer\nOuter.\n\n:::note Inner\nInner.\n:::\n\n::::\n",
        ":::note\n:::\n",
        ":::note\nAttached open.\n\n:::\n",
        ":::note\n\nDetached open, attached close.\n:::\n",
        ":::note\nNo closer stays text.\n",
        "::: note\nSpaced name stays text.\n:::\n",
        "> :::note\n> Quoted body.\n> :::\n",
    ];

    for (const form of FORMS) {
        it(`round-trips ${JSON.stringify(form.split("\n")[0])} byte-identically`, async () => {
            expect(await roundTrip(form)).toBe(form);
        });
    }

    it("round-trips a directive between other blocks unchanged", async () => {
        const doc = "Before.\n\n:::tip Careful\nWatch out.\n:::\n\nAfter.\n";
        expect(await roundTrip(doc)).toBe(doc);
    });
});

describe("typing :::name should convert an empty paragraph (input rule)", () => {
    function typeWithInputRules(v: EditorView, text: string): void {
        for (const ch of text) {
            const { from, to } = v.state.selection;
            const handled = v.someProp("handleTextInput", (f) => f(v, from, to, ch));
            if (!handled) {
                v.dispatch(v.state.tr.insertText(ch, from, to));
            }
        }
    }

    it("converts and serializes with attached fences", async () => {
        const { editor, view } = await makeEditor("before\n\nx\n");
        // Select the placeholder paragraph content ("x") and replace it.
        let xPos = -1;
        view.state.doc.descendants((node, pos) => {
            if (node.isText && node.text === "x") xPos = pos;
            return true;
        });
        view.dispatch(
            view.state.tr.setSelection(
                TextSelection.create(view.state.doc, xPos, xPos + 1),
            ),
        );
        typeWithInputRules(view, ":::note ");

        const nodes = findDirectives(view);
        expect(nodes).toHaveLength(1);
        expect(nodes[0]!.attrs["openFence"]).toBe(":::note");
        expect(editor.action(getMarkdown())).toBe("before\n\n:::note\n:::\n");
        await editor.destroy();
    });

    it("does not convert mid-paragraph", async () => {
        const { editor, view } = await makeEditor("start\n");
        const end = view.state.doc.content.size - 1;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
        typeWithInputRules(view, " :::note ");
        expect(findDirectives(view)).toHaveLength(0);
        await editor.destroy();
    });
});

describe("editing inside a directive", () => {
    it("body edits serialize inside the unchanged fences", async () => {
        const { editor, view } = await makeEditor(":::tip Stable\nBody.\n:::\n");
        let textEnd = -1;
        view.state.doc.descendants((node, pos) => {
            if (node.isText && node.text === "Body.") textEnd = pos + node.nodeSize;
            return true;
        });
        expect(textEnd).toBeGreaterThan(-1);
        view.dispatch(view.state.tr.insertText(" More.", textEnd));
        expect(editor.action(getMarkdown())).toBe(":::tip Stable\nBody. More.\n:::\n");
        await editor.destroy();
    });
});
