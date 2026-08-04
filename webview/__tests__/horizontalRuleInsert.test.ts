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
import { NodeSelection, TextSelection } from "../pm";
import type { Node } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { insertHorizontalRuleCommand } from "../plugins/horizontalRule";

/**
 * One editor for the whole file: `Editor.create()` arms a Milkdown timer that
 * `destroy()` does not clear, so an editor per case leaves one pending timer
 * per case and any that fires after teardown counts as an unhandled error.
 *
 * This editor deliberately does NOT register `trailingHrParagraphPlugin`, which
 * production does (`editor.ts`). That plugin appends an empty paragraph after a
 * rule that ends the document, as a place to put the caret — and Markdown has no
 * way to write an empty trailing paragraph, so with it registered a doc-final
 * rule reads `paragraph, hr, paragraph` live and `paragraph, hr` on reparse
 * (`"hello\n\n---\n\n"`). That divergence is the affordance, not a loss: reopening
 * re-adds it. Registering the plugin here would make the round-trip invariant
 * below assert something false by design, so the omission is the point — but it
 * does mean this file measures the command, not the composed pair. A rule
 * inserted mid-document is byte-exact either way (measured).
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

/**
 * `consumes` marks the one shape where a block legitimately disappears: an
 * emptied top-level paragraph is a placeholder the rule takes over by design,
 * so the paragraph count drops by exactly one. Everywhere else a dropped block
 * is the bug under test, which is why the exemption is a per-case opt-in rather
 * than a softening of the invariant.
 */
type Case = { label: string; src: string; needle: string; empty?: boolean; consumes?: string };

const CASES: Case[] = [
    { label: "a plain paragraph", src: "hello\n", needle: "hello" },
    // The shape the empty-textblock takeover branch exists FOR. Every other
    // emptied case here is a list item, where that branch changes no bytes at
    // all — so without this row the branch could be deleted outright and the
    // file stayed green, while a caret in an emptied top-level paragraph went
    // back to writing `"a\n\n\n\n---\n\n"` (the blank-line churn this fix
    // removed) instead of `"a\n\n---\n\n"`.
    { label: "an emptied top-level paragraph", src: "a\n\nhello\n", needle: "hello", empty: true, consumes: "paragraph" },
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
                    const allowed = kind === c.consumes ? 1 : 0;
                    expect(
                        after.filter((k) => k === kind).length + allowed,
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

    it("the caret should land past the rule, not before it", () => {
        // Arrange — a following block, so there is somewhere to land without
        // `trailingHrParagraphPlugin` (which this editor omits, see the header).
        const view = load("hello\n\nafter\n");
        caretAt(view, "hello", false);

        // Act
        insertRule();

        // Assert — the whole caret-placement half of the command was untested:
        // dropping `Selection.findFrom`, or resolving it at the wrong position,
        // changed nothing any assertion could see. The old command's landing
        // paragraph was inserted BEFORE the rule, so "past it" is the property
        // that distinguishes them.
        const hrPos = view.state.doc.resolve(0).nodeAfter
            ? view.state.doc.content.findIndex(0).index
            : -1;
        void hrPos;
        let rulePos = -1;
        view.state.doc.descendants((n, pos) => {
            if (n.type.name === "hr") rulePos = pos;
            return true;
        });
        expect(rulePos).toBeGreaterThanOrEqual(0);
        expect(view.state.selection.from).toBeGreaterThan(rulePos);
    });

    it.each([
        ["the whole document", "x\n"],
        ["a trailing empty paragraph", "Some notes.\n\nx\n"],
        ["an empty paragraph in a blockquote", "> Z\n>\n> x\n"],
    ])("the caret should be typeable after inserting into %s", (_label, src) => {
        // Arrange — the `/divider` path: `slashMenu.apply` deletes the typed
        // text BEFORE running the command, so the block is always empty and the
        // rule always ends whatever contains it. Markdown cannot spell a
        // trailing empty paragraph, so the emptiness has to be made by editing
        // here exactly as the slash menu makes it.
        const view = load(src);
        caretAt(view, "x", true);
        expect(view.state.selection.$from.parent.content.size).toBe(0);

        // Act
        insertRule();

        // Assert — the caret must be in a textblock, not on the rule. Left
        // unset, ProseMirror maps the old caret onto a NodeSelection over the
        // new rule and the next keystroke replaces it: the user picks
        // "Horizontal Rule", types, and the rule is gone.
        expect(view.state.selection).toBeInstanceOf(TextSelection);
        expect(view.state.selection.$from.parent.isTextblock).toBe(true);
        expect(kinds(view.state.doc)).toContain("hr");

        // And typing must leave the rule alone. Where nothing follows the rule
        // the caret lands in the block ABOVE it, so the character joins that
        // block's text rather than standing alone — what matters is that it
        // landed in the document and the rule survived.
        view.dispatch(view.state.tr.insertText("A"));
        expect(kinds(view.state.doc)).toContain("hr");
        expect(texts(view.state.doc).join("")).toContain("A");
    });

    it.each([
        ["an empty heading keeps its level", "# doc\n\n## \n\nafter\n", "heading"],
        ["an empty code block keeps its language", "# doc\n\n```js\n```\n\nafter\n", "code_block"],
    ])("%s rather than being replaced by the rule", (_label, src, kind) => {
        // Arrange — both are textblocks, and both carry state their emptiness
        // hides. Taking them over dropped the level / the language silently.
        const view = load(src);
        let pos = -1;
        view.state.doc.descendants((n, p) => {
            if (pos < 0 && n.type.name === kind && n.content.size === 0) pos = p + 1;
            return true;
        });
        expect(pos, `probe found no empty ${kind}`).toBeGreaterThan(0);
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
        // COUNT, not presence: the heading fixture carries a second heading
        // (`# doc`), so `toContain("heading")` stayed green while the empty one
        // was being eaten — the assertion passing for the wrong reason.
        const before = kinds(view.state.doc).filter((k) => k === kind).length;

        // Act
        insertRule();

        // Assert
        expect(kinds(view.state.doc).filter((k) => k === kind)).toHaveLength(before);
        expect(kinds(view.state.doc)).toContain("hr");
    });

    it("a rule that is itself selected should not gain a second rule", () => {
        // Arrange — `horizontalRulePlugin`'s click handler puts a NodeSelection
        // on a rule, so this is a state a user reaches with the mouse.
        const view = load("a\n\n---\n\nb\n");
        let rulePos = -1;
        view.state.doc.descendants((n, pos) => {
            if (n.type.name === "hr") rulePos = pos;
            return true;
        });
        expect(rulePos).toBeGreaterThanOrEqual(0);
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, rulePos)));
        const before = kinds(view.state.doc).filter((k) => k === "hr").length;

        // Act — the command may decline; what it must not do is stack a second
        // rule on the one already selected. Starting the outward walk one depth
        // too high does exactly that.
        editor.action((ctx) => ctx.get(commandsCtx).call(insertHorizontalRuleCommand.key));

        // Assert
        expect(kinds(view.state.doc).filter((k) => k === "hr")).toHaveLength(before);
        expect(texts(view.state.doc)).toEqual(["a", "b"]);
    });
});

