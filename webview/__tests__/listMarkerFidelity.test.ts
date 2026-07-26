/**
 * List source-style fidelity (MAR-218): a list's bullet character, ordered
 * delimiter, and numbering style survive a round trip instead of being
 * canonicalized to `-` / `1.` / incrementing numbers.
 *
 * Same wiring as sourceStyle.test.ts — the REAL Milkdown editor (real parser,
 * real remark-stringify, the production `pureCommonmark` +
 * `configureSerialization` stack) plus the real minimal-diff merge, no mocks.
 *
 * The reported bug is a marker fact being lost on lines the user never touched:
 * protection is all-or-nothing per region, so editing ANY item unprotects the
 * whole list and the canonical form wins on every untouched line. Each "editing
 * item 2" case below therefore asserts on lines 1 and 3.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Document position right after the first text node equal to `text`. */
function posAfterText(v: EditorView, text: string): number {
    let found = -1;
    v.state.doc.descendants((node, pos) => {
        if (found >= 0) return false;
        if (node.isText && node.text === text) {
            found = pos + text.length;
            return false;
        }
        return true;
    });
    if (found < 0) throw new Error(`text not found in doc: ${text}`);
    return found;
}

/** Open, serialize, and return the bytes a zero-edit save would write. */
async function saveUnedited(content: string): Promise<string> {
    const editor = await makeEditor(content);
    const serialized = editor.action(getMarkdown());
    await editor.destroy();
    return serialized;
}

/** Open, type `Q` before the given text, and merge the save exactly as the
 *  sync pipeline does. */
async function saveTypingBefore(content: string, anchor: string): Promise<string> {
    const editor = await makeEditor(content);
    const baseline = editor.action(getMarkdown());
    const protection = computeRoundTripProtection(content, baseline);
    const v = view(editor);
    v.dispatch(v.state.tr.insertText("Q", posAfterText(v, anchor) - anchor.length));
    const merged = applyMinimalChanges(content, editor.action(getMarkdown()), protection);
    await editor.destroy();
    return merged;
}

// ── Regression guard: markers vs. the thematic-break flip ───────────────────
//
// mdast-util-to-markdown's stock `list` handler switches to a different bullet
// when an item's FIRST child is a thematic break, because `- ---` is a run of
// four dashes — one thematic break, not a list. It decides that by comparing
// the bullet against the GLOBAL `rule` option, which stops being the character
// that actually prints once a per-list bullet (this change) and a per-node rule
// marker (sourceStyle, MAR-16) are both in play.
//
// That branch is structurally UNREACHABLE in this editor: `list_item`'s content
// is `"paragraph block*"`, so an item always starts with a paragraph and a
// thematic break can never be an item's first mdast child (the serializer emits
// the rule on its own indented line instead). These cases pin that — if a
// schema change ever makes the branch reachable, the flip's comparison has to
// be revisited before a list can silently collapse into a rule.

/** The non-text node kinds `md` reparses to — what a reader actually gets back. */
async function reparsedKinds(md: string): Promise<string[]> {
    const editor = await makeEditor(md);
    const kinds: string[] = [];
    editor.action((ctx) => {
        ctx.get(editorViewCtx).state.doc.descendants((node) => {
            if (!node.isText) kinds.push(node.type.name);
            return true;
        });
    });
    await editor.destroy();
    return kinds;
}

describe("a list item containing a thematic break stays a list", () => {
    const cases: Array<[string, string]> = [
        ["star bullet with a *** rule", "*\n  ***\n"],
        ["dash bullet with a --- rule", "-\n  ---\n"],
        ["star bullet with a --- rule", "* ---\n"],
    ];

    for (const [label, content] of cases) {
        it(`${label} should still reparse as a list after a save`, async () => {
            // Arrange / Act
            const serialized = await saveUnedited(content);

            // Assert — the saved bytes reparse as a list containing a rule, not
            // as one collapsed thematic break.
            const kinds = await reparsedKinds(serialized);
            expect(kinds).toContain("bullet_list");
            expect(kinds).toContain("hr");
        });
    }
});

