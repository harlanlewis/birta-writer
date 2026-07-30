/**
 * Rich-HTML paste → Markdown (MAR-21 item 2).
 *
 * The bulk of this already worked: ProseMirror parses the clipboard's
 * `text/html` against the schema, so a paste from a browser, Google Docs, or
 * Word arrives as real nodes. These tests pin that (so a schema change cannot
 * quietly regress it) and cover the three upstream `parseDOM` gaps that were
 * silently DROPPING marked-up content — each of which loses information a user
 * can see on the page they copied from.
 *
 * Driven through PM's own `parseFromClipboard` with an html flavor and no
 * text, which is the shape a rich clipboard actually has.
 */
import { describe, it, expect } from "vitest";
import { editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { parseFromClipboard, Slice, TextSelection } from "../pm";
import { makeCorpusEditor } from "./helpers/moveFuzz";

/** Pastes `html` as a rich clipboard into an empty document; returns the Markdown. */
async function pasteHtml(html: string): Promise<string> {
    const editor = await makeCorpusEditor("");
    try {
        const v = editor.action((ctx) => ctx.get(editorViewCtx));
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1)));
        const slice = parseFromClipboard(v, "", html, false, v.state.selection.$from);
        if (slice) {
            const s = slice as Slice;
            const single = s.openStart === 0 && s.openEnd === 0 && s.content.childCount === 1
                ? s.content.firstChild
                : null;
            v.dispatch(single
                ? v.state.tr.replaceSelectionWith(single, false)
                : v.state.tr.replaceSelection(s));
        }
        return editor.action(getMarkdown());
    } finally {
        await editor.destroy();
    }
}

describe("rich HTML pastes as Markdown", () => {
    const CASES: Array<[name: string, html: string, expected: string]> = [
        ["headings and inline marks", "<h1>Title</h1><p>Some <strong>b</strong> and <em>i</em>.</p>", "# Title\n\nSome **b** and *i*.\n"],
        ["a bullet list", "<ul><li>one</li><li>two</li></ul>", "- one\n- two\n"],
        ["an ordered list", "<ol><li>one</li><li>two</li></ol>", "1. one\n2. two\n"],
        ["a nested list", "<ul><li>one<ul><li>inner</li></ul></li></ul>", "- one\n  - inner\n"],
        ["a link", "<p>see <a href='https://x.com'>x</a></p>", "see [x](https://x.com)\n"],
        ["inline code", "<p>use <code>foo()</code> now</p>", "use `foo()` now\n"],
        ["a code block", "<pre><code>const x = 1;</code></pre>", "```\nconst x = 1;\n```\n"],
        ["a blockquote", "<blockquote><p>quoted</p></blockquote>", "> quoted\n"],
        ["a horizontal rule", "<p>a</p><hr><p>b</p>", "a\n\n---\n\nb\n"],
        // The span soup a Google Docs copy actually produces: weight carried by
        // inline style, wrapped in a <b> that is itself reset to normal.
        ["Google Docs span soup", "<b style='font-weight:normal'><p dir='ltr'><span style='font-weight:700'>Bold</span> plain</p></b>", "**Bold** plain\n"],
        ["Word inline styles", "<p class='MsoNormal'><span style='font-style:italic'>Ital</span></p>", "*Ital*\n"],
        ["div soup", "<div>one</div><div>two</div>", "one\n\ntwo\n"],
    ];

    for (const [name, html, expected] of CASES) {
        it(`${name} should convert to Markdown`, async () => {
            expect(await pasteHtml(html)).toBe(expected);
        });
    }
});

describe("HTML paste gaps that dropped content", () => {
    // Milkdown's strike_through lists only <del> plus a line-through style
    // rule, so <s> — what most renderers emit for ~~…~~ — pasted as plain text
    // and the strikethrough was lost.
    it("<s> and <strike> should paste as strikethrough, like <del>", async () => {
        expect(await pasteHtml("<p><del>a</del> <s>b</s> <strike>c</strike></p>"))
            .toBe("~~a~~ ~~b~~ ~~c~~\n");
    });

    it("a line-through style should still paste as strikethrough", async () => {
        expect(await pasteHtml("<p><span style='text-decoration:line-through'>x</span></p>"))
            .toBe("~~x~~\n");
    });

    // Milkdown read title as `title || alt`, so an ordinary <img src alt>
    // gained a hover tooltip the source never had — written into the file.
    it("an image's alt should not be duplicated into its title", async () => {
        expect(await pasteHtml("<p><img src='a.png' alt='alt text'></p>"))
            .toBe("![alt text](a.png)\n");
    });

    it("an image's real title should still be kept", async () => {
        expect(await pasteHtml("<p><img src='a.png' alt='alt text' title='real title'></p>"))
            .toBe("![alt text](a.png \"real title\")\n");
    });

    // GFM's rule reads `checked` only from data-checked (what our own toDOM
    // writes); rendered task lists in the wild use a real checkbox input, so
    // every tick was dropped and the list arrived as plain bullets.
    it("a rendered task list's checkboxes should survive", async () => {
        expect(await pasteHtml(
            "<ul><li><input type='checkbox' checked>done</li><li><input type='checkbox'>todo</li></ul>",
        )).toBe("- [x] done\n- [ ] todo\n");
    });

    it("an ordinary list should not be turned into a task list", async () => {
        expect(await pasteHtml("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two\n");
    });

    // A checkbox belonging to a NESTED item must not mark its parent.
    it("a nested task item's checkbox should not tick its parent", async () => {
        expect(await pasteHtml(
            "<ul><li>parent<ul><li><input type='checkbox' checked>child</li></ul></li></ul>",
        )).toBe("- parent\n  - [x] child\n");
    });
});