// ── The rule's own line is the only one that may change (MAR-307) ──────────
//
// The command's fix above is correct — no content is lost — but the shape it
// now leaves behind made the SERIALIZER re-spell lines the user never touched.
// With the item's leading paragraph empty, the rule collapses onto the marker
// line; `- ---` would reparse as a thematic break, so MAR-240's bullet switch
// fired and flipped the character for the WHOLE list, since a bullet belongs to
// a list rather than to an item:
//
//     - a          ->    - a
//       - x                * ---
//       - keep             * keep      <- never edited
//       - keep2            * keep2     <- never edited
//
// A rule character is per-node, so re-spelling the RULE instead costs exactly
// the line the rule is on — and that is the line the user just created.
// `respellCreatedRules` (plugins/sourceStyle.ts) does that when every colliding
// break is one the editor made; a break carrying source bytes still takes the
// flip, because re-spelling it would be the same churn one line at a time.
describe("inserting a rule into an emptied nested item", () => {
    /** The bullet character of every list line in `md`, in order. */
    const bullets = (md: string): string[] =>
        md.split("\n").flatMap((line) => {
            const m = /^\s*([-*+])(?: |$)/.exec(line);
            return m ? [m[1]!] : [];
        });

    it("should leave untouched sibling items spelled exactly as the file had them", () => {
        // Arrange
        const src = "- a\n  - x\n  - keep\n  - keep2\n";
        const view = load(src);
        caretAt(view, "x", true);

        // Act
        insertRule();
        const saved = serialize();

        // Assert — three `-` bullets on the untouched lines, plus the rule's own
        // marker line. Asserted as the FULL bullet sequence rather than as a
        // count, so a flip that happened to preserve the number of markers
        // cannot pass.
        expect(bullets(saved)).toEqual(["-", "-", "-", "-"]);
        expect(saved).toContain("  - keep\n");
        expect(saved).toContain("  - keep2\n");
        // …and the rule still nests, which is what the flip was protecting.
        const reopened = editor.ctx.get(parserCtx)(saved) as Node;
        expect(kinds(reopened).filter((k) => k === "bullet_list")).toHaveLength(2);
        expect(kinds(reopened)).toContain("hr");
        expect(kinds(reopened)).not.toContain("heading");
    });

    it("should write bytes that are stable across a second save", () => {
        // A spelling that oscillates rewrites the file every time the user
        // saves, which is the failure mode a per-node re-spelling could
        // introduce if the choice were not deterministic.
        const view = load("- a\n  - x\n  - keep\n");
        caretAt(view, "x", true);
        insertRule();
        const once = serialize();

        load(once);
        expect(serialize()).toBe(once);
    });

    it("should still flip the bullet when the colliding rule came from the file", () => {
        // The fallback, and the reason the re-spelling is all-or-nothing: a
        // break with recorded source bytes is MAR-16's to preserve, so the list
        // pays the flip rather than the rule paying a rewrite. No command here —
        // `-\n    ---` is the only way to author this shape (`- ---` is a
        // thematic break, not an item holding one), and it reaches the flip on a
        // ZERO-EDIT save.
        load("- a\n  - x\n  - keep\n  -\n    ---\n");
        const saved = serialize();

        // The recorded `---` still forces the list onto `*`.
        expect(bullets(saved)).toEqual(["-", "*", "*", "*"]);
        expect(saved).toContain("---");
        const reopened = editor.ctx.get(parserCtx)(saved) as Node;
        expect(kinds(reopened)).not.toContain("heading");
        expect(kinds(reopened).filter((k) => k === "bullet_list")).toHaveLength(2);
    });
});