// ── An item's first block on the marker line (MAR-230) ─────────────────────
//
// `list_item` is `paragraph block*`, so an item whose real content is not a
// paragraph gets an EMPTY paragraph filled in front of it. Serializing that
// artifact produced a bare marker line with the content indented beneath —
// which reparses as something else entirely (a bare `-` under a paragraph is a
// setext underline; under tab indentation the content falls out of the item and
// becomes an indented code block). The serializer now writes the real block on
// the marker line, and these pin both that it does and the three shapes where
// it deliberately does NOT.

/** Open, delete every text node, and return the bytes a save would write. */
async function saveWithAllTextDeleted(content: string): Promise<string> {
    const editor = await makeEditor(content);
    const v = view(editor);
    const ranges: Array<[number, number]> = [];
    v.state.doc.descendants((node, pos) => {
        if (node.isText) ranges.push([pos, pos + node.nodeSize]);
        return true;
    });
    const tr = v.state.tr;
    for (const [from, to] of ranges.reverse()) tr.delete(from, to);
    v.dispatch(tr);
    const serialized = editor.action(getMarkdown());
    await editor.destroy();
    return serialized;
}

describe("an item's real first block rides on the marker line", () => {
    const hoisted: Array<[string, string]> = [
        ["a heading", "- normal\n  - # H\n    body\n"],
        ["a blockquote", "- normal\n  - > quoted\n"],
        ["a fence", "- normal\n  - ```js\n    x\n    ```\n"],
        ["a nested list that has content", "- normal\n  - - deep\n"],
    ];

    for (const [label, source] of hoisted) {
        it(`an item whose content is ${label} should round-trip byte-for-byte`, async () => {
            // Byte equality is the strong form here: the source already writes
            // the block on the marker line, so anything else is the serializer
            // inventing the bare-marker construct again.
            expect(await saveUnedited(source)).toBe(source);
        });
    }

    it("an emptied three-deep branch should not collapse into a horizontal rule", async () => {
        // Hoisting an EMPTY nested list puts its marker on this line too, and
        // three bare bullets ARE a thematic break: `- - -`. Emptying a branch's
        // three lines is an ordinary gesture, and the whole branch reopened as
        // an <hr>. Nothing is gained by hoisting an empty list, so it stays put.
        const serialized = await saveWithAllTextDeleted("- a\n  - b\n    - c\n");

        const kinds = await reparsedKinds(serialized);
        expect(kinds).toContain("bullet_list");
        expect(kinds).not.toContain("hr");
    });

    it("a blank line the author wrote inside an item should survive the save", async () => {
        // Here the leading empty paragraph is NOT an artifact — an item may
        // legally start with a paragraph, so nothing was filled in and the empty
        // one is a node the document really has. Dropping it deleted a paragraph
        // the user could see (`-\n\n  world` came back as `- world`).
        const editor = await makeEditor("- hello\n\n  world\n");
        const v = view(editor);
        v.dispatch(v.state.tr.delete(posAfterText(v, "hello") - "hello".length, posAfterText(v, "hello")));
        const before = v.state.doc.firstChild!.firstChild!.childCount;
        const serialized = editor.action(getMarkdown());
        await editor.destroy();

        const kinds = await reparsedKinds(serialized);
        expect(before).toBe(2); // an empty paragraph and a real one
        expect(kinds.filter((k) => k === "paragraph")).toHaveLength(2);
    });
});

// ── Marker facts (MAR-218) ──────────────────────────────────────────────────

