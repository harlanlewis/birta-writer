/**
 * Splitting a soft-wrapped paragraph must actually reach disk, and undoing the
 * split must reach it too (MAR-290).
 *
 * Soft-wrapped source (`alpha\nbeta`) is ONE paragraph in the editor. Splitting
 * it in two changes no significant line — only the blank run between them — so
 * the minimal-diff edit script came back all `keep`s and the merge returned the
 * saved bytes unchanged. The user saw two paragraphs, saved, reopened, and had
 * one again, with no message. Its mirror, joining two paragraphs back into one,
 * is the same blind spot from the other side; the ordinary way to reach it is
 * Cmd+Z after a split that has already been saved.
 *
 * Both halves of the fix are exercised here: the engine no longer short-circuits
 * an all-keeps script (`packages/minimal-diff`), and markdown's profile answers
 * `blankSplitsBlock` for the lazy-continuation case, not just for quotes.
 *
 * The assertion is an INVARIANT, not an expected string (AGENTS.md, "Choosing
 * what to assert"): the merged bytes must reparse to the same document as the
 * serializer's raw output would. That is exactly what this layer promises — it
 * preserves the user's FORMATTING in regions they did not touch, and is never
 * allowed to change what the file MEANS. It holds for every shape, position and
 * gesture without the test re-deriving the serializer's spacing rules.
 *
 * Deliberately not "reparses to the document the editor holds", which is the
 * stricter-looking assertion and the wrong one: it fails on states the editor
 * can hold but Markdown cannot express, whoever writes the bytes. Splitting with
 * the caret BEFORE the soft break leaves the first paragraph ending in one, and
 * `alpha\n\n\nbeta` reparses without it — the merge reproduced the serializer's
 * bytes exactly and would have been failed for the serializer's round trip.
 * Anchoring to the raw output keeps the subject of the test the merge layer.
 * It still catches the bug: before the fix the merged bytes reparse to ONE
 * paragraph while the raw output reparses to two.
 *
 * What it deliberately does NOT check is minimality — it would pass if the
 * merge wrote the serializer's output wholesale and reformatted the whole file.
 * That half is `roundTripCorpus`'s invariants A and B (a zero-edit save is
 * byte-identical; an edit keeps every other line verbatim), which this suite is
 * the complement of rather than a substitute for. Neither is sufficient alone:
 * A and B pin the bytes and are blind to meaning, this pins the meaning and is
 * blind to the bytes.
 *
 * The session is modelled the way `webview/editor.ts` runs one: protection is
 * computed ONCE from the file as loaded, while the saved bytes advance with
 * every merge. So the undo step diffs the original editor state against the
 * post-split bytes, with load-time protection — exactly what a real Cmd+Z after
 * a save does.
 */
import { describe, it, expect, afterEach } from "vitest";
import { getMarkdown } from "@milkdown/utils";
import type { Editor } from "@milkdown/core";
import type { EditorView } from "../pm";
import { TextSelection } from "../pm";
import { historyKeymapPlugin, historyPlugin } from "../plugins/history";
import {
    applyMinimalChanges,
    computeRoundTripProtection,
    markdownProfile,
} from "../utils/minimalDiff";
import { editorView, makeCorpusEditor } from "./helpers/moveFuzz";

let open: Editor[] = [];

async function makeEditor(markdown: string): Promise<Editor> {
    const editor = await makeCorpusEditor(markdown, [historyPlugin, historyKeymapPlugin]);
    open.push(editor);
    return editor;
}

afterEach(async () => {
    await Promise.all(open.map((editor) => editor.destroy()));
    open = [];
});

function pressKey(view: EditorView, init: KeyboardEventInit): void {
    view.someProp("handleKeyDown", (handler) =>
        handler(view, new KeyboardEvent("keydown", init)),
    );
}

/** What `md` MEANS: the document it reparses to, as markdown again. Two texts
 *  with the same reparse differ only in formatting the parser discards. */
async function meaningOf(md: string): Promise<string> {
    const editor = await makeEditor(md);
    expect(() => editorView(editor).state.doc.check()).not.toThrow();
    return editor.action(getMarkdown());
}

/** The first soft break in the document: the position of its `\n`, or -1.
 *  A soft-wrapped paragraph is exactly a textblock whose text holds one.
 *
 *  `textContent` offsets equal document offsets only while every inline node in
 *  the block is text — true of every shape below, and the reason none of them
 *  carries an image or inline math before its break. A shape that did would
 *  land the caret in the wrong place silently, so add one only with that in
 *  mind; the `exercised` guard at the end catches it becoming a no-op, not it
 *  splitting somewhere else. */
function softBreakAt(view: EditorView): number {
    let at = -1;
    view.state.doc.descendants((node, pos) => {
        if (at < 0 && node.isTextblock) {
            const idx = node.textContent.indexOf("\n");
            if (idx >= 0) at = pos + 1 + idx;
        }
    });
    return at;
}

