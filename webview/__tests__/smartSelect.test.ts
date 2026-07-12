/**
 * Tests for smart select (MAR-98): the expand ladder (caret → word → mark
 * span → block text → block range → everything) and its deterministic
 * shrink retrace — no plugin state, the chain is re-derived from the
 * current selection anchored at the head-side interior position.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { NodeSelection, TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, pureCommonmark } from "../serialization";
import { headingFoldPlugin, headingFoldPluginKey, type HeadingFoldMeta } from "../plugins/headingFold";
import { expandSelection, shrinkSelection } from "../plugins/smartSelect";
import { BlockRangeSelection } from "../plugins/blockRange";

let editors: Editor[] = [];

async function makeEditor(markdown: string): Promise<EditorView> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfm)
        .use(headingFoldPlugin)
        .create();
    editors.push(editor);
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

/**
 * Caret inside the textblock whose textContent is `blockText`, at `offset`
 * characters in (blocks in these fixtures are pure text runs, so textContent
 * offsets align 1:1 with document positions).
 */
function caretAt(view: EditorView, blockText: string, offset: number): void {
    let pos = -1;
    view.state.doc.descendants((node, nodePos) => {
        if (pos === -1 && node.isTextblock && node.textContent === blockText) {
            pos = nodePos + 1 + offset;
        }
        return pos === -1;
    });
    expect(pos).toBeGreaterThan(-1);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

function selectedText(view: EditorView): string {
    const sel = view.state.selection;
    return view.state.doc.textBetween(sel.from, sel.to, " ");
}

const expand = (view: EditorView) => expandSelection(view.state, view.dispatch);
const shrink = (view: EditorView) => shrinkSelection(view.state, view.dispatch);

describe("expandSelection ladder", () => {
    it("a caret inside a word should select that word", async () => {
        const view = await makeEditor("Alpha beta gamma");
        caretAt(view, "Alpha beta gamma", "Alpha beta gamma".indexOf("beta") + 2);
        expect(expand(view)).toBe(true);
        expect(view.state.selection).toBeInstanceOf(TextSelection);
        expect(selectedText(view)).toBe("beta");
    });

    it("a word inside a bold span should expand to the full mark extent", async () => {
        const view = await makeEditor("Start **bold words** tail");
        const text = "Start bold words tail";
        caretAt(view, text, text.indexOf("words") + 1);
        expand(view); // word
        expect(selectedText(view)).toBe("words");
        expect(expand(view)).toBe(true);
        expect(selectedText(view)).toBe("bold words");
    });

    it("a word inside a link should expand to the full link text", async () => {
        const view = await makeEditor("See [alpha beta](https://example.com/) end");
        const text = "See alpha beta end";
        caretAt(view, text, text.indexOf("alpha") + 1);
        expand(view); // word
        expect(selectedText(view)).toBe("alpha");
        expect(expand(view)).toBe(true);
        expect(selectedText(view)).toBe("alpha beta");
    });

    it("nested marks should expand to the SMALLEST strictly-containing extent first", async () => {
        const view = await makeEditor("**bold *ital word* more**");
        const text = "bold ital word more";
        caretAt(view, text, text.indexOf("word") + 1);
        expand(view); // word
        expect(selectedText(view)).toBe("word");
        expect(expand(view)).toBe(true);
        expect(selectedText(view)).toBe("ital word"); // em, not the wider strong
        expect(expand(view)).toBe(true);
        expect(selectedText(view)).toBe("bold ital word more"); // strong next
    });

    it("a word inside inline code should expand to the code span", async () => {
        const view = await makeEditor("run `foo bar` now");
        const text = "run foo bar now";
        caretAt(view, text, text.indexOf("foo") + 1);
        expand(view); // word
        expect(selectedText(view)).toBe("foo");
        expect(expand(view)).toBe(true);
        expect(selectedText(view)).toBe("foo bar");
    });

    it("a full mark span should expand to the block's text", async () => {
        const view = await makeEditor("Start **bold words** tail\n\nOther");
        const text = "Start bold words tail";
        caretAt(view, text, text.indexOf("words") + 1);
        expand(view); // word
        expand(view); // mark span
        expect(expand(view)).toBe(true);
        expect(view.state.selection).toBeInstanceOf(TextSelection);
        expect(selectedText(view)).toBe(text);
    });

    it("full block text should expand to a BlockRangeSelection over the block", async () => {
        const view = await makeEditor("Alpha beta\n\nGamma");
        caretAt(view, "Alpha beta", 1);
        expand(view); // word
        expand(view); // block text ("Alpha" → whole text)
        expect(selectedText(view)).toBe("Alpha beta");
        expect(expand(view)).toBe(true);
        const sel = view.state.selection;
        expect(sel).toBeInstanceOf(BlockRangeSelection);
        expect(selectedText(view)).toBe("Alpha beta");
    });

    it("a single-block range should expand to everything, and everything should return false", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        caretAt(view, "Beta", 1);
        expand(view); // word (== block text)
        expand(view); // block range
        expect(view.state.selection).toBeInstanceOf(BlockRangeSelection);
        expect(expand(view)).toBe(true); // everything
        const all = view.state.selection;
        expect(all).toBeInstanceOf(BlockRangeSelection);
        expect(all.from).toBe(0);
        expect(all.to).toBe(view.state.doc.content.size);
        expect(expand(view)).toBe(false); // top of the ladder
        expect(view.state.selection.eq(all)).toBe(true);
    });

    it("a caret in an EMPTY paragraph should go straight to the block ladder", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        const end = view.state.doc.content.size;
        const paragraph = view.state.schema.nodes["paragraph"]!;
        view.dispatch(view.state.tr.insert(end, paragraph.create()));
        view.dispatch(view.state.tr.setSelection(
            TextSelection.near(view.state.doc.resolve(view.state.doc.content.size - 1)),
        ));
        expect(view.state.selection.empty).toBe(true);
        expect(expand(view)).toBe(true);
        expect(view.state.selection).toBeInstanceOf(BlockRangeSelection);
        expect(selectedText(view)).toBe(""); // just the empty block, nothing else
    });

    it("an empty document should expand to a block range over its lone paragraph", async () => {
        const view = await makeEditor("");
        expect(expand(view)).toBe(true);
        expect(view.state.selection).toBeInstanceOf(BlockRangeSelection);
    });

    it("a NodeSelection on a leaf block should escalate to its block range", async () => {
        const view = await makeEditor("alpha\n\n---\n\nomega");
        let hrPos = -1;
        view.state.doc.forEach((node, offset) => {
            if (node.type.name === "hr") hrPos = offset;
        });
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, hrPos)));
        expect(expand(view)).toBe(true);
        const sel = view.state.selection;
        expect(sel).toBeInstanceOf(BlockRangeSelection);
        expect(sel.from).toBe(hrPos);
        expect(sel.to).toBe(hrPos + 1);
    });
});

