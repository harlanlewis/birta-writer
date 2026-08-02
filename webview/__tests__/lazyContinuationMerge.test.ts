/**
 * Turning a list item into a paragraph must actually produce a paragraph on
 * disk (MAR-289).
 *
 * The serializer was never wrong here — it emits `- two\n\nthree`. The
 * minimal-diff merge dropped that blank line: the lift reads as an in-place
 * replacement (one significant line changed, `- three` → `three`), so the
 * SAVED spacing won, and `- two\nthree` is not a list plus a paragraph. It is
 * one list item, because CommonMark absorbs a line that cannot start a block
 * as lazy continuation text of the open paragraph above it — across the
 * container boundary. Reopening the file showed the paragraph back inside the
 * list, or fused onto the previous item.
 *
 * The assertion is an INVARIANT, not an expected string: reparsing the merged
 * bytes must yield the document the editor holds. That holds no matter which
 * shape, position or gesture is under test, and it is what "the file means
 * what the screen showed" actually says. A per-case expected-output assertion
 * would only have re-stated the author's model of the serializer (AGENTS.md,
 * "Choosing what to assert").
 *
 * The gestures are the ones a user actually reaches for — Backspace at the
 * item's start, Shift+Tab, the toolbar/slash list toggle, and the block
 * menu's Turn into → Text — crossed with every list shape, at every position
 * in the list. e2e/lazyContinuation covers the same ground through real key
 * dispatch and the real save path in a real browser.
 */
import { describe, it, expect, afterEach } from "vitest";
import { getMarkdown } from "@milkdown/utils";
import type { Editor } from "@milkdown/core";
import type { EditorView } from "../pm";
import { TextSelection } from "../pm";
import { unwrapListTo } from "../components/blockMenu";
import { runEditorCommand } from "../editorCommands";
import { listAutoJoinPlugin, listEnterPlugin, listLiftPlugin } from "../plugins/list";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";
import { editorView, makeCorpusEditor } from "./helpers/moveFuzz";

const listPlugins = [listLiftPlugin, listEnterPlugin, listAutoJoinPlugin];

let open: Editor[] = [];

async function makeEditor(markdown: string): Promise<Editor> {
    const editor = await makeCorpusEditor(markdown, listPlugins);
    open.push(editor);
    return editor;
}

afterEach(async () => {
    await Promise.all(open.map((editor) => editor.destroy()));
    open = [];
});

/** Position just inside the textblock whose text is exactly `text`. */
function startOf(view: EditorView, text: string): number {
    let at = -1;
    view.state.doc.descendants((node, pos) => {
        if (at < 0 && node.isTextblock && node.textContent === text) at = pos + 1;
    });
    return at;
}

function caretAt(view: EditorView, text: string): boolean {
    const at = startOf(view, text);
    if (at < 0) return false;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
    return true;
}

function pressKey(view: EditorView, init: KeyboardEventInit): void {
    view.someProp("handleKeyDown", (handler) =>
        handler(view, new KeyboardEvent("keydown", init)),
    );
}

/** Position of the outermost list node containing `text`, or -1. */
function listAround(view: EditorView, text: string): number {
    const at = startOf(view, text);
    if (at < 0) return -1;
    const $at = view.state.doc.resolve(at);
    for (let depth = 1; depth <= $at.depth; depth++) {
        const name = $at.node(depth).type.name;
        if (name === "bullet_list" || name === "ordered_list") return $at.before(depth);
    }
    return -1;
}

interface Gesture {
    name: string;
    /** Returns false when the gesture does not apply to this document. */
    run(view: EditorView, target: string, editor: Editor): boolean;
}

const GESTURES: Gesture[] = [
    {
        name: "Backspace at the item's start",
        run: (view, target) => {
            if (!caretAt(view, target)) return false;
            pressKey(view, { key: "Backspace" });
            return true;
        },
    },
    {
        name: "Shift+Tab",
        run: (view, target) => {
            if (!caretAt(view, target)) return false;
            pressKey(view, { key: "Tab", shiftKey: true });
            return true;
        },
    },
    {
        name: "the toolbar/slash list toggle",
        run: (view, target, editor) => {
            if (!caretAt(view, target)) return false;
            const ordered = view.state.doc.resolve(startOf(view, target))
                .node(1).type.name === "ordered_list";
            runEditorCommand(ordered ? "toggleOrderedList" : "toggleBulletList", () => editor);
            return true;
        },
    },
    {
        name: "block menu Turn into → Text",
        run: (view, target) => {
            const pos = listAround(view, target);
            return pos >= 0 && unwrapListTo(view, pos, 0);
        },
    },
];

