/**
 * A text node's escapes survive serialization whatever follows it (MAR-484).
 *
 * Milkdown's stock `text` stringify handler writes a text node verbatim, with
 * no escaping at all, when it ends in whitespace and holds no `*`, `_` or `\`.
 * Its purpose is to keep a trailing space from being written as `&#x20;`, but a
 * text node ends in whitespace whenever another inline node follows it, so a
 * literal `[x](y.md)` before a code span was saved unescaped and reopened as a
 * link. `configureSerialization` replaces that handler; this holds its output to
 * the one invariant that matters, over every pairing of an escaped construct
 * with a following inline node: the saved bytes reopen as the same document.
 */
import { describe, it, expect } from "vitest";
import { editorViewCtx, parserCtx, type Editor } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { Node as ProseNode } from "../pm";
import { makeCorpusEditor } from "./helpers/moveFuzz";

/** Source spellings of literal text that is markup when written bare. */
const ESCAPED = [
    "\\[not a link](nope.md)",
    "\\[not a ref]",
    "\\# not a heading",
    "\\<b>not html</b>",
    "\\`not code\\`",
    "\\$not math$",
    "\\==not highlight==",
    "!\\[not an image](i.png)",
    "&amp;copy; not an entity",
] as const;

/** What can follow the text in the same paragraph, so the text ends in a space. */
const FOLLOWERS = [
    "",
    " and `code`",
    " and **bold**",
    " and _em_",
    " and [a link](l.md)",
    " and [[Wiki]]",
] as const;

function reparse(editor: Editor, markdown: string): ProseNode {
    return editor.action((ctx) => ctx.get(parserCtx)(markdown)) as ProseNode;
}

describe("a text node's escapes survive whatever inline node follows it (MAR-484)", () => {
    it("every escaped construct beside every follower should reopen as the document it was saved from", async () => {
        const rows: string[] = [];
        const changed: string[] = [];
        for (const escaped of ESCAPED) {
            for (const follower of FOLLOWERS) {
                const source = `${escaped}${follower}\n`;
                const editor = await makeCorpusEditor(source);
                const opened = editor.action((ctx) => ctx.get(parserCtx)(source)) as ProseNode;
                // The row must be the literal it names, or it tests nothing:
                // an escape the parser did not honour would round-trip clean.
                expect(opened.textContent, `row did not open as literal text: ${source}`).toContain(
                    escaped.replace(/\\/g, "").replace("&amp;", "&").split(" ")[0],
                );
                const saved = editor.action(getMarkdown());
                if (!reparse(editor, saved).eq(opened)) changed.push(`${JSON.stringify(source)} -> ${JSON.stringify(saved)}`);
                rows.push(source);
                await editor.destroy();
            }
        }
        expect(rows.length).toBe(ESCAPED.length * FOLLOWERS.length);
        expect(changed).toEqual([]);
    });

    it("an escaped bracket before a code span should be written back byte for byte", async () => {
        const editor = await makeCorpusEditor("Price \\[x] and `code`\n");
        expect(editor.action(getMarkdown())).toBe("Price \\[x] and `code`\n");
        await editor.destroy();
    });

    it("a character escaped only before a bracket should stay bare when a space separates it from a link", async () => {
        // What follows the text is its trailing space, not the link's `[`: an
        // escape decided against the link would write `Wow\!` on every save.
        const editor = await makeCorpusEditor("Wow! [a link](l.md)\n");
        expect(editor.action(getMarkdown())).toBe("Wow! [a link](l.md)\n");
        await editor.destroy();
    });

    it("a space typed at the end of a paragraph should be written as a space, not a character reference", async () => {
        // The case Milkdown's handler exists for, which the replacement keeps.
        const editor = await makeCorpusEditor("Price \\[x]\n");
        editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            view.dispatch(view.state.tr.insertText(" ", view.state.doc.firstChild!.nodeSize - 1));
        });
        const saved = editor.action(getMarkdown());
        expect(editor.action((ctx) => ctx.get(editorViewCtx)).state.doc.textContent).toBe("Price [x] ");
        expect(saved).toBe("Price \\[x] \n");
        await editor.destroy();
    });
});
