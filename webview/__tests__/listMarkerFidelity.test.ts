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
import { TextSelection } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { tabKeymapPlugin } from "../plugins/tabKeymap";
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
// That stock branch is still unreachable in this editor: `list_item`'s content
// is `"paragraph block*"`, so an item always starts with a paragraph and a
// thematic break is never an item's first mdast child when the `list` handler
// is entered. (`hoistRulesOntoMarkerLine` does make one first later in that
// same call — but only when the two characters differ, which is the collision
// the stock branch exists to break, so it cannot make it live. MAR-240.) These
// cases pin that — if a schema change ever makes the branch reachable, the
// flip's comparison has to be revisited before a list can silently collapse
// into a rule.

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

// ── A nested item's rule on the marker line (MAR-240) ──────────────────────
//
// The block above hoists an item's real first block onto the marker line, but
// held a THEMATIC BREAK back unconditionally (a marker joining the rule's own
// characters re-lexes the line as one break) and refused a nested list with no
// TEXT (three bare markers are a break: `- - -`). The bare marker each left
// behind is safe at the top level and fatal one level down: glued under a
// paragraph line, a lone `-` is a setext underline and a lone `*`/`+` is lazy
// continuation text, so the nested list was deleted on reopen.
//
// Both hold-backs are now as narrow as their hazard — see
// `hoistRulesOntoMarkerLine` / `bulletNeedsFlipForRule` (plugins/sourceStyle.ts)
// and `ridesMarkerLineSafely` (plugins/list.ts).
//
// The matrix is enumerated rather than sampled because the hazard is a
// character collision: which bullet meets which rule character is the whole
// question, and the shapes differ in whether a bare marker would land under a
// paragraph at all. Hand-picking would have covered the `-`/`***` pair the
// ticket happened to report and missed that `+` bullets lost the nesting
// against every rule character. Measured on the pre-fix build, 13 of these 54
// rows came back as a different document.

describe("an item whose content is a thematic break keeps its nesting", () => {
    const BULLETS = ["-", "*", "+"];
    const RULES = ["---", "***", "___"];
    const SHAPES: Array<[string, (bullet: string, rule: string) => string]> = [
        ["a top-level item, rule on the marker line", (b, r) => `${b} ${r}\n`],
        ["a top-level item, rule under a bare marker", (b, r) => `${b}\n  ${r}\n`],
        ["a tight nested item", (b, r) => `${b} normal\n  ${b} ${r}\n`],
        ["a loose nested item", (b, r) => `${b} normal\n\n  ${b} ${r}\n`],
        ["a loose nested item, rule under a bare marker", (b, r) => `${b} normal\n\n  ${b}\n    ${r}\n`],
        ["a nested rule item with a sibling after it", (b, r) => `${b} normal\n  ${b} ${r}\n  ${b} after\n`],
    ];

    for (const [label, build] of SHAPES) {
        for (const bullet of BULLETS) {
            for (const rule of RULES) {
                it(`${label} (${bullet} bullet, ${rule} rule) should reopen as the document the editor held`, async () => {
                    // Arrange — assert on the REOPENED shape, not on bytes: the
                    // serializer is allowed to respell this (that is the whole
                    // fix), and what the user loses is the document, not the
                    // spelling. Several of these sources are the collapsed form
                    // already — `- ---` is a thematic break, not a list — and
                    // the invariant holds for those too, since `held` is read
                    // from the same parse the editor gets.
                    const source = build(bullet, rule);
                    // `reparsedKinds` of the SOURCE is what the editor holds —
                    // the same parse the user sees on screen.
                    const held = await reparsedKinds(source);

                    // Act
                    const saved = await saveUnedited(source);

                    // Assert — reopening returns the same document, and the
                    // spelling has settled (a save of the save changes nothing,
                    // so the respelling cannot oscillate on every keystroke).
                    expect(await reparsedKinds(saved)).toEqual(held);
                    expect(await saveUnedited(saved)).toBe(saved);
                });
            }
        }
    }
});

describe("the shapes MAR-240 reported round-trip byte-for-byte", () => {
    const cases: Array<[string, string]> = [
        ["a rule in a nested bullet", "- normal\n  - ***\n"],
        ["a rule in a nested ordered item", "1. normal\n   1. ***\n"],
        ["a dash rule in a nested ordered item", "1. normal\n   1. ---\n"],
        ["a sublist holding only an image", "- normal\n  - - ![](a.png)\n"],
        ["a rule with content after it in the same item", "- normal\n  - ***\n    text\n"],
    ];

    for (const [label, source] of cases) {
        it(`${label} should round-trip byte-for-byte`, async () => {
            // The source already writes the block on the marker line, so any
            // other output is the serializer inventing the bare-marker
            // construct again — the construct that does not survive its reparse.
            expect(await saveUnedited(source)).toBe(source);
        });
    }
});

