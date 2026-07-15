/**
 * clearFormatting command: strips inline styling marks from the selection but
 * preserves a link (a link is a target — structure — not formatting, matching
 * Word/Docs "Clear Formatting"). Driven through a real Milkdown editor so the
 * removeMark loop runs against the actual schema.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    Editor,
    rootCtx,
    defaultValueCtx,
    editorViewCtx,
} from "@milkdown/core";
import { TextSelection } from "@milkdown/prose/state";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { runEditorCommand } from "../editorCommands";

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

const md = (editor: Editor): string => editor.action(getMarkdown()).trim();

/** Select the whole first paragraph's text content. */
function selectFirstParagraph(editor: Editor): void {
    editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { doc } = view.state;
        const para = doc.child(0);
        const start = 1;
        const end = start + para.content.size;
        view.dispatch(
            view.state.tr.setSelection(TextSelection.create(doc, start, end)),
        );
    });
}

describe("clearFormatting command", () => {
    let editor: Editor | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    afterEach(async () => {
        if (editor) {
            await editor.destroy();
            editor = null;
        }
    });

    it("clearing formatting on a bold link should drop the bold but keep the link", async () => {
        // Arrange — the word carries both a link and a strong mark
        editor = await makeEditor("[**word**](https://example.com)\n");
        selectFirstParagraph(editor);

        // Act
        runEditorCommand("clearFormatting", () => editor);

        // Assert — link survives, bold is gone
        expect(md(editor)).toBe("[word](https://example.com)");
    });

    it("clearing formatting on bold+italic non-link text should strip all styling", async () => {
        // Arrange
        editor = await makeEditor("***loud***\n");
        selectFirstParagraph(editor);

        // Act
        runEditorCommand("clearFormatting", () => editor);

        // Assert — plain text, no emphasis markers
        expect(md(editor)).toBe("loud");
    });
});
