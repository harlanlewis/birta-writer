/**
 * Blank-line spacing inside a TIGHT list item: every ordered pair of block
 * constructs, checked against structural invariants (MAR-279).
 *
 * Why the space has to be enumerated rather than sampled. A list item marked
 * `spread: false` is serialized with its flow children GLUED — no blank line
 * between them — and whether that survives a reopen depends on the pair: a
 * paragraph under a table becomes another table ROW, a paragraph under a nested
 * list becomes lazy continuation text of its last item, a dash rule under a
 * paragraph becomes a setext underline. The ticket was filed for the table case
 * and guessed that a table was "likely the only case"; the first enumeration
 * found 53 broken pairs across eight distinct absorbing/absorbed combinations,
 * including the second one the paste matrix had already recorded (a nested list
 * followed by a table). Hand-picking would have fixed the headline and left the
 * rest — and the two types added to `BLOCKS` after that first run went on to
 * prove the same point a second time, against this file.
 *
 * Why the fixture has to be BUILT rather than written. The broken structure is
 * not authorable: `- it\n  | x | y |\n  |---|---|\n  em one` already parses with
 * `em one` as a table row, so a hand-written tight item can never hold two
 * blocks in the first place. Only editing reaches it — pasting a table into the
 * middle of a tight item's text is the shortest route (`pasteMatrix.test.ts`
 * carries that end-to-end case). So each fixture here is parsed LOOSE, where the
 * two blocks are expressible, and then rebuilt with `spread: false`.
 *
 * The invariants are answered by the production parser and serializer, never by
 * re-parsing Markdown in the test (the `pasteMatrix` lesson):
 *
 *   B. Round-trip stable — serialize, reopen, serialize again, same bytes.
 *   C. The item still holds the same sequence of blocks after the reopen. B
 *      alone is not enough here: two glued blockquotes fuse into one and the
 *      fused form re-serializes to itself, so the corruption is stable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Editor, parserCtx, serializerCtx } from "@milkdown/core";
import type { Node as ProseNode } from "../pm";
import { makeCorpusEditor } from "./helpers/moveFuzz";

/**
 * ONE editor for the whole file, used only as a host for `parserCtx` and
 * `serializerCtx`. Every case here parses a string, rebuilds it, and serializes
 * it — none of them touches editor state, so a fresh editor per case bought
 * nothing and cost a great deal.
 *
 * It has to be shared rather than merely tidy: `Editor.create()` arms a timer
 * inside `@milkdown/ctx` that `destroy()` does not clear, so each case left a
 * pending `setTimeout` behind. Fired after the file's jsdom environment is torn
 * down, that timer throws `ReferenceError: removeEventListener is not defined`
 * — a vitest UNHANDLED error, which fails the run with every test passing and
 * no failing test named. Six hundred and fifty-six arms of that timer put CI
 * reliably over the line while an idle laptop stayed under it, so the local
 * suite was green and CI was not.
 */
let editor: Editor;

beforeAll(async () => {
    editor = await makeCorpusEditor("");
});

afterAll(async () => {
    await editor.destroy();
});

/** Every block construct the editor can put inside a list item, written at the
 * item's content indent so the loose fixture below parses as item content.
 *
 * Keep this exhaustive. The two types added last — a Notion `<aside>` and a
 * footnote definition — were omitted from the first version of this file, and
 * both turned out to be broken as left siblings while the suite reported
 * "every ordered pair": the aside swallowed all six heads tried against it. A
 * matrix that names its own completeness has to earn it. */
const BLOCKS: Array<[name: string, source: string]> = [
    ["a paragraph", "  alpha text"],
    ["a table", "  | x | y |\n  | - | - |\n  | 9 | 8 |"],
    ["a bullet list", "  - sub one\n  - sub two"],
    ["an ordered list", "  1. sub one\n  2. sub two"],
    // Starting at anything but 1 is a DIFFERENT construct to the parser, not a
    // spelling of the row above: CommonMark lets an ordered list interrupt a
    // paragraph only when it starts at 1, so this one cannot begin a block from
    // an absorbed position while `1.` can (MAR-327). Adding this one row turned
    // up SIXTEEN broken cells while the file reported "every ordered pair" —
    // the third time (after the Notion aside and the footnote definition named
    // above) that a matrix claiming its own completeness had to earn it again.
    ["an ordered list not starting at 1", "  5. five\n  6. six"],
    ["a task list", "  - [ ] todo\n  - [x] done"],
    ["a blockquote", "  > quoted"],
    ["a callout", "  > [!NOTE]\n  > careful"],
    ["an ATX heading", "  ## Head"],
    ["a setext heading", "  Head\n  ===="],
    ["a fenced code block", "  ```js\n  const x = 1;\n  ```"],
    ["an unlabelled code block", "  ```\n  plain code\n  ```"],
    ["a thematic break", "  ---"],
    ["a math block", "  $$\n  a=b\n  $$"],
    ["raw HTML", "  <div>raw</div>"],
    ["a Notion aside", "  <aside>\n  note body\n  </aside>"],
    ["a link definition", "  [ref]: https://x.com"],
    ["a footnote definition", "  [^1]: a footnote"],
    ["a container directive", "  :::note\n  body\n  :::"],
];