describe("expandSelection caret word rule", () => {
    it("a caret touching a word on the RIGHT should prefer the word after", async () => {
        const view = await makeEditor("Alpha beta");
        caretAt(view, "Alpha beta", "Alpha beta".indexOf("beta")); // right before 'b'
        expect(expand(view)).toBe(true);
        expect(selectedText(view)).toBe("beta");
    });

    it("a caret touching a word only on the LEFT should take the word before", async () => {
        const view = await makeEditor("Alpha beta");
        caretAt(view, "Alpha beta", "Alpha".length); // right after 'a', on the space
        expect(expand(view)).toBe(true);
        expect(selectedText(view)).toBe("Alpha");
    });

    it("a caret with no adjacent word char should scan RIGHT for the next word", async () => {
        const view = await makeEditor("Alpha - beta");
        caretAt(view, "Alpha - beta", "Alpha - beta".indexOf("-")); // between space and '-'
        expect(expand(view)).toBe(true);
        expect(selectedText(view)).toBe("beta");
    });

    it("a caret past the last word should fall back to the word before", async () => {
        const view = await makeEditor("Alpha beta --");
        caretAt(view, "Alpha beta --", "Alpha beta --".length); // block end, after '--'
        expect(expand(view)).toBe(true);
        expect(selectedText(view)).toBe("beta");
    });

    it("a caret at block start should select the first word", async () => {
        const view = await makeEditor("Alpha beta");
        caretAt(view, "Alpha beta", 0);
        expect(expand(view)).toBe(true);
        expect(selectedText(view)).toBe("Alpha");
    });
});