describe("a bare marker that would survive is left exactly as written", () => {
    // The bullet and the rule are the same character here, so the rule cannot
    // ride the marker line — and these three spellings need no rescue, because
    // nothing above the bare marker can absorb it. Flipping the bullet to make
    // room would rewrite a marker the user wrote, to fix nothing.
    const cases: Array<[string, string]> = [
        ["a top-level star item with a *** rule", "*\n  ***\n"],
        ["a top-level dash item with a --- rule", "-\n  ---\n"],
        ["a nested dash item behind a blank line", "- normal\n\n  -\n    ---\n"],
        ["a nested star item behind a blank line", "* normal\n\n  *\n    ***\n"],
        // The sublist is its item's FIRST block, so the bare marker sits under
        // another bare marker rather than under a paragraph line — nothing
        // there absorbs it either.
        ["a nested dash item under an empty parent", "-\n  -\n    ---\n"],
    ];

    for (const [label, source] of cases) {
        it(`${label} should round-trip byte-for-byte`, async () => {
            expect(await saveUnedited(source)).toBe(source);
        });
    }
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

// ── The collision, reached by a real gesture (MAR-240) ──────────────────────
//
// The one shape where the bullet and the rule genuinely collide AND the bare
// marker is fatal cannot be written in Markdown — `- ---` is four dashes, so a
// nested item holding a same-character rule has no source spelling. It is
// reached by EDITING: Tab-indenting an item that holds a rule. The sublist
// `sinkListItem` creates has no recorded marker, so it takes the global `-`
// bullet — the same character as the global `---` rule.
//
// This drives the editor's own Tab handler rather than calling the serializer
// with a hand-built document, because "can a user get here" is what decides
// whether the bullet is worth flipping at all. Tab is no longer the ONLY way
// here: `insertHorizontalRule` used to destroy the nested item before the save
// could see it, which is what this note originally recorded — that was its own
// bug (MAR-304) and it is fixed, so the command now fills the item and reaches
// this shape too. The Tab path is kept as the gesture under test because it is
// the one that creates an unmarked sublist.

/** An editor with the Tab handler wired, as the real webview has it. */
async function makeEditorWithTab(markdown: string): Promise<Editor> {
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
        .use(tabKeymapPlugin)
        .create();
}

/** Put the caret in the item that holds a rule, press Tab, and save. */
async function saveAfterTabIndentingTheRuleItem(source: string): Promise<string> {
    const editor = await makeEditorWithTab(source);
    const v = view(editor);
    let caret = -1;
    v.state.doc.descendants((node, pos) => {
        if (caret >= 0) return false;
        const holdsRule =
            node.type.name === "list_item" &&
            node.childCount >= 2 &&
            node.child(1).type.name === "hr";
        if (holdsRule) caret = pos + 2; // inside the item's leading paragraph
        return !holdsRule;
    });
    if (caret < 0) throw new Error(`no rule-holding item in ${JSON.stringify(source)}`);
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, caret)));
    const handled = v.someProp("handleKeyDown", (f) =>
        f(v, new KeyboardEvent("keydown", { key: "Tab" })),
    );
    // Both guards are the probe checking it hit what it aimed at: a Tab that
    // was ignored, or one that moved something else, would leave the assertions
    // below passing on a document the gesture never produced.
    if (!handled) throw new Error("Tab was not handled — the gesture did not happen");
    const nested = v.state.doc.firstChild?.firstChild?.child(1)?.type.name;
    if (nested !== "bullet_list") throw new Error(`Tab did not nest the item: ${nested}`);
    const serialized = editor.action(getMarkdown());
    await editor.destroy();
    return serialized;
}

describe("Tab-indenting an item that holds a rule keeps the rule in the list", () => {
    const cases: Array<[string, string]> = [
        ["dash bullets and a dash rule", "- first\n-\n  ---\n"],
        ["star bullets and a star rule", "* first\n*\n  ***\n"],
        ["dash bullets and a star rule", "- first\n- ***\n"],
    ];

    for (const [label, source] of cases) {
        it(`${label} should reopen with the rule still nested`, async () => {
            // Act
            const serialized = await saveAfterTabIndentingTheRuleItem(source);

            // Assert — two lists deep with the rule inside, which is what the
            // editor holds after the Tab. Before this fix the dash/dash case
            // saved a bare marker under `first` and reopened as a HEADING plus
            // a rule, with the nested list gone.
            const kinds = await reparsedKinds(serialized);
            expect(kinds.filter((k) => k === "bullet_list")).toHaveLength(2);
            expect(kinds).toContain("hr");
            expect(kinds).not.toContain("heading");
        });
    }
});