/**
 * The outer bullet is `*`, not `-`, for one reason: `- ---` is a THEMATIC BREAK
 * (three dashes with spaces between them), so an item whose first block is a
 * dash rule dissolved into a top-level `hr` and the fixture held no list at all.
 * `itemShape` then compared `"<no item>"` to itself and sixteen cells asserted
 * nothing. `* ---` mixes marker characters, so it is a bullet holding a rule.
 *
 * A `*` bullet is otherwise inert here: the list's `marker` attr is preserved
 * through serialization (MAR-16), so it round-trips as itself, and nothing under
 * test is about the marker.
 */
const OUTER_BULLET = "*";

/**
 * What precedes the pair inside the item. Both are needed, and the second is
 * the one that pins the design: Markdown has no per-gap spacing inside an item,
 * so the serializer has to answer for the ITEM rather than for the gap it was
 * asked about. With only two blocks the two answers coincide — a three-block
 * item is the smallest fixture that can tell them apart, and it is also the
 * exact shape MAR-279 was reported in (a table pasted into the middle of an
 * item's text, splitting its paragraph around the table).
 */
const LEADS: Array<[name: string, source: string]> = [
    ["alone in the item", ""],
    ["after a paragraph", "  lead text\n\n"],
];

// No pair is currently expected to fail, so there is no KNOWN_GAPS set. The
// twelve `raw HTML` cells that used to live here — asserted INVERTED, the
// `pasteMatrix.test.ts` discipline — were MAR-296: a PARAGRAPH whose text opens
// an HTML block swallows every following line up to the next blank, whatever
// construct that line belongs to. The serializer now answers that from the
// paragraph's serialized BYTES rather than from its node type
// (`opensRawHtmlBlock` in webview/serialization.ts), and the second describe
// block below pins the other half of the fix: a paragraph that merely CONTAINS
// inline HTML must still keep its item tight.

/** Rebuild a document with every list and list item forced tight, so the pair
 * under test sits in an item whose `spread` is false. `blankBefore` is cleared
 * with it: that attr pins the gap BETWEEN items to what the source had
 * (MAR-194), and the loose fixture would otherwise carry it in. */
function forceTight(node: ProseNode): ProseNode {
    if (node.isText) return node;
    const children: ProseNode[] = [];
    node.content.forEach((child) => children.push(forceTight(child)));
    const name = node.type.name;
    const attrs = name === "bullet_list" || name === "ordered_list" || name === "list_item"
        ? { ...node.attrs, spread: false, blankBefore: null }
        : node.attrs;
    return node.type.create(attrs, children.length ? children : null, node.marks);
}

/** The type names of the first list item's flow children. */
function itemShape(doc: ProseNode): string {
    const item = doc.firstChild?.firstChild;
    if (!item) return "<no item>";
    const names: string[] = [];
    item.content.forEach((child) => names.push(child.type.name));
    return names.join(",");
}