describe("a list's marker style survives a zero-edit save", () => {
    const cases: Array<[string, string]> = [
        ["plus bullets", "+ a\n+ b\n+ c\n"],
        ["star bullets", "* a\n* b\n* c\n"],
        ["paren-delimited ordered", "1) a\n2) b\n3) c\n"],
        ["lazy (non-incrementing) numbering", "1. a\n1. b\n1. c\n"],
        ["lazy numbering from a non-1 start", "3. a\n3. b\n3. c\n"],
        ["nested mixed markers", "- top\n  * kid\n  * kid two\n- next\n"],
        ["adjacent marker-split lists", "- a\n- b\n\n* c\n* d\n"],
    ];

    for (const [label, content] of cases) {
        it(`${label} should round-trip byte-identically with NO protection regions`, async () => {
            // Arrange / Act
            const serialized = await saveUnedited(content);
            const protection = computeRoundTripProtection(content, serialized);

            // Assert — the file serializes to itself, so the round trip needs
            // zero protection regions; the marker is preserved natively rather
            // than repaired by the merge layer.
            expect(serialized).toBe(content);
            expect(protection).toBeNull();
        });
    }
});

describe("editing one item leaves every other item's marker untouched", () => {
    it("typing into a + list should keep + on the untouched lines", async () => {
        // Arrange / Act
        const merged = await saveTypingBefore("+ a\n+ b\n+ c\n", "b");

        // Assert
        expect(merged).toBe("+ a\n+ Qb\n+ c\n");
    });

    it("typing into a * list should keep * on the untouched lines", async () => {
        const merged = await saveTypingBefore("* a\n* b\n* c\n", "b");

        expect(merged).toBe("* a\n* Qb\n* c\n");
    });

    it("typing into a 1) list should keep the ) delimiter", async () => {
        const merged = await saveTypingBefore("1) a\n2) b\n3) c\n", "b");

        expect(merged).toBe("1) a\n2) Qb\n3) c\n");
    });

    it("typing into a lazily numbered list should keep every number at 1", async () => {
        // The most annoying case: `1.`/`1.`/`1.` is authored deliberately
        // because it survives reordering, and renumbering it destroys that.
        const merged = await saveTypingBefore("1. a\n1. b\n1. c\n", "b");

        expect(merged).toBe("1. a\n1. Qb\n1. c\n");
    });

    it("typing into a nested list should keep both levels' markers", async () => {
        const merged = await saveTypingBefore("- top\n  * kid\n  * kid two\n- next\n", "kid two");

        expect(merged).toBe("- top\n  * kid\n  * Qkid two\n- next\n");
    });
});

describe("a marker fact is only recorded when the source actually states it", () => {
    it("a single-item ordered list should NOT be pinned non-incrementing", async () => {
        // Arrange — one item carries no evidence either way (its number is
        // trivially "the same as every other item"), so a second item added in
        // the editor must number 2, not 1.
        const editor = await makeEditor("1. only\n");

        // Act — append a sibling item by splitting at the end of the first.
        const v = view(editor);
        const at = posAfterText(v, "only");
        v.dispatch(v.state.tr.insertText("\n", at));
        editor.action((ctx) => {
            const ev = ctx.get(editorViewCtx);
            const tr = ev.state.tr;
            tr.split(at, 2);
            tr.insertText("second", tr.mapping.map(at));
            ev.dispatch(tr);
        });
        const serialized = editor.action(getMarkdown());
        await editor.destroy();

        // Assert — normal incrementing numbering for editor-created items.
        expect(serialized).toContain("2.");
        expect(serialized).not.toMatch(/^1\..*\n1\./m);
    });

    it("a list created in the editor should use the serializer defaults", async () => {
        // Arrange — a bare paragraph, wrapped into a list by the schema's
        // default attrs (no recorded marker).
        const editor = await makeEditor("plain paragraph\n");

        // Act
        editor.action((ctx) => {
            const v = ctx.get(editorViewCtx);
            const { schema } = v.state;
            const item = schema.nodes["list_item"].createAndFill(
                null,
                schema.nodes["paragraph"].create(null, schema.text("fresh")),
            );
            const list = schema.nodes["bullet_list"].create(null, item);
            v.dispatch(v.state.tr.insert(v.state.doc.content.size, list));
        });
        const serialized = editor.action(getMarkdown());
        await editor.destroy();

        // Assert — the configured `-` bullet, not a carried one.
        expect(serialized).toContain("- fresh");
    });
});
