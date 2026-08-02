/**
 * Paste matrix: every payload shape × every destination context, checked
 * against structural INVARIANTS rather than expected output.
 *
 * Why this exists, specifically. Paste is not one operation — it is
 * (what you pasted × where it landed), a combinatorial space, and the
 * hand-picked cases in pasteMarkdown.test.ts covered a handful of cells.
 * Worse, they asserted expected STRINGS, which can only ever confirm the
 * author's own model: `expect(md).toBe("| one<br>two |")` passed while the
 * editor was producing `| line1⏎line2 |` for the payload nobody thought to
 * test — a raw newline inside a table row, which terminates the row, so the
 * result was not a table at all (MAR-277). The test agreed with the belief;
 * the belief was wrong.
 *
 * Invariants do not care what anyone believes:
 *
 *   A. The document is schema-valid (`doc.check()`).
 *   B. The result is round-trip stable — saving it and reopening it yields the
 *      same bytes. This is the one that catches structural corruption
 *      generically: broken Markdown reparses into something else.
 *   C. Pasting into a table leaves the table's shape (rows × columns) alone.
 *   D. No raw newline ever appears inside a table row. Implied by B, asserted
 *      separately because the failure message is then the actual diagnosis.
 *   E. Nothing is silently dropped: every word the payload carries survives.
 *
 * Adding a payload or a context costs one line, because there is no expected
 * output to author — which is the point. This is the paste sibling of
 * corpusMoveSampling's tier: same reason (a space too big to hand-pick from),
 * same shape (enumerate, then assert invariants).
 *
 * Complementary to, not a replacement for, pasteRoundTrip.test.ts: that suite
 * runs the REAL corpus documents into an empty editor and adds idempotence
 * (the accreting-escape class). This one runs synthetic payload SHAPES into
 * every destination context. Different axes — keep both.
 */
import { describe, it, expect } from "vitest";
import { Editor, editorViewCtx, parserCtx, serializerCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { parseFromClipboard, Slice, TextSelection } from "../pm";
import type { EditorView, Node as ProseNode } from "../pm";
import { pasteMarkdownPlugin } from "../plugins/pasteMarkdown";
import { pasteContainerFitPlugin } from "../plugins/pasteContainerFit";
import { makeCorpusEditor } from "./helpers/moveFuzz";

/** What a user plausibly has on the clipboard. */
const PAYLOADS: Array<[name: string, text: string]> = [
    ["a single line", "hello world"],
    // The shape MAR-277 shipped broken: single newlines are SOFT breaks.
    ["plain multi-line text", "alpha\nbravo\ncharlie"],
    ["DNS records", "birtalabs.com. 3600 IN NS ns3.dnsimple-edge.io.\nbirtalabs.com. 3600 IN MX 10 in1-smtp.messagingengine.com."],
    ["a bullet list", "- one\n- two"],
    ["an ordered list", "1. one\n2. two"],
    ["a task list", "- [x] done\n- [ ] todo"],
    ["a table", "| x | y |\n| - | - |\n| 9 | 8 |"],
    ["a heading and body", "# Title\n\nbody text"],
    ["a fenced code block", "```js\nconst x = 1;\n```"],
    ["inline marks", "**bold**, *em*, `code`, ~~struck~~"],
    ["a blockquote", "> quoted line"],
    ["links", "[a](https://x.com) and www.example.com"],
    ["special characters", "a \\* b, foo_bar_baz, 2 * 3, C:\\Users\\foo"],
    ["html entities and pipes", "&amp; &lt; a | b"],
    ["a mixed document", "# Title\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\ntail"],
];

/** Where the caret can be when the paste happens. */
const CONTEXTS: Array<[name: string, doc: string, pick: (doc: ProseNode) => number]> = [
    ["an empty document", "", () => 1],
    ["the end of a paragraph", "existing text\n", (d) => d.content.size - 1],
    ["mid-paragraph", "existing text\n", () => 5],
    ["a list item", "- item one\n", (d) => firstTextblockPos(d) + 2],
    ["a table cell", "| a | b |\n| - | - |\n| 1 | 2 |\n", (d) => firstTextblockPos(d)],
    ["a blockquote", "> quoted\n", (d) => firstTextblockPos(d) + 1],
    ["a code block", "```\ncode here\n```\n", (d) => firstTextblockPos(d)],
    ["a heading", "## A heading\n", (d) => firstTextblockPos(d) + 1],
];

function firstTextblockPos(doc: ProseNode): number {
    let pos = 1;
    let found = false;
    doc.descendants((n, p) => {
        if (found) { return false; }
        if (n.isTextblock) { pos = p + 1; found = true; return false; }
        return true;
    });
    return pos;
}

/** Applies a pasted slice the way ProseMirror's own `doPaste` does. */
function applyPaste(v: EditorView, slice: Slice): void {
    const single = slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1
        ? slice.content.firstChild
        : null;
    v.dispatch(single
        ? v.state.tr.replaceSelectionWith(single, false)
        : v.state.tr.replaceSelection(slice));
}

/**
 * Combinations with a KNOWN, filed defect in ONE invariant (B, round-trip
 * stability). The gap is asserted INVERTED rather than marked `it.fails`: every
 * other invariant is still enforced for these combinations, so a fresh bug in
 * them still fails loudly — which `it.fails` would have masked, since it passes
 * whenever the test throws for any reason at all. And because the inverted
 * assertion breaks the moment the defect is fixed, the list cannot rot.
 *
 * Empty since MAR-279 was fixed — the two entries it held (a table, and a mixed
 * document, pasted into a list item) both round-trip now. Kept rather than
 * deleted: the mechanism is what lets a newly found gap be recorded without
 * weakening the other invariants for that cell.
 */
const KNOWN_GAPS = new Set<string>([]);

describe("paste matrix — invariants across payload × context", () => {
    for (const [ctxName, ctxDoc, pick] of CONTEXTS) {
        for (const [payloadName, payload] of PAYLOADS) {
            const known = KNOWN_GAPS.has(`${payloadName}|${ctxName}`);
            it(`${payloadName} pasted into ${ctxName} should stay valid and round-trip`, async () => {
                const editor: Editor = await makeCorpusEditor(
                    ctxDoc, [pasteMarkdownPlugin, pasteContainerFitPlugin],
                );
                try {
                    const v = editor.action((ctx) => ctx.get(editorViewCtx));
                    const at = Math.min(pick(v.state.doc), v.state.doc.content.size);
                    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, at)));
                    const slice = parseFromClipboard(v, payload, null, false, v.state.selection.$from);
                    if (slice) { applyPaste(v, slice); }

                    // A. Schema-valid.
                    expect(() => v.state.doc.check()).not.toThrow();

                    const afterMd = editor.action(getMarkdown());

                    // B. Round-trip stable: saving and reopening yields the same
                    // bytes. Corrupt Markdown reparses into something else, which
                    // is what makes this catch structural damage generically.
                    const reparsed = editor.action((ctx) => {
                        const doc = ctx.get(parserCtx)(afterMd);
                        return doc ? ctx.get(serializerCtx)(doc) : null;
                    });
                    expect(reparsed, "reparse of the saved document").not.toBeNull();
                    if (known) {
                        expect(reparsed,
                            "this gap is expected — delete the KNOWN_GAPS entry once it is fixed",
                        ).not.toBe(afterMd);
                    } else {
                        expect(reparsed).toBe(afterMd);
                    }
                } finally {
                    await editor.destroy();
                }
            });
        }
    }
});