describe("shrinkSelection retrace", () => {
    it("the full ladder should shrink level by level and bottom out false", async () => {
        const view = await makeEditor("Alpha\n\nStart **bold words**");
        const text = "Start bold words";
        caretAt(view, text, text.indexOf("words") + 1);
        // Up: word → mark → block text → block range → everything.
        expand(view);
        expand(view);
        expand(view);
        expand(view);
        expand(view);
        expect(view.state.selection.from).toBe(0);
        expect(view.state.selection.to).toBe(view.state.doc.content.size);

        // Down: everything → head-side unit (the second block).
        expect(shrink(view)).toBe(true);
        expect(view.state.selection).toBeInstanceOf(BlockRangeSelection);
        expect(selectedText(view)).toBe(text);
        // → block text.
        expect(shrink(view)).toBe(true);
        expect(view.state.selection).toBeInstanceOf(TextSelection);
        expect(selectedText(view)).toBe(text);
        // → mark span (the largest strictly-contained range at the probe).
        expect(shrink(view)).toBe(true);
        expect(selectedText(view)).toBe("bold words");
        // → word.
        expect(shrink(view)).toBe(true);
        expect(selectedText(view)).toBe("words");
        // Bottom: a lone word has no recognized sub-range.
        expect(shrink(view)).toBe(false);
        expect(selectedText(view)).toBe("words");
    });

    it("a single-block range should shrink to the block's text", async () => {
        const view = await makeEditor("Alpha beta\n\nGamma");
        caretAt(view, "Alpha beta", 1);
        expand(view); // word
        expand(view); // block text
        expand(view); // block range
        expect(view.state.selection).toBeInstanceOf(BlockRangeSelection);
        expect(shrink(view)).toBe(true);
        expect(view.state.selection).toBeInstanceOf(TextSelection);
        expect(selectedText(view)).toBe("Alpha beta");
    });

    it("everything over plain blocks should shrink to the head-side unit", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        const all = BlockRangeSelection.tryCreate(view.state.doc, 0, view.state.doc.content.size)!;
        view.dispatch(view.state.tr.setSelection(all));
        expect(shrink(view)).toBe(true);
        const sel = view.state.selection;
        expect(sel).toBeInstanceOf(BlockRangeSelection);
        expect(selectedText(view)).toBe("Gamma"); // forward range: head is at the end
    });

    it("a block text ending in a word should shrink to that word when no mark contains the probe", async () => {
        const view = await makeEditor("Alpha beta\n\nGamma");
        caretAt(view, "Alpha beta", 1);
        expand(view); // word "Alpha"
        expand(view); // block text
        expect(selectedText(view)).toBe("Alpha beta");
        expect(shrink(view)).toBe(true);
        expect(selectedText(view)).toBe("beta"); // head-side probe: deterministic, not history
    });

    it("a caret should return false", async () => {
        const view = await makeEditor("Alpha beta");
        caretAt(view, "Alpha beta", 2);
        expect(shrink(view)).toBe(false);
        expect(view.state.selection.empty).toBe(true);
    });

    it("a NodeSelection should be unrecognized and return false", async () => {
        const view = await makeEditor("alpha\n\n---\n\nomega");
        let hrPos = -1;
        view.state.doc.forEach((node, offset) => {
            if (node.type.name === "hr") hrPos = offset;
        });
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, hrPos)));
        expect(shrink(view)).toBe(false);
    });

    it("an arbitrary mid-word selection should shrink to nothing recognized and return false", async () => {
        const view = await makeEditor("Alphabet soup");
        // "phab" — strictly inside the word "Alphabet", contains no whole word.
        view.dispatch(view.state.tr.setSelection(
            TextSelection.create(view.state.doc, 3, 7),
        ));
        expect(shrink(view)).toBe(false);
    });
});

describe("shrinkSelection over a collapsed heading", () => {
    it("a collapsed-heading unit should shrink to the heading's OWN text, not the hidden body", async () => {
        // Arrange — a heading owning a body section, then a sibling heading
        // that bounds it. "Heading" spans [0,9); "Body" [9,15); "Next" at 15.
        const view = await makeEditor("# Heading\n\nBody\n\n# Next");
        view.dispatch(
            view.state.tr.setMeta(headingFoldPluginKey, {
                type: "toggle",
                pos: 0,
            } satisfies HeadingFoldMeta),
        );
        // The unit for the collapsed heading spans its hidden section too.
        const unit = BlockRangeSelection.tryCreate(view.state.doc, 0, 15);
        expect(unit).not.toBeNull();
        view.dispatch(view.state.tr.setSelection(unit!));

        // Act
        expect(shrink(view)).toBe(true);

        // Assert — the shrunk text stays inside the heading line; it never
        // extends into the folded body (which begins at position 9).
        const sel = view.state.selection;
        expect(sel).toBeInstanceOf(TextSelection);
        expect(selectedText(view)).toBe("Heading");
        expect(sel.to).toBeLessThanOrEqual(9);
    });
});