interface Gesture {
    name: string;
    /** Caret/selection to set before Enter, given the `\n`'s position. */
    select(view: EditorView, breakAt: number): void;
}

/**
 * Where the caret sits when a user splits at a soft wrap. All three are the
 * same intent and they produce DIFFERENT serializer output — the caret before
 * the break leaves the first paragraph ending in one, which the serializer
 * renders as a wider blank run — so they are not redundant.
 */
const GESTURES: Gesture[] = [
    {
        name: "Enter at the start of the wrapped line",
        select: (view, at) =>
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at + 1))),
    },
    {
        name: "Enter at the end of the first line",
        select: (view, at) =>
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at))),
    },
    {
        name: "Enter over the selected line break",
        select: (view, at) =>
            view.dispatch(
                view.state.tr.setSelection(TextSelection.create(view.state.doc, at, at + 1)),
            ),
    },
];

/**
 * Every place a soft-wrapped paragraph can sit. Container shapes matter because
 * laziness reaches through container boundaries — the blank the split needs is
 * decided relative to the item's own content column, not column 0 — and the
 * indents below (four spaces, a tab) are the ones CommonMark's ` {0,3}` bound
 * would read as indented code (MAR-289's `containerContent`).
 */
const SHAPES: Array<{ name: string; doc: string }> = [
    { name: "top-level paragraph", doc: "bar\n\nalpha\nbeta\n\nfoo\n" },
    { name: "paragraph opening the document", doc: "alpha\nbeta\n\nfoo\n" },
    { name: "paragraph ending the document", doc: "bar\n\nalpha\nbeta\n" },
    { name: "the whole document", doc: "alpha\nbeta\n" },
    { name: "tight bullet item", doc: "bar\n\n- one\n- alpha\n  beta\n- three\n\nfoo\n" },
    { name: "loose bullet item", doc: "bar\n\n- one\n\n- alpha\n  beta\n\n- three\n\nfoo\n" },
    // Partly loose: mdast has ONE `spread` boolean per list, so this parses as
    // loose and the item the split creates has no recorded gap of its own to
    // replay (plugins/list.ts, MAR-194/MAR-210). It is the shape where the
    // sibling rule below has to choose a gap rather than copy one.
    {
        name: "partly-loose bullet item",
        doc: "bar\n\n- one\n- alpha\n  beta\n- three\n\n- four\n\nfoo\n",
    },
    { name: "ordered item", doc: "bar\n\n1. one\n2. alpha\n   beta\n3. three\n\nfoo\n" },
    { name: "last item of a list", doc: "bar\n\n- one\n- alpha\n  beta\n\nfoo\n" },
    { name: "sublist item indented four spaces", doc: "bar\n\n- one\n    - alpha\n      beta\n- three\n\nfoo\n" },
    { name: "tab-indented outline item", doc: "bar\n\n- one\n\t- alpha\n\t  beta\n- three\n\nfoo\n" },
    { name: "blockquote", doc: "bar\n\n> alpha\n> beta\n\nfoo\n" },
    { name: "blockquote inside a list item", doc: "bar\n\n- one\n  > alpha\n  > beta\n\nfoo\n" },
    { name: "paragraph under a heading", doc: "## head\n\nalpha\nbeta\n\nfoo\n" },
    { name: "paragraph before a fence", doc: "alpha\nbeta\n\n```js\ncode()\n```\n" },
];

/**
 * Combinations that fail TODAY, each with the ticket that owns it — marked
 * `it.fails`, never skipped, so the entry errors the moment its bug is fixed
 * and the list can only shrink (AGENTS.md; `KNOWN_GAPS` in pasteMatrix).
 *
 * Empty since MAR-293, whose two entries (`loose bullet item`, the first and
 * third gestures) came out when `areListSiblings` gave the merge a rule for
 * list SPREAD. Keys are `shape: gesture`, not `shape` — MAR-293's middle
 * gesture passed while the other two failed, and that asymmetry is real.
 */
const KNOWN_GAPS: Record<string, string> = {};

