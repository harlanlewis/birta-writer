/**
 * Inserting a horizontal rule must not destroy the block it is invoked in
 * (MAR-304).
 *
 * The published `insertHorizontalRule` command is reachable from the toolbar,
 * the slash menu (`/divider`) and the command palette. It used to delegate to
 * Milkdown's `insertHrCommand`, which builds the rule with
 * `tr.replaceSelectionWith(hr)` — and a `list_item` is `paragraph block*`, so a
 * rule can never be an item's FIRST child. ProseMirror hoisted the insertion
 * out of the item and deleted it; in an emptied TOP-LEVEL item the follow-up
 * `tr.insert(from, paragraph)` resolved a position the hoist had already
 * invalidated and threw a RangeError.
 *
 * These are INVARIANTS rather than expected-output assertions, because the
 * author's model of the output is exactly what missed the bug the first time:
 * the repo's existing coverage (`editorCommands.test.ts`) asserted only that
 * the command KEY was called, which stayed green through every one of these
 * failures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { commandsCtx, editorViewCtx, Editor, rootCtx, defaultValueCtx, parserCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { TextSelection } from "../pm";
import type { Node } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { insertHorizontalRuleCommand } from "../plugins/horizontalRule";

/**
 * One editor for the whole file: `Editor.create()` arms a Milkdown timer that
 * `destroy()` does not clear, so an editor per case leaves one pending timer
 * per case and any that fires after teardown counts as an unhandled error.
 */
let editor: Editor;

beforeAll(async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, "");
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(insertHorizontalRuleCommand)
        .create();
});

afterAll(async () => {
    await editor?.destroy();
});

/** Replace the whole document with `markdown`, and return the live view. */
function load(markdown: string) {
    const view = editor.ctx.get(editorViewCtx);
    const doc = editor.ctx.get(parserCtx)(markdown) as Node;
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
    return view;
}

/** Every text string in the document, in order. */
function texts(doc: Node): string[] {
    const out: string[] = [];
    doc.descendants((n) => {
        if (n.isText && n.text) out.push(n.text);
        return true;
    });
    return out;
}

/** Node type names, in order. */
function kinds(doc: Node): string[] {
    const out: string[] = [];
    doc.descendants((n) => {
        if (!n.isText) out.push(n.type.name);
        return true;
    });
    return out;
}

function serialize(): string {
    return editor.action(getMarkdown());
}

/**
 * Put the caret at the end of the last occurrence of `needle`, optionally
 * deleting that text first so the caret sits in an EMPTIED block — which is
 * the shape the ticket reported and the only one that crashed.
 */
function caretAt(view: ReturnType<typeof load>, needle: string, empty: boolean) {
    let pos = -1;
    view.state.doc.descendants((n, p) => {
        if (n.isText && n.text === needle) pos = p + needle.length;
        return true;
    });
    // The probe checking it hit what it aimed at: a caret that never landed
    // would leave every assertion below passing on a document the gesture
    // never produced.
    if (pos < 0) throw new Error(`no text node "${needle}" in ${JSON.stringify(serialize())}`);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    if (empty) {
        view.dispatch(view.state.tr.delete(pos - needle.length, pos));
    }
    if (!view.state.selection.$from.parent.isTextblock) {
        throw new Error("caret did not land in a textblock");
    }
}

function insertRule() {
    const ran = editor.action((ctx) => ctx.get(commandsCtx).call(insertHorizontalRuleCommand.key));
    // The probe checking the gesture happened: a command that declined leaves
    // the assertions below inspecting an untouched document.
    if (!ran) throw new Error("insertHorizontalRule declined — the gesture did not happen");
}

type Case = { label: string; src: string; needle: string; empty?: boolean };

const CASES: Case[] = [
    { label: "a plain paragraph", src: "hello\n", needle: "hello" },
    { label: "a top-level list item", src: "- x\n", needle: "x" },
    { label: "an emptied top-level list item", src: "- x\n", needle: "x", empty: true },
    { label: "a nested list item", src: "- normal\n  - x\n", needle: "x" },
    { label: "an emptied nested list item", src: "- normal\n  - x\n", needle: "x", empty: true },
    { label: "a nested ordered list item", src: "1. normal\n   1. x\n", needle: "x" },
    { label: "a blockquote", src: "> quoted\n", needle: "quoted" },
    { label: "a list item inside a blockquote", src: "> - x\n", needle: "x" },
];

describe("inserting a horizontal rule", () => {
    for (const c of CASES) {
        describe(c.label, () => {
            it("should keep every surrounding block and its text", () => {
                // Arrange
                const view = load(c.src);
                const before = kinds(view.state.doc);
                const survivors = texts(view.state.doc).filter((t) => !(c.empty && t === c.needle));
                caretAt(view, c.needle, c.empty ?? false);

                // Act
                insertRule();

                // Assert — no container the caret was inside may disappear. The
                // reported bug deleted the nested list outright.
                const after = kinds(view.state.doc);
                for (const kind of new Set(before)) {
                    expect(
                        after.filter((k) => k === kind).length,
                        `${kind} count dropped`,
                    ).toBeGreaterThanOrEqual(before.filter((k) => k === kind).length);
                }
                expect(texts(view.state.doc)).toEqual(survivors);
                expect(after).toContain("hr");
            });

            it("should produce a document that survives a save and reopen", () => {
                // Arrange
                const view = load(c.src);
                caretAt(view, c.needle, c.empty ?? false);

                // Act
                insertRule();
                const saved = serialize();

                // Assert — round-trip stability. Corrupt Markdown reparses into
                // something else, generically, with no per-construct rule to
                // maintain; this is the invariant that caught the stray empty
                // paragraph the old command wrote in EVERY case, which
                // serialized to blank lines that no reparse returned.
                const reopened = editor.ctx.get(parserCtx)(saved) as Node;
                expect(kinds(reopened)).toEqual(kinds(view.state.doc));
                expect(texts(reopened)).toEqual(texts(view.state.doc));
                reopened.check();
            });
        });
    }

    it("an emptied top-level list item should not throw (it raised a RangeError)", () => {
        // Arrange
        const view = load("- x\n");
        caretAt(view, "x", true);

        // Act / Assert — the old command called `tr.insert(from, paragraph)`
        // with a position its own `replaceSelectionWith` had just invalidated.
        expect(() => insertRule()).not.toThrow();
    });

    it("a non-empty selection should keep the selected text", () => {
        // Arrange
        const view = load("hello there\n");
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
        expect(view.state.doc.textBetween(1, 6)).toBe("hello");

        // Act
        insertRule();

        // Assert — the old command replaced the selection with the rule.
        expect(texts(view.state.doc)).toEqual(["hello there"]);
    });
});