describe("blank-line spacing inside a tight list item", () => {
    for (const [leadName, lead] of LEADS)
    for (const [firstName, first] of BLOCKS) {
        for (const [secondName, second] of BLOCKS) {
            it(`${firstName} followed by ${secondName}, ${leadName}, should survive a reopen`, async () => {
                // Arrange: the blocks, authored loose (the only form Markdown
                // can express), then rebuilt tight.
                const body = `${lead}${first}\n\n${second}\n`;
                const loose = `${OUTER_BULLET}${body.slice(1)}`;
                {
                    // Act.
                    const result = editor.action((ctx) => {
                        const parsed = ctx.get(parserCtx)(loose);
                        if (!parsed) return null;
                        const tight = forceTight(parsed);
                        const serialized = ctx.get(serializerCtx)(tight);
                        const reopened = ctx.get(parserCtx)(serialized);
                        return {
                            serialized,
                            reserialized: reopened ? ctx.get(serializerCtx)(reopened) : null,
                            want: itemShape(tight),
                            got: reopened ? itemShape(reopened) : "<reparse failed>",
                        };
                    });

                    // Assert.
                    expect(result, "the fixture should parse").not.toBeNull();
                    const { serialized, reserialized, want, got } = result!;
                    // C. The reopened item holds the same blocks.
                    expect(got, `blocks in the item, from ${JSON.stringify(serialized)}`).toBe(want);
                    // B. Round-trip stable.
                    expect(reserialized, "reserialization of the saved document").toBe(serialized);
                }
            });
        }
    }
});

/**
 * The other half of MAR-296, which the matrix above cannot see.
 *
 * Every one of these parses to the SAME node shape — a paragraph whose first
 * child is an `html` node — so the heuristic the serializer could have used
 * ("first child is html") does not tell them apart. Only the serialized first
 * line does: `<div>…` and a lone `<span>` open a CommonMark HTML block that runs
 * to the next blank, while `<span>x</span> then text`, `<pre>x</pre>` and
 * `<!-- c -->` open none that survives the line.
 *
 * Both directions are asserted, and each pins a different half of the fix:
 * an OPENING paragraph must gain the blank (the matrix's twelve `raw HTML`
 * cells, restated here for the shapes the matrix has no `BLOCKS` entry for), and
 * a non-opening one must NOT — an over-fire would turn every item with inline
 * HTML plus a sublist loose, which is a far larger blast radius than the bug.
 */
const HTML_PARAGRAPHS: Array<[name: string, source: string, opensBlock: boolean]> = [
    // Condition 6 — a block-level tag name. Ends only at a blank line, so the
    // closing `</div>` on the same line does not help.
    ["a div block", "<div>raw</div>", true],
    // Condition 7 — a complete tag alone on the line. It cannot INTERRUPT a
    // paragraph, but a paragraph's first line is a block start, not an
    // interruption, so it opens one here.
    ["a lone unknown tag", "<span>", true],
    ["a lone closing tag", "</section>", true],
    // Condition 1, met on its own start line.
    ["a closed raw-text element", "<pre>x</pre>", false],
    // Condition 2, likewise.
    ["a closed comment", "<!-- c -->", false],
    // Condition 4, likewise (`>` is its end condition).
    ["a declaration", "<!DOCTYPE html>", false],
    // No condition at all: `span` and `b` are not block tags, and neither line
    // is a lone tag.
    ["inline html then prose", "<span>x</span> then text", false],
    ["an inline bold lead-in", "<b>bold</b> lead-in", false],
];

describe("a paragraph whose text opens an HTML block", () => {
    for (const [name, source, opensBlock] of HTML_PARAGRAPHS) {
        it(`${name} should ${opensBlock ? "force the item loose" : "keep the item tight"}`, async () => {
            // Arrange.
            const loose = `${OUTER_BULLET} ${source}\n\n  ## Head\n`;
            {
                // Act.
                const result = editor.action((ctx) => {
                    const parsed = ctx.get(parserCtx)(loose);
                    if (!parsed) return null;
                    const tight = forceTight(parsed);
                    const serialized = ctx.get(serializerCtx)(tight);
                    const reopened = ctx.get(parserCtx)(serialized);
                    return {
                        serialized,
                        reserialized: reopened ? ctx.get(serializerCtx)(reopened) : null,
                        want: itemShape(tight),
                        got: reopened ? itemShape(reopened) : "<reparse failed>",
                    };
                });

                // Assert.
                expect(result, "the fixture should parse").not.toBeNull();
                const { serialized, reserialized, want, got } = result!;
                expect(want, "the fixture should hold two blocks in one item")
                    .toBe("paragraph,heading");
                expect(got, `blocks in the item, from ${JSON.stringify(serialized)}`).toBe(want);
                expect(reserialized, "reserialization of the saved document").toBe(serialized);
                expect(
                    serialized.includes("\n\n"),
                    `blank line inside the item, from ${JSON.stringify(serialized)}`,
                ).toBe(opensBlock);
            }
        });
    }
});