/**
 * Every list shape the fix has to hold for. `items` names the textblocks a
 * gesture may be aimed at — first, middle and last of each list.
 */
const SHAPES: Array<{ name: string; doc: string; items: string[] }> = [
    {
        name: "tight bullet list",
        doc: "bar\n\n- one\n- two\n- three\n\nfoo\n",
        items: ["one", "two", "three"],
    },
    {
        name: "tight ordered list",
        doc: "bar\n\n1. one\n2. two\n3. three\n\nfoo\n",
        items: ["one", "two", "three"],
    },
    {
        name: "task list",
        doc: "bar\n\n- [ ] one\n- [x] two\n- [ ] three\n\nfoo\n",
        items: ["one", "two", "three"],
    },
    {
        name: "loose bullet list",
        doc: "bar\n\n- one\n\n- two\n\n- three\n\nfoo\n",
        items: ["one", "two", "three"],
    },
    {
        name: "list with a nested sublist",
        doc: "bar\n\n- one\n- two\n  - deep\n- three\n\nfoo\n",
        items: ["one", "two", "deep", "three"],
    },
    // The sublist indents below are the ones CommonMark's ` {0,3}` bound
    // would read as indented code rather than as a nested item. Both are
    // ordinary in real files — four spaces is the common hand convention and
    // tabs are how a Logseq outline indents its whole block tree (MAR-131) —
    // and both were still broken after the first cut of the fix, because
    // `containerContent` bounded its marker prefix at three columns.
    {
        name: "sublist indented four spaces",
        doc: "bar\n\n- one\n- two\n    - deep\n- three\n\nfoo\n",
        items: ["one", "two", "deep", "three"],
    },
    {
        name: "tab-indented outline",
        doc: "bar\n\n- one\n- two\n\t- deep\n- three\n\nfoo\n",
        items: ["one", "two", "deep", "three"],
    },
    {
        name: "list ending the document",
        doc: "bar\n\n- one\n- two\n- three\n",
        items: ["one", "two", "three"],
    },
    {
        name: "list opening the document",
        doc: "- one\n- two\n- three\n\nfoo\n",
        items: ["one", "two", "three"],
    },
    {
        name: "single-item list",
        doc: "bar\n\n- one\n\nfoo\n",
        items: ["one"],
    },
    {
        name: "list with a `*` marker",
        doc: "bar\n\n* one\n* two\n* three\n\nfoo\n",
        items: ["one", "two", "three"],
    },
    {
        name: "list followed by a heading",
        doc: "bar\n\n- one\n- two\n- three\n\n## next\n",
        items: ["one", "two", "three"],
    },
];

describe("turning a list item into a paragraph", () => {
    let exercised = 0;

    for (const shape of SHAPES) {
        for (const gesture of GESTURES) {
            for (const target of shape.items) {
                it(`${shape.name}: ${gesture.name} on "${target}" should survive the save`, async () => {
                    const saved = shape.doc;
                    const baseline = await makeEditor(saved);
                    const protection = computeRoundTripProtection(
                        saved,
                        baseline.action(getMarkdown()),
                    );

                    const editor = await makeEditor(saved);
                    const view = editorView(editor);
                    const before = editor.action(getMarkdown());
                    if (!gesture.run(view, target, editor)) return; // not applicable here
                    const after = editor.action(getMarkdown());
                    if (after === before) return; // the gesture was a no-op
                    exercised++;

                    // The editor's own document is always well formed.
                    expect(() => view.state.doc.check()).not.toThrow();

                    const merged = applyMinimalChanges(saved, after, protection);

                    // THE invariant: what lands on disk reparses to the
                    // document the editor is showing. A dropped blank line
                    // between the list and the new paragraph fails here,
                    // because the paragraph reparses as list-item content.
                    const reopened = await makeEditor(merged);
                    expect(() => editorView(reopened).state.doc.check()).not.toThrow();
                    expect(
                        reopened.action(getMarkdown()),
                        `merged bytes reparse differently\n  saved  = ${JSON.stringify(saved)}\n  editor = ${JSON.stringify(after)}\n  merged = ${JSON.stringify(merged)}`,
                    ).toBe(after);
                });
            }
        }
    }

    it("the matrix should actually have exercised the gestures", () => {
        // Guards against the whole suite silently degrading to no-ops — every
        // case above returns early when its gesture does not apply.
        expect(exercised).toBeGreaterThan(40);
    });
});
