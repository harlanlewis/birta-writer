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
 * Letters and digits only, for the "nothing was dropped" invariant. Comparing
 * dense forms sidesteps every difference that is NOT content loss — escaping,
 * whitespace, block separators, `<br>` vs newline — so the assertion is about
 * characters surviving rather than about formatting.
 */
function dense(text: string): string {
    return text.replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * How many lines a document's tables should occupy: one per row, plus one
 * separator per table. A row broken across two lines (the MAR-277 corruption)
 * makes the actual count fall short, because the continuation line no longer
 * starts with a pipe.
 */
function expectedTableLines(doc: ProseNode): number {
    let rows = 0;
    let tables = 0;
    doc.descendants((n) => {
        const name = n.type.name;
        if (name === "table") { tables++; }
        if (name === "table_row" || name === "table_header_row") { rows++; }
        return true;
    });
    return rows === 0 ? 0 : rows + tables;
}

/**
 * The lines a Markdown document devotes to table rows.
 *
 * Two subtleties, both of which produced false failures before they were
 * handled: a row nested in a blockquote is prefixed (`> | a | b |`), and a
 * FENCED BLOCK's contents can contain pipe-leading lines that are code, not
 * table rows — so fenced regions are skipped outright.
 */
function tableRowLines(md: string): string[] {
    const out: string[] = [];
    let inFence = false;
    for (const raw of md.split("\n")) {
        const line = raw.replace(/^[>\s]+/, "");
        if (/^(```|~~~)/.test(line)) { inFence = !inFence; continue; }
        if (inFence) { continue; }
        if (line.startsWith("|")) { out.push(line); }
    }
    return out;
}

/**
 * A table's shape as its per-row column count. Splitting must ignore ESCAPED
 * pipes: a cell legitimately containing `\|` is one column, and counting it as
 * two reported phantom reshaping (the first thing this helper got wrong).
 */
function tableShape(md: string): string {
    return tableRowLines(md)
        .map((l) => l.replace(/\\\|/g, "").split("|").length)
        .join(",");
}

/**
 * Combinations with a KNOWN, filed defect in ONE invariant (B, round-trip
 * stability). The gap is asserted INVERTED rather than marked `it.fails`: every
 * other invariant is still enforced for these combinations, so a fresh bug in
 * them still fails loudly — which `it.fails` would have masked, since it passes
 * whenever the test throws for any reason at all. And because the inverted
 * assertion breaks the moment the defect is fixed, the list cannot rot.
 *
 * MAR-279 — a table followed by another block inside a TIGHT list item
 * serializes with no blank line between them, so reopening absorbs the trailing
 * block as a table row. Not paste-specific (hand-authoring the same structure
 * loose round-trips fine); the fix belongs in the serializer's list-join logic,
 * which MAR-124/MAR-194 tuned and which deserves its own pass.
 */
const KNOWN_GAPS = new Set([
    "a table|a list item",
    "a mixed document|a list item",
]);

describe("paste matrix — invariants across payload × context", () => {
    for (const [ctxName, ctxDoc, pick] of CONTEXTS) {
        for (const [payloadName, payload] of PAYLOADS) {
            const known = KNOWN_GAPS.has(`${payloadName}|${ctxName}`);
            it(`${payloadName} pasted into ${ctxName} should hold every invariant`, async () => {
                const editor: Editor = await makeCorpusEditor(
                    ctxDoc, [pasteMarkdownPlugin, pasteContainerFitPlugin],
                );
                try {
                    const v = editor.action((ctx) => ctx.get(editorViewCtx));
                    const beforeMd = editor.action(getMarkdown());
                    const beforeShape = tableShape(beforeMd);

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
                            "MAR-279: this gap is expected — delete the KNOWN_GAPS entry once it is fixed",
                        ).not.toBe(afterMd);
                    } else {
                        expect(reparsed).toBe(afterMd);
                    }

                    // C. A paste into a table must not reshape the table.
                    if (beforeShape !== "") {
                        expect(tableShape(afterMd), "table rows × columns").toBe(beforeShape);
                    }

                    // D. Every table row occupies exactly one line. A row split
                    // across two (a raw newline inside it) terminates the row and
                    // silently turns the rest of the table into prose — MAR-277.
                    expect(tableRowLines(afterMd).length, "lines occupied by table rows")
                        .toBe(expectedTableLines(v.state.doc));

                    // E. Nothing silently dropped. The payload survives either
                    // RENDERED (parsed to nodes) or LITERAL (raw text, which is
                    // what a code-block destination correctly produces); both are
                    // content-preserving, so either satisfies the invariant.
                    const payloadText = editor.action((ctx) => {
                        const doc = ctx.get(parserCtx)(payload);
                        return doc ? doc.textContent : payload;
                    });
                    const got = dense(v.state.doc.textContent);
                    const survived = got.includes(dense(payloadText)) || got.includes(dense(payload));
                    expect(survived, `payload content survives (sought "${dense(payloadText)}")`).toBe(true);
                } finally {
                    await editor.destroy();
                }
            });
        }
    }
});