// ── Emptying a TASK item that holds another block (MAR-306) ────────────────
//
// The two blocks above are about the bullet character. This one is about the
// checkbox, and it is the same artifact empty paragraph seen from a third side.
//
// GFM has no spelling for a checked item with no text: measured, `- [x] ` and
// `- [x]` both reopen as a PLAIN item whose text is the literal `[x]`. Upstream
// (`mdast-util-gfm-task-list-item`) does not ask the question — it tests only
// that the item's first child is a paragraph, which the ARTIFACT empty one
// answers, and then splices the checkbox in with a regex that matches the
// marker's own newline when the item has no first line. The checkbox landed on
// the content's line, ahead of its indent, and took the document with it.
//
// Two shapes, one keystroke apart, both reachable with no command involved —
// select an item's text and delete it:
//
//   paragraph(empty), hr    saved `-\n[x] \n  ---\n`, and the `---` then
//                           UNDERLINED the stray `[x]` into a setext heading:
//                           the rule was gone and a heading nobody wrote was
//                           in the file
//   paragraph(empty), para  saved `-\n[x] \n  body\n`, which the PARSER THREW
//                           on — a file saved in that state did not reopen
//
// The checkbox cannot be kept, and the tick is lost on the reopen. That is not
// a choice this fix makes so much as one GFM makes: the same path already drops
// it for every other trailing block (a heading or a fence hoists onto the marker
// line, so upstream sees a non-paragraph head), and the fix is to answer the
// two remaining shapes the same way instead of leaving them to corrupt the file.

/**
 * The flow-child type names of `md`'s first list item, joined.
 *
 * `reparsedKinds` cannot answer nesting — it flattens the document, so a block
 * that ESCAPED the list still shows up after `list_item` in its output, and an
 * index comparison against it passes on exactly the corruption it was written to
 * catch (measured: it did). This reads the item itself.
 */
async function reparsedItemShape(md: string): Promise<string> {
    const editor = await makeEditor(md);
    const shape = editor.action((ctx) => {
        const item = ctx.get(editorViewCtx).state.doc.firstChild?.firstChild;
        if (!item || item.type.name !== "list_item") return "<no item>";
        const names: string[] = [];
        item.content.forEach((child) => names.push(child.type.name));
        return names.join(",");
    });
    await editor.destroy();
    return shape;
}

/** Open, delete `text` wherever it first appears, and serialize — the ordinary
 *  Backspace-over-a-selection gesture, with no command involved. */
async function saveWithTextDeleted(content: string, text: string): Promise<string> {
    const editor = await makeEditor(content);
    const v = view(editor);
    const to = posAfterText(v, text);
    v.dispatch(v.state.tr.delete(to - text.length, to));
    const serialized = editor.action(getMarkdown());
    await editor.destroy();
    return serialized;
}

describe("emptying a task item that holds another block", () => {
    it("a checked item holding a rule should keep the rule and invent no heading", async () => {
        // Act — the ticket's own reproduction, driven through the delete.
        const serialized = await saveWithTextDeleted("- [x] alpha\n\n  ---\n", "alpha");

        // Assert — the rule is still INSIDE the item, which is what the editor
        // holds. `not.toContain("heading")` is the reported symptom; the shape
        // is the half that a rule merely PRESENT in the document would satisfy
        // while it had escaped the list.
        const kinds = await reparsedKinds(serialized);
        expect(kinds).not.toContain("heading");
        expect(await reparsedItemShape(serialized)).toBe("paragraph,hr");
    });

    it("a checked item holding a second paragraph should still reopen", async () => {
        // Act — the shape whose bytes the parser THREW on.
        const serialized = await saveWithTextDeleted("- [x] hello\n\n  world\n", "hello");

        // Assert — reparsing at all is the whole assertion; `reparsedKinds`
        // opens a real editor on the bytes, so a throw fails here.
        const kinds = await reparsedKinds(serialized);
        expect(kinds).toContain("paragraph");
        expect(kinds).not.toContain("heading");
    });

    it("an emptied task item should round-trip stably rather than churn on each save", async () => {
        // Act — save, reopen, save again.
        const once = await saveWithTextDeleted("- [x] alpha\n\n  ---\n", "alpha");
        const twice = await saveUnedited(once);

        // Assert — an unstable spelling rewrites the file on every save even
        // when the user changes nothing.
        expect(twice).toBe(once);
    });

    it("a checked item that still has text should keep its checkbox", async () => {
        // The inverse case, so the fix cannot pass by dropping every checkbox.
        expect(await saveUnedited("- [x] alpha\n\n  ---\n")).toBe("- [x] alpha\n\n  ---\n");
        expect(await saveUnedited("- [ ] a\n- [x] b\n")).toBe("- [ ] a\n- [x] b\n");
    });
});
