/**
 * Paste fidelity against the round-trip corpus (MAR-21 item 5, paired with the
 * MAR-1 corpus).
 *
 * Markdown-aware paste (plugins/pasteMarkdown.ts) made the clipboard a SECOND
 * way source text becomes a document — the file-open parser is the first. A
 * second parser is a second chance to corrupt, and the class of bug that
 * matters is the one Milkdown#2400 names: characters that gain an escape on
 * every pass, so a document grows a backslash at a time until it is unreadable.
 * Byte growth is invisible to a single round trip and obvious to a repeated
 * one, so the load-bearing invariant here is IDEMPOTENCE.
 *
 * Invariants:
 *   E. Pasting a document's own source and saving loses no text — every
 *      character of content survives the clipboard trip.
 *   F. Pasting is idempotent: pasting the saved result of a paste produces
 *      byte-identical output. An escape that accretes fails on the second pass
 *      even when the first looked clean.
 *   G. Named special-character payloads paste to exactly the expected bytes.
 */
import { describe, it, expect } from "vitest";
import { editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { pasteMarkdownPlugin } from "../plugins/pasteMarkdown";
import { pasteTableCellPlugin } from "../plugins/pasteTableCell";
import { parseFromClipboard, Slice, TextSelection } from "../pm";
import { loadCorpusFixtures, makeCorpusEditor } from "./helpers/moveFuzz";

const fixtures = loadCorpusFixtures();

/**
 * Pastes `source` into an empty editor exactly as ProseMirror's own `doPaste`
 * would, and returns the Markdown that would be saved.
 */
async function pasteIntoEmpty(source: string): Promise<{ md: string; text: string }> {
    const editor = await makeCorpusEditor("", [pasteMarkdownPlugin, pasteTableCellPlugin]);
    try {
        const v = editor.action((ctx) => ctx.get(editorViewCtx));
        // Inside the empty document's paragraph (1), not before it (0): at 0
        // the caret is a gap position, and a pasted block is inserted BESIDE
        // the empty paragraph rather than replacing it, leaving a trailing
        // blank that has nothing to do with paste fidelity.
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1)));
        const slice = parseFromClipboard(v, source, null, false, v.state.selection.$from);
        if (slice) {
            const s = slice as Slice;
            const single = s.openStart === 0 && s.openEnd === 0 && s.content.childCount === 1
                ? s.content.firstChild
                : null;
            v.dispatch(single
                ? v.state.tr.replaceSelectionWith(single, false)
                : v.state.tr.replaceSelection(s));
        }
        return { md: editor.action(getMarkdown()), text: v.state.doc.textContent };
    } finally {
        await editor.destroy();
    }
}

/** The text content of `source` opened the ordinary way (the file-open path). */
async function openedText(source: string): Promise<string> {
    const editor = await makeCorpusEditor(source);
    try {
        return editor.action((ctx) => ctx.get(editorViewCtx)).state.doc.textContent;
    } finally {
        await editor.destroy();
    }
}

describe("paste invariant E — pasting a document's own source loses no text", () => {
    for (const { name, content } of fixtures) {
        it(`${name} should survive the clipboard with its text intact`, async () => {
            const { text } = await pasteIntoEmpty(content);
            expect(text).toBe(await openedText(content));
        });
    }
});

describe("paste invariant F — pasting is idempotent (no accreting escapes)", () => {
    for (const { name, content } of fixtures) {
        it(`${name} should paste to a fixed point`, async () => {
            const first = (await pasteIntoEmpty(content)).md;
            const second = (await pasteIntoEmpty(first)).md;
            expect(second).toBe(first);
        });
    }
});

/**
 * Invariant G: the Milkdown#2400 class, named case by case. Each payload is
 * text a user could plausibly copy out of a terminal, a code review, or another
 * Markdown file, and each has at least one character the serializer must decide
 * whether to escape.
 */
describe("paste invariant G — special characters paste to exact bytes", () => {
    const CASES: Array<[name: string, pasted: string, expected: string]> = [
        ["a bare autolink", "<https://example.com>", "<https://example.com>\n"],
        ["an escaped asterisk", "a \\* b", "a \\* b\n"],
        // Escape and entity NORMALIZATION, not loss: `\\` is CommonMark for one
        // literal backslash, and the serializer re-emits it as a bare `\`
        // because `\p` is not an escapable sequence — so the text means exactly
        // the same thing and re-parses to itself (invariant F covers that). The
        // file-open path preserves the original bytes only because minimal-diff
        // protects lines the user never touched; pasted text is new content and
        // has no bytes to protect.
        ["a literal backslash", "C:\\\\path\\\\to", "C:\\path\\to\n"],
        ["a windows path", "C:\\Users\\foo", "C:\\Users\\foo\n"],
        ["intraword underscores", "foo_bar_baz", "foo\\_bar\\_baz\n"],
        ["asterisks with spaces", "2 * 3 * 4", "2 \\* 3 \\* 4\n"],
        ["inline code with backticks", "use `` ` `` here", "use `` ` `` here\n"],
        ["a fenced block", "```js\nconst x = 1;\n```", "```js\nconst x = 1;\n```\n"],
        // Same category: the parser decodes entities to characters, and the
        // characters are what round-trips from then on.
        ["html entities", "&amp; &lt; &gt;", "& < >\n"],
        ["a footnote reference", "text[^1]\n\n[^1]: note", "text[^1]\n\n[^1]: note\n"],
        ["a reference link", "[a][ref]\n\n[ref]: https://x.com", "[a][ref]\n\n[ref]: https://x.com\n"],
        ["a table with pipes", "| a \\| b |\n| - |\n| 1 |", "| a \\| b |\n|---|\n| 1 |\n"],
        ["nested emphasis", "***both***", "***both***\n"],
        ["a hard break", "one  \ntwo", "one\\\ntwo\n"],
        ["an html comment", "<!-- keep -->", "<!-- keep -->\n"],
    ];

    for (const [name, pasted, expected] of CASES) {
        it(`${name} should paste to its exact source`, async () => {
            expect((await pasteIntoEmpty(pasted)).md).toBe(expected);
        });
    }

    // The growth signature of Milkdown#2400: an escape added per pass. Three
    // passes make an accreting backslash unmissable.
    for (const [name, pasted] of CASES) {
        it(`${name} should not grow over repeated pastes`, async () => {
            const a = (await pasteIntoEmpty(pasted)).md;
            const b = (await pasteIntoEmpty(a)).md;
            const c = (await pasteIntoEmpty(b)).md;
            expect(c).toBe(b);
            expect(b).toBe(a);
        });
    }
});
