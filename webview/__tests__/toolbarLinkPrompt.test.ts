/**
 * Toolbar Insert/Edit Link prompt tests: the openLinkPrompt controller
 * method (behind both the toolbar link button and the Cmd/Ctrl+K shortcut)
 * opens the two-input prompt against the REAL Milkdown editor — with a
 * selection it pre-fills the link text and links the selected range, without
 * one it inserts new linked text at the caret.
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import type { Mark } from "@milkdown/prose/model";
import { configureSerialization, pureCommonmark } from "../serialization";
import { initToolbar } from "../components/toolbar";

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

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function promptInputs(): { text: HTMLInputElement; url: HTMLInputElement } {
    const overlay = document.querySelector(".tb-prompt-overlay");
    expect(overlay).not.toBeNull();
    const inputs = overlay!.querySelectorAll("input");
    expect(inputs).toHaveLength(2);
    return { text: inputs[0], url: inputs[1] };
}

function pressEnter(input: HTMLInputElement): void {
    input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
}

/** All [text, href] pairs of link-marked text nodes in the document. */
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

describe("toolbar openLinkPrompt", () => {
    let editor: Editor;
    let v: EditorView;
    let tb: ReturnType<typeof initToolbar>;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor("hello world\n");
        v = view(editor);
        const topbar = document.createElement("div");
        topbar.className = "editor-topbar";
        document.body.appendChild(topbar);
        tb = initToolbar(topbar, () => editor);
    });

    afterEach(async () => {
        await editor.destroy();
    });

    it("with a selection it should pre-fill the link text and link the selected range", () => {
        // Arrange — select "hello" (paragraph content starts at pos 1)
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));

        // Act
        tb.openLinkPrompt();
        const { text, url } = promptInputs();
        expect(text.value).toBe("hello");
        url.value = "https://example.com";
        pressEnter(url);

        // Assert — the selected text now carries the link
        expect(document.querySelector(".tb-prompt-overlay")).toBeNull();
        expect(v.state.doc.textContent).toBe("hello world");
        expect(linkedTexts(v)).toEqual([
            { text: "hello", href: "https://example.com" },
        ]);
    });

    it("without a selection it should open with an empty text field and insert new linked text", () => {
        // Arrange — collapsed cursor at the end of the paragraph
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 12)));

        // Act
        tb.openLinkPrompt();
        const { text, url } = promptInputs();
        expect(text.value).toBe("");
        text.value = "docs";
        url.value = "./docs/index.md";
        pressEnter(url);

        // Assert — new linked text was inserted at the caret
        expect(v.state.doc.textContent).toBe("hello worlddocs");
        expect(linkedTexts(v)).toEqual([
            { text: "docs", href: "./docs/index.md" },
        ]);
    });

    it("editing an existing link should pre-fill its href", () => {
        // Arrange — link "world" first
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 7, 12)));
        tb.openLinkPrompt();
        {
            const { url } = promptInputs();
            url.value = "https://old.example";
            pressEnter(url);
        }
        expect(linkedTexts(v)).toEqual([
            { text: "world", href: "https://old.example" },
        ]);

        // Act — re-open the prompt on the same selection
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 7, 12)));
        tb.openLinkPrompt();
        const { text, url } = promptInputs();

        // Assert — both fields reflect the existing link
        expect(text.value).toBe("world");
        expect(url.value).toBe("https://old.example");
        url.value = "https://new.example";
        pressEnter(url);
        expect(linkedTexts(v)).toEqual([
            { text: "world", href: "https://new.example" },
        ]);
    });

    it("Escape should close the prompt without touching the document", () => {
        // Arrange
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));
        tb.openLinkPrompt();
        const { text } = promptInputs();

        // Act
        text.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );

        // Assert
        expect(document.querySelector(".tb-prompt-overlay")).toBeNull();
        expect(linkedTexts(v)).toEqual([]);
        expect(v.state.doc.textContent).toBe("hello world");
    });
});
