/**
 * linkInputRule tests: typing literal `[text](url)` syntax in the document
 * body converts it into real link-marked text on the closing ")", driving
 * the REAL Milkdown editor (real parser, real input-rule runner via the
 * handleTextInput prop, the production serialization config) — no mocks.
 * Inside code contexts (inline code mark, code blocks) the syntax must stay
 * literal.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";
import type { Mark } from "../pm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { linkInputRule } from "../plugins/linkInputRule";

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
        .use(linkInputRule)
        .create();
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Place the text cursor at the very end of the doc's n-th top-level block. */
function placeCursorAtEndOfBlock(v: EditorView, n: number): void {
    const { state } = v;
    let pos = 0;
    for (let i = 0; i < n; i++) pos += state.doc.child(i).nodeSize;
    const endOfText = pos + state.doc.child(n).nodeSize - 1;
    v.dispatch(state.tr.setSelection(TextSelection.create(state.doc, endOfText)));
}

/**
 * Simulate real typing character by character: each char first goes through
 * the input-rule runner's handleTextInput prop (exactly what the DOM event
 * path does); only unhandled chars are inserted as plain text.
 */
function typeWithInputRules(v: EditorView, text: string): void {
    for (const ch of text) {
        const { from, to } = v.state.selection;
        const handled = v.someProp("handleTextInput", (f) => f(v, from, to, ch));
        if (!handled) {
            v.dispatch(v.state.tr.insertText(ch, from, to));
        }
    }
}

/** All [text, link-mark] pairs found in the document. */
function linkedTexts(v: EditorView): Array<{ text: string; href: string }> {
    const found: Array<{ text: string; href: string }> = [];
    v.state.doc.descendants((node) => {
        if (!node.isText) return;
        const link = node.marks.find((m: Mark) => m.type.name === "link");
        if (link) {
            found.push({ text: node.text ?? "", href: link.attrs["href"] as string });
        }
    });
    return found;
}

describe("typing [text](url) should create a real link", () => {
    it("typing the closing paren after a full inline link should apply the link mark", async () => {
        // Arrange
        const editor = await makeEditor("start\n");
        const v = view(editor);
        placeCursorAtEndOfBlock(v, 0);

        // Act — the user types the whole construct, closing paren last
        typeWithInputRules(v, " see [Milkdown](https://milkdown.dev)");

        // Assert — the literal syntax is gone; the text carries the link mark
        expect(v.state.doc.textContent).toBe("start see Milkdown");
        expect(linkedTexts(v)).toEqual([
            { text: "Milkdown", href: "https://milkdown.dev" },
        ]);
        // ...and it serializes back as the same inline link
        expect(editor.action(getMarkdown())).toContain(
            "[Milkdown](https://milkdown.dev)",
        );
        await editor.destroy();
    });

    it("a relative path url should round-trip through the serializer", async () => {
        // Arrange
        const editor = await makeEditor("intro\n");
        const v = view(editor);
        placeCursorAtEndOfBlock(v, 0);

        // Act
        typeWithInputRules(v, " [notes](../notes/index.md)");

        // Assert
        expect(linkedTexts(v)).toEqual([
            { text: "notes", href: "../notes/index.md" },
        ]);
        expect(editor.action(getMarkdown())).toContain("[notes](../notes/index.md)");
        await editor.destroy();
    });

    it("an empty url should still create the link (empty href for the popup to fill)", async () => {
        // Arrange
        const editor = await makeEditor("start\n");
        const v = view(editor);
        placeCursorAtEndOfBlock(v, 0);

        // Act
        typeWithInputRules(v, " [fill me]()");

        // Assert — link exists with an empty href
        expect(linkedTexts(v)).toEqual([{ text: "fill me", href: "" }]);
        await editor.destroy();
    });

    it("text typed after the conversion should not extend the link", async () => {
        // Arrange
        const editor = await makeEditor("start\n");
        const v = view(editor);
        placeCursorAtEndOfBlock(v, 0);

        // Act
        typeWithInputRules(v, " [a](b) tail");

        // Assert — only "a" is linked; " tail" stays plain
        expect(v.state.doc.textContent).toBe("start a tail");
        expect(linkedTexts(v)).toEqual([{ text: "a", href: "b" }]);
        await editor.destroy();
    });
});

describe("existing links must never be rewritten", () => {
    it("typing ](url) after a link whose text contains [ should keep the link intact", async () => {
        // Arrange — a link whose TEXT is "[a" (escaped bracket) with href "u"
        const editor = await makeEditor("[\\[a](u)\n");
        const v = view(editor);
        expect(linkedTexts(v)).toEqual([{ text: "[a", href: "u" }]);
        placeCursorAtEndOfBlock(v, 0);

        // Act — the closing ")" makes the regex match `[a](c)` spanning the
        // existing link's text; converting would rewrite its text and href
        typeWithInputRules(v, "](c)");

        // Assert — the href is NEVER rewritten to "c" and the doc text is a
        // plain literal insert. (The typed chars joining the link's text is
        // the inclusive link mark's normal typing behavior, not this rule.)
        const links = linkedTexts(v);
        expect(links).toHaveLength(1);
        expect(links[0].href).toBe("u");
        expect(v.state.doc.textContent).toBe("[a](c)");
        await editor.destroy();
    });

    it("typing a new link near an existing one should still convert", async () => {
        // Arrange — the guard must only fire on OVERLAP with linked text;
        // the caret starts after unlinked trailing text
        const editor = await makeEditor("[x](u) and\n");
        const v = view(editor);
        placeCursorAtEndOfBlock(v, 0);

        // Act
        typeWithInputRules(v, " [y](v)");

        // Assert — both links exist, each with its own href
        expect(linkedTexts(v)).toEqual([
            { text: "x", href: "u" },
            { text: "y", href: "v" },
        ]);
        await editor.destroy();
    });
});

describe("code contexts must keep the syntax literal", () => {
    it("typing the closing paren inside inline code should not create a link", async () => {
        // Arrange — a paragraph that is one inline code span: `[text](url`
        const editor = await makeEditor("`[text](url`\n");
        const v = view(editor);
        // Cursor right after "url", still inside the code span
        const codeEnd = 1 + "[text](url".length;
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, codeEnd)));

        // Act
        typeWithInputRules(v, ")");

        // Assert — no link mark anywhere; the paren was typed literally
        expect(linkedTexts(v)).toEqual([]);
        expect(v.state.doc.textContent).toBe("[text](url)");
        await editor.destroy();
    });

    it("typing the closing paren inside a code block should not create a link", async () => {
        // Arrange
        const editor = await makeEditor("```\n[text](url\n```\n");
        const v = view(editor);
        placeCursorAtEndOfBlock(v, 0);

        // Act
        typeWithInputRules(v, ")");

        // Assert
        expect(linkedTexts(v)).toEqual([]);
        expect(v.state.doc.child(0).type.name).toBe("code_block");
        expect(v.state.doc.child(0).textContent).toBe("[text](url)");
        await editor.destroy();
    });
});