describe("splitting a soft-wrapped paragraph", () => {
    let splits = 0;
    let undos = 0;

    for (const shape of SHAPES) {
        for (const gesture of GESTURES) {
            const gap = KNOWN_GAPS[`${shape.name}: ${gesture.name}`];
            const label = gap
                ? `${shape.name}: ${gesture.name} should survive the save, and so should its undo [known failure: ${gap}]`
                : `${shape.name}: ${gesture.name} should survive the save, and so should its undo`;
            (gap ? it.fails : it)(label, async () => {
                const original = shape.doc;

                // Load: protection is computed once, from the file as opened.
                const editor = await makeEditor(original);
                const view = editorView(editor);
                const atLoad = editor.action(getMarkdown());
                const protection = computeRoundTripProtection(original, atLoad);
                let saved = original;

                const breakAt = softBreakAt(view);
                expect(breakAt, `${shape.name} has no soft-wrapped paragraph`).toBeGreaterThan(0);

                // ── The split ───────────────────────────────────────────────
                gesture.select(view, breakAt);
                pressKey(view, { key: "Enter" });
                const afterSplit = editor.action(getMarkdown());
                if (afterSplit === atLoad) return; // the gesture was a no-op here
                splits++;

                expect(() => view.state.doc.check()).not.toThrow();
                saved = applyMinimalChanges(saved, afterSplit, protection);

                // THE invariant: the bytes that land on disk mean the same
                // document as the serializer's raw output.
                expect(
                    await meaningOf(saved),
                    `split lost on save\n  original = ${JSON.stringify(original)}\n  editor   = ${JSON.stringify(afterSplit)}\n  saved    = ${JSON.stringify(saved)}`,
                ).toBe(await meaningOf(afterSplit));

                // ── Cmd+Z, then save again ──────────────────────────────────
                // The editor goes back to one paragraph while the file now
                // holds two. Undoing an edit the user already saved must reach
                // disk as surely as making it did.
                pressKey(view, { key: "z", ctrlKey: true });
                const afterUndo = editor.action(getMarkdown());
                if (afterUndo !== atLoad) return; // undo did not restore the load state
                undos++;

                saved = applyMinimalChanges(saved, afterUndo, protection);

                expect(
                    await meaningOf(saved),
                    `undo of the split lost on save\n  editor = ${JSON.stringify(afterUndo)}\n  saved  = ${JSON.stringify(saved)}`,
                ).toBe(await meaningOf(afterUndo));
            });
        }
    }

    it("the matrix should actually have exercised both directions", () => {
        // Every case above returns early when its gesture does not apply, so
        // without this the whole suite could silently degrade to no-ops. The
        // undo count is load-bearing beyond that: `Mod-z` resolves to Ctrl only
        // because jsdom reports a non-Mac platform, and if that ever changes
        // every undo becomes a silent no-op and the join direction stops being
        // tested at all. This is what would say so.
        expect(splits, "no split gesture reached the merge").toBeGreaterThan(30);
        expect(undos, "no undo reached the merge").toBeGreaterThan(30);
    });
});

/**
 * A `$$` math fence is a block delimiter, not paragraph prose — the fact
 * `BLOCK_DELIMITER_RE` encodes.
 *
 * Reading it as prose was invisible while an all-keeps merge short-circuited;
 * once it does not, the lazy-continuation rules fire on `$$` lines and rewrite
 * files nobody edited. The empty-block case is the destructive one: the blank
 * BETWEEN the two delimiters is the block's entire content, and the join rule
 * deleted it. `fixtures/math-variants.md` gates that one through corpus
 * invariant A; the two glue cases below have no fixture and would otherwise be
 * ungated.
 */
describe("a zero-edit save around a math fence", () => {
    const DOCS = [
        { name: "prose glued under a closing `$$`", doc: "$$\nx\n$$\npara\n" },
        { name: "an opening `$$` glued under prose", doc: "para\n$$\nx\n$$\n" },
        { name: "an empty math block", doc: "Empty block below:\n\n$$\n\n$$\n" },
        { name: "a blank-separated math block", doc: "$$\nx\n$$\n\npara\n" },
    ];

    for (const { name, doc } of DOCS) {
        it(`${name} should be byte-identical`, async () => {
            const editor = await makeEditor(doc);
            const serialized = editor.action(getMarkdown());
            const protection = computeRoundTripProtection(doc, serialized);

            expect(applyMinimalChanges(doc, serialized, protection)).toBe(doc);
        });
    }

    // Only a BARE `$$` run is a delimiter. `$$x$$` is inline math, so a line
    // beginning with it is ordinary paragraph text — it leaves a paragraph open
    // and can be absorbed as continuation, and both predicates must still say
    // so. This cannot be reached through a merge the way the cases above are:
    // the serializer rewrites `$$x$$` to `$x$`, so such a line is never an
    // all-keeps pairing. The predicates are the unit, and their contract is the
    // boolean, so they are asserted directly.
    it("a line starting with inline math should still be paragraph text", () => {
        expect(markdownProfile.glueChangesConstruct("alpha", "$$x$$ beta")).toBe(true);
        expect(markdownProfile.blankSplitsBlock("alpha", "$$x$$ beta")).toBe(true);
        expect(markdownProfile.glueChangesConstruct("$$x$$ alpha", "beta")).toBe(true);
    });

    it("a bare `$$` run should be a delimiter in both directions", () => {
        expect(markdownProfile.glueChangesConstruct("alpha", "$$")).toBe(false);
        expect(markdownProfile.blankSplitsBlock("alpha", "$$")).toBe(false);
        expect(markdownProfile.glueChangesConstruct("$$", "alpha")).toBe(false);
        expect(markdownProfile.blankSplitsBlock("$$", "alpha")).toBe(false);
    });
});
