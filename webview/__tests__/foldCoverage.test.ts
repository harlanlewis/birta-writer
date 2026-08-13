/**
 * Two guards share this file:
 *
 * MAR-125 — fold-grammar BEHAVIOR for the three structures beyond headings
 * and callouts: nested list items (fold to the first line, heading-section
 * semantics applied to list nesting), tables (fold to the header row), and
 * code blocks incl. math/mermaid fences (fold to the chrome row). Driven
 * through the REAL Milkdown editor (real parser, real schema) like
 * foldPlugin.test.ts, so position math matches production.
 *
 * MAR-116 — the same for the container kinds: a blockquote and a Notion
 * `<aside>` fold to their first LINE (they have no chrome of their own), a
 * container directive and a footnote definition fold to their chrome ROW,
 * and nothing but an item carries fold chrome inside a list item.
 *
 * MAR-263 — fold-decision EXHAUSTIVENESS (the sweep the file's name always
 * promised, at the bottom): every block node type must carry an explicit
 * fold decision — proven foldable by a fixture, or allowlisted with a
 * reason — mirroring gutterCoverage's preset-schema and $nodeSchema sweeps,
 * so a new block type fails at build time instead of silently never folding.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, schemaCtx } from "@milkdown/core";
import * as path from "path";
import * as fs from "fs";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    allFoldablePositions,
    computeFoldAnchors,
    foldAllCommand,
    foldAtCaret,
    foldHiddenRange,
    foldPluginKey,
    foldRevealKeymapPlugin,
    foldedHiddenRanges,
    headingFoldPlugin,
    resolveFoldAnchors,
    revealOnBackspace,
    unfoldAtCaret,
    type FoldMeta,
} from "../plugins/headingFold";
import { foldSelectedBlocks } from "../plugins/blockKeys";
import { BlockRangeSelection } from "../plugins/blockRange";
import { sinkItemKeepingChildren } from "../plugins/tabKeymap";
import { mdxBlockSchema, mdxInlineSchema } from "../format/mdx";

let editors: Editor[] = [];

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(foldRevealKeymapPlugin)
        .use(pureCommonmark)
        .use(gfmFidelity)
        // The mdx format's SCHEMAS only (no remark syntax plugins): the node
        // types register so the fold-decision sweeps see them, while the
        // markdown parse this suite drives is untouched.
        .use(mdxBlockSchema)
        .use(mdxInlineSchema)
        .use(headingFoldPlugin)
        .create();
    editors.push(editor);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function folded(v: EditorView): ReadonlySet<number> {
    return foldPluginKey.getState(v.state)!.folded;
}

function toggle(v: EditorView, pos: number): void {
    v.dispatch(
        v.state.tr
            .setMeta(foldPluginKey, { type: "toggle", pos } satisfies FoldMeta)
            .setMeta("addToHistory", false),
    );
}

/** Document position of the first node of the given type at ANY depth. */
function deepPosOf(v: EditorView, typeName: string): number {
    let pos = -1;
    v.state.doc.descendants((node, offset) => {
        if (pos === -1 && node.type.name === typeName) {
            pos = offset;
        }
        return pos === -1;
    });
    expect(pos, `no ${typeName} at any depth`).toBeGreaterThanOrEqual(0);
    return pos;
}

/** Position of the list item whose FIRST LINE reads exactly `firstLine`. */
function itemPosByLine(v: EditorView, firstLine: string): number {
    let pos = -1;
    v.state.doc.descendants((node, offset) => {
        if (
            pos === -1 &&
            node.type.name === "list_item" &&
            node.firstChild?.textContent === firstLine
        ) {
            pos = offset;
        }
        return pos === -1;
    });
    expect(pos, `no list item "${firstLine}"`).toBeGreaterThanOrEqual(0);
    return pos;
}

/** Whether the block containing the text `needle` sits inside a currently
 * hidden fold range. */
function textIsHidden(v: EditorView, needle: string): boolean {
    let at = -1;
    v.state.doc.descendants((node, offset) => {
        if (at === -1 && node.isText && node.text!.includes(needle)) {
            at = offset;
        }
        return at === -1;
    });
    expect(at, `text "${needle}" not found`).toBeGreaterThanOrEqual(0);
    return foldedHiddenRanges(v.state).some((r) => at >= r.from && at < r.to);
}

// The user's exact scenario from MAR-125.
const NESTED_LIST = [
    "- foo",
    "  - bar",
    "    - baz",
    "  - zap",
    "- bing",
    "  - ding",
].join("\n");

const TABLE = [
    "| H1 | H2 |",
    "| --- | --- |",
    "| a | b |",
    "| c | d |",
].join("\n");

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
    document.body.className = "";
});

describe("nested list item folding (fold to the first line)", () => {
    it("folding foo should hide bar, baz, and zap but never the sibling bing/ding", async () => {
        // Arrange
        const editor = await makeEditor(NESTED_LIST);
        const v = view(editor);
        const foo = itemPosByLine(v, "foo");

        // Act
        toggle(v, foo);

        // Assert: descendants hidden, first line and siblings visible.
        expect(folded(v).has(foo)).toBe(true);
        expect(textIsHidden(v, "bar")).toBe(true);
        expect(textIsHidden(v, "baz")).toBe(true);
        expect(textIsHidden(v, "zap")).toBe(true);
        expect(textIsHidden(v, "foo")).toBe(false);
        expect(textIsHidden(v, "bing")).toBe(false);
        expect(textIsHidden(v, "ding")).toBe(false);
        // The DOM carries the collapsed host class and hides the sub-list.
        expect(document.querySelector("li.collapsed")).not.toBeNull();
        expect(document.querySelector("li.collapsed > ul.heading-fold-hidden")).not.toBeNull();
    });

    it("folding bar should hide only baz (zap is a sibling, foo the parent)", async () => {
        // Arrange
        const editor = await makeEditor(NESTED_LIST);
        const v = view(editor);
        const bar = itemPosByLine(v, "bar");

        // Act
        toggle(v, bar);

        // Assert
        expect(textIsHidden(v, "baz")).toBe(true);
        expect(textIsHidden(v, "bar")).toBe(false);
        expect(textIsHidden(v, "zap")).toBe(false);
        expect(textIsHidden(v, "foo")).toBe(false);
    });

    it("a leaf item should not be foldable and its gutter should carry no chevron", async () => {
        // Arrange
        const editor = await makeEditor(NESTED_LIST);
        const v = view(editor);
        const baz = itemPosByLine(v, "baz");
        const ding = itemPosByLine(v, "ding");

        // Act + Assert: no hidden range, toggle rejected.
        expect(foldHiddenRange(v.state.doc, baz)).toBeNull();
        expect(foldHiddenRange(v.state.doc, ding)).toBeNull();
        toggle(v, baz);
        expect(folded(v).size).toBe(0);
        // Chevrons exist exactly on the three items with descendants.
        const foldableGutters = document.querySelectorAll("li > .heading-fold-gutter--foldable");
        expect(foldableGutters).toHaveLength(3); // foo, bar, bing
    });

    it("folding foo while bar is already folded should nest, and both expand independently", async () => {
        // Arrange
        const editor = await makeEditor(NESTED_LIST);
        const v = view(editor);
        const foo = itemPosByLine(v, "foo");
        const bar = itemPosByLine(v, "bar");

        // Act: fold inner first, then outer (heading sections already nest).
        toggle(v, bar);
        toggle(v, foo);

        // Assert
        expect(folded(v).has(foo)).toBe(true);
        expect(folded(v).has(bar)).toBe(true);
        expect(textIsHidden(v, "baz")).toBe(true);
        // Expanding the outer keeps the inner folded (VS Code semantics).
        toggle(v, foo);
        expect(folded(v).has(bar)).toBe(true);
        expect(textIsHidden(v, "baz")).toBe(true);
        expect(textIsHidden(v, "zap")).toBe(false);
    });

    it("the collapsed item's first line should trail a fold-ellipsis whose click expands", async () => {
        // Arrange
        const editor = await makeEditor(NESTED_LIST);
        const v = view(editor);
        toggle(v, itemPosByLine(v, "foo"));

        // Assert: the … chip sits in the collapsed item's own first line.
        const ellipsis = document.querySelector<HTMLButtonElement>("li.collapsed .fold-ellipsis");
        expect(ellipsis).not.toBeNull();

        // Act: clicking expands (the shared grammar).
        ellipsis!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        expect(folded(v).size).toBe(0);
        expect(document.querySelector("li.collapsed")).toBeNull();
    });

    it("toggling an item fold should leave state.doc reference-identical", async () => {
        // Arrange
        const editor = await makeEditor(NESTED_LIST);
        const v = view(editor);
        const docBefore = v.state.doc;
        const foo = itemPosByLine(v, "foo");

        // Act
        toggle(v, foo);
        toggle(v, foo);

        // Assert
        expect(v.state.doc).toBe(docBefore);
    });

    it("a caret dropped inside a folded item's hidden subtree should be ejected", async () => {
        // Arrange
        const editor = await makeEditor(`${NESTED_LIST}\n\ntail`);
        const v = view(editor);
        const foo = itemPosByLine(v, "foo");
        toggle(v, foo);
        const hidden = foldHiddenRange(v.state.doc, foo)!;

        // Act: land inside baz's text.
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, hidden.from + 3)));

        // Assert
        expect(
            v.state.selection.from >= hidden.to || v.state.selection.to <= hidden.from,
        ).toBe(true);
    });

    it("typing on the folded item's visible line should keep the fold on the item", async () => {
        // Arrange
        const editor = await makeEditor(NESTED_LIST);
        const v = view(editor);
        const foo = itemPosByLine(v, "foo");
        toggle(v, foo);

        // Act: append text at the end of foo's first line.
        const lineEnd = foo + 1 + v.state.doc.nodeAt(foo)!.firstChild!.nodeSize - 1;
        v.dispatch(v.state.tr.insertText("!", lineEnd));

        // Assert: the entry mapped with the item; descendants still hidden.
        const mapped = itemPosByLine(v, "foo!");
        expect(folded(v).has(mapped)).toBe(true);
        expect(textIsHidden(v, "bar")).toBe(true);
    });

    it("deleting the folded item with the delete meta should drop its fold entry", async () => {
        // Arrange
        const editor = await makeEditor(NESTED_LIST);
        const v = view(editor);
        const foo = itemPosByLine(v, "foo");
        toggle(v, foo);
        const item = v.state.doc.nodeAt(foo)!;

        // Act: the block menu's delete protocol.
        v.dispatch(
            v.state.tr
                .delete(foo, foo + item.nodeSize)
                .setMeta(foldPluginKey, {
                    type: "delete",
                    from: foo,
                    to: foo + item.nodeSize,
                } satisfies FoldMeta)
                .setMeta("addToHistory", false),
        );

        // Assert: no entry survives to swallow whatever fills the gap.
        expect(folded(v).size).toBe(0);
        expect(foldedHiddenRanges(v.state)).toHaveLength(0);
    });

    it("indenting away the last descendant should reset the item's stale fold", async () => {
        // Arrange: fold bing (only descendant: ding), then lift ding out so
        // bing owns nothing — the entry must clean up like an emptied
        // heading section.
        const editor = await makeEditor(NESTED_LIST);
        const v = view(editor);
        const bing = itemPosByLine(v, "bing");
        toggle(v, bing);
        const hidden = foldHiddenRange(v.state.doc, bing)!;

        // Act: delete the nested list under bing (what Shift-Tab/lift ends
        // in structurally: bing has no descendants left).
        v.dispatch(v.state.tr.delete(hidden.from, hidden.to));

        // Assert
        expect(folded(v).size).toBe(0);
    });

    it("ArrowLeft on a block-selected list should fold every foldable item", async () => {
        // Arrange: block-select the whole (single-block) list.
        const editor = await makeEditor(NESTED_LIST);
        const v = view(editor);
        const list = v.state.doc.child(0);
        const range = BlockRangeSelection.tryCreate(v.state.doc, 0, list.nodeSize)!;
        v.dispatch(v.state.tr.setSelection(range));

        // Act
        expect(foldSelectedBlocks(true)(v.state, v.dispatch)).toBe(true);

        // Assert: foo, bar, and bing folded; leaves untouched.
        expect(folded(v).has(itemPosByLine(v, "foo"))).toBe(true);
        expect(folded(v).has(itemPosByLine(v, "bing"))).toBe(true);
        expect(folded(v).size).toBe(3);
        // → expands them all again.
        expect(foldSelectedBlocks(false)(v.state, v.dispatch)).toBe(true);
        expect(folded(v).size).toBe(0);
    });

    it("Backspace at a sibling item's start should reveal the previous item's folded tail", async () => {
        // Arrange: bar folded (hides baz); caret at the very start of zap's
        // first line. The join target — where Backspace would put the caret
        // — is baz's line end, INSIDE bar's hidden sublist: joining there
        // buried zap invisibly. (The old guard only ran at depth 1, so list
        // carets never hit it.)
        const editor = await makeEditor("- foo\n- bar\n  - baz\n- zap");
        const v = view(editor);
        const bar = itemPosByLine(v, "bar");
        toggle(v, bar);
        const zap = itemPosByLine(v, "zap");
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, zap + 2)));
        const docBefore = v.state.doc;

        // Act + Assert: reveal instead of joining — zero document steps.
        expect(revealOnBackspace(v.state, v.dispatch)).toBe(true);
        expect(folded(v).size).toBe(0);
        expect(v.state.doc).toBe(docBefore);
        expect(textIsHidden(v, "zap")).toBe(false);
    });

    it("Tab-sinking a folded item should clear its fold, never collapse the next sibling", async () => {
        // Arrange: fold b (hides b1); its next sibling c is itself foldable
        // — exactly where the stale plain-map() entry used to land.
        const editor = await makeEditor("- a\n- b\n  - b1\n- c\n  - c1");
        const v = view(editor);
        const b = itemPosByLine(v, "b");
        toggle(v, b);
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, b + 2)));

        // Act: Tab's sink-keeping-children rebuild.
        const sink = sinkItemKeepingChildren(v.state.schema.nodes["list_item"]!);
        expect(sink(v.state, v.dispatch)).toBe(true);

        // Assert: the rebuild deterministically clears the fold — no entry
        // anywhere, and c's subtree stays visible.
        expect(folded(v).size).toBe(0);
        expect(foldedHiddenRanges(v.state)).toHaveLength(0);
        expect(textIsHidden(v, "c1")).toBe(false);
    });

    it("foldAtCaret on the item's first line should fold the innermost item", async () => {
        // Arrange: caret inside bar's line.
        const editor = await makeEditor(NESTED_LIST);
        const v = view(editor);
        const bar = itemPosByLine(v, "bar");
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, bar + 2)));

        // Act + Assert: innermost (bar) first; repeat bubbles to foo.
        expect(foldAtCaret(v.state, v.dispatch)).toBe(true);
        expect(folded(v).has(bar)).toBe(true);
        expect(foldAtCaret(v.state, v.dispatch)).toBe(true);
        expect(folded(v).has(itemPosByLine(v, "foo"))).toBe(true);
        // unfoldAtCaret peels the innermost folded one back open.
        expect(unfoldAtCaret(v.state, v.dispatch)).toBe(true);
    });
});

describe("table folding (fold to the header row)", () => {
    it("the hidden range should start after the header row and cover the body rows", async () => {
        // Arrange
        const editor = await makeEditor(TABLE);
        const v = view(editor);
        const tablePos = deepPosOf(v, "table");
        const table = v.state.doc.nodeAt(tablePos)!;

        // Act
        const range = foldHiddenRange(v.state.doc, tablePos)!;
        toggle(v, tablePos);

        // Assert
        expect(range.from).toBe(tablePos + 1 + table.firstChild!.nodeSize);
        expect(range.to).toBe(tablePos + table.nodeSize - 1);
        expect(textIsHidden(v, "H1")).toBe(false);
        expect(textIsHidden(v, "a")).toBe(true);
        expect(textIsHidden(v, "c")).toBe(true);
        // The wrapper-facing state channel is the decoration class.
        expect(document.querySelector(".collapsed")).not.toBeNull();
    });

    it("a single-row table should not be foldable", async () => {
        const editor = await makeEditor("| H1 | H2 |\n| --- | --- |");
        const v = view(editor);
        const tablePos = deepPosOf(v, "table");
        expect(foldHiddenRange(v.state.doc, tablePos)).toBeNull();
        toggle(v, tablePos);
        expect(folded(v).size).toBe(0);
    });

    it("editing the header row while folded should stay live and keep the fold", async () => {
        // Arrange
        const editor = await makeEditor(TABLE);
        const v = view(editor);
        const tablePos = deepPosOf(v, "table");
        toggle(v, tablePos);
        const headerText = deepPosOf(v, "table") + 3; // inside the first header cell

        // Act: type into the header.
        v.dispatch(v.state.tr.insertText("X", headerText));

        // Assert: the edit landed, the fold survived on the (unmoved) table.
        expect(v.state.doc.textContent).toContain("X");
        expect(folded(v).has(tablePos)).toBe(true);
        expect(textIsHidden(v, "a")).toBe(true);
    });

    it("a caret dropped into a hidden body row should be ejected", async () => {
        // Arrange
        const editor = await makeEditor(`${TABLE}\n\ntail`);
        const v = view(editor);
        const tablePos = deepPosOf(v, "table");
        toggle(v, tablePos);
        const hidden = foldHiddenRange(v.state.doc, tablePos)!;

        // Act
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, hidden.from + 3)));

        // Assert
        expect(
            v.state.selection.from >= hidden.to || v.state.selection.to <= hidden.from,
        ).toBe(true);
    });

    it("Backspace at the block after a collapsed table should reveal instead of editing", async () => {
        // Arrange
        const editor = await makeEditor(`${TABLE}\n\ntail`);
        const v = view(editor);
        const tablePos = deepPosOf(v, "table");
        toggle(v, tablePos);
        const table = v.state.doc.nodeAt(tablePos)!;
        v.dispatch(
            v.state.tr.setSelection(
                TextSelection.create(v.state.doc, tablePos + table.nodeSize + 1),
            ),
        );
        const docBefore = v.state.doc;

        // Act + Assert
        expect(revealOnBackspace(v.state, v.dispatch)).toBe(true);
        expect(folded(v).size).toBe(0);
        expect(v.state.doc).toBe(docBefore);
    });
});

describe("code block folding (fold to the chrome row)", () => {
    it("a plain fence should hide its whole content and eject a resting caret", async () => {
        // Arrange
        const editor = await makeEditor("```js\nconst x = 1;\nconst y = 2;\n```\n\ntail");
        const v = view(editor);
        const codePos = deepPosOf(v, "code_block");
        const node = v.state.doc.nodeAt(codePos)!;

        // Act
        const range = foldHiddenRange(v.state.doc, codePos)!;
        toggle(v, codePos);
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, codePos + 3)));

        // Assert
        expect(range).toEqual({ from: codePos + 1, to: codePos + node.nodeSize - 1 });
        expect(folded(v).has(codePos)).toBe(true);
        expect(document.querySelector(".collapsed")).not.toBeNull();
        expect(
            v.state.selection.from >= range.to || v.state.selection.to <= range.from,
        ).toBe(true);
    });

    it("an empty fence should not be foldable", async () => {
        const editor = await makeEditor("```js\n```");
        const v = view(editor);
        const codePos = deepPosOf(v, "code_block");
        expect(foldHiddenRange(v.state.doc, codePos)).toBeNull();
        toggle(v, codePos);
        expect(folded(v).size).toBe(0);
    });

    it("math and mermaid fences should fold like any code block (same node type)", async () => {
        // Arrange
        const editor = await makeEditor("```mermaid\ngraph TD; A-->B;\n```\n\n```latex\nE=mc^2\n```");
        const v = view(editor);
        const positions: number[] = [];
        v.state.doc.forEach((node, offset) => {
            if (node.type.name === "code_block") {
                positions.push(offset);
            }
        });
        expect(positions).toHaveLength(2);

        // Act
        toggle(v, positions[0]!);
        toggle(v, positions[1]!);

        // Assert
        expect(folded(v).size).toBe(2);
        expect(document.querySelectorAll(".collapsed")).toHaveLength(2);
    });

    it("a caret landing at a folded fence's final text position should be ejected forward", async () => {
        // Arrange: `range.to` IS a valid text position inside a code block
        // (the fence text's end) — the old half-open guard let the caret
        // rest, and type, there invisibly.
        const editor = await makeEditor("intro\n\n```js\nconst x = 1;\n```\n\ntail");
        const v = view(editor);
        const codePos = deepPosOf(v, "code_block");
        toggle(v, codePos);
        const range = foldHiddenRange(v.state.doc, codePos)!;

        // Act: land exactly at range.to, travelling forward from "intro".
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, range.to)));

        // Assert: ejected clear of the whole hidden span (inclusive at to);
        // typing lands in visible content, never in the fence.
        const sel = v.state.selection;
        expect(sel.from < range.from || sel.from > range.to).toBe(true);
        v.dispatch(v.state.tr.insertText("X"));
        expect(textIsHidden(v, "X")).toBe(false);
        expect(v.state.doc.nodeAt(deepPosOf(v, "code_block"))!.textContent).toBe("const x = 1;");
    });

    it("ArrowLeft-style entry from below a folded fence should eject backward past the block", async () => {
        // Arrange
        const editor = await makeEditor("intro\n\n```js\nconst x = 1;\n```\n\ntail");
        const v = view(editor);
        const codePos = deepPosOf(v, "code_block");
        toggle(v, codePos);
        const range = foldHiddenRange(v.state.doc, codePos)!;
        const tailStart = codePos + v.state.doc.nodeAt(codePos)!.nodeSize + 1;
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, tailStart)));

        // Act: move backward onto range.to (what ArrowLeft from tail does).
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, range.to)));

        // Assert: ejected BEFORE the block, not parked on hidden fence text.
        expect(v.state.selection.from).toBeLessThan(codePos);
    });

    it("folding a code block with the caret at its text end should leave the caret outside", async () => {
        // Arrange: caret at the fence text's last position — exactly the
        // spot the fold-time escape used to skip (selection.from < range.to
        // was false) while the caret guard's half-open filter also missed.
        const editor = await makeEditor("intro\n\n```js\nconst x = 1;\n```\n\ntail");
        const v = view(editor);
        const codePos = deepPosOf(v, "code_block");
        const range = foldHiddenRange(v.state.doc, codePos)!;
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, range.to)));

        // Act
        toggle(v, codePos);

        // Assert: caret outside the hidden span; typing never edits the fence.
        const sel = v.state.selection;
        expect(sel.from < range.from || sel.from > range.to).toBe(true);
        v.dispatch(v.state.tr.insertText("Y"));
        expect(v.state.doc.nodeAt(deepPosOf(v, "code_block"))!.textContent).toBe("const x = 1;");
    });

    it("a code block inside a list item should not be foldable (chrome parity)", async () => {
        const editor = await makeEditor("- item\n\n  ```js\n  const x = 1;\n  ```\n\ntail");
        const v = view(editor);
        const codePos = deepPosOf(v, "code_block");
        expect(foldHiddenRange(v.state.doc, codePos)).toBeNull();
        toggle(v, codePos);
        expect(folded(v).has(codePos)).toBe(false);
    });
});

/**
 * MAR-116 — the chrome-less containers. A blockquote and a Notion `<aside>`
 * have no title bar of their own: their FIRST CHILD BLOCK is the line the
 * fold keeps, exactly as a list item's is. The aside is the one to watch —
 * folding it to its node boundary (the `callout` grammar) would hide the
 * emoji line that names it, because that line is document content here and
 * an attr-held title bar there.
 */
describe("blockquote and Notion-aside folding (fold to the first line)", () => {
    const QUOTE = "> first line\n>\n> second block\n>\n> third block";
    const ASIDE = "<aside>\n💡 First line\n\nsecond block\n\n</aside>";

    it("folding a quote should hide everything after its first line", async () => {
        // Arrange
        const editor = await makeEditor(QUOTE);
        const v = view(editor);
        const quotePos = deepPosOf(v, "blockquote");
        const quote = v.state.doc.nodeAt(quotePos)!;

        // Act
        const range = foldHiddenRange(v.state.doc, quotePos)!;
        toggle(v, quotePos);

        // Assert
        expect(range.from).toBe(quotePos + 1 + quote.firstChild!.nodeSize);
        expect(range.to).toBe(quotePos + quote.nodeSize - 1);
        expect(textIsHidden(v, "first line")).toBe(false);
        expect(textIsHidden(v, "second block")).toBe(true);
        expect(textIsHidden(v, "third block")).toBe(true);
        // The tail is hidden by decoration; the first line keeps its own DOM.
        expect(document.querySelectorAll("blockquote > .heading-fold-hidden")).toHaveLength(2);
        expect(document.querySelector("blockquote > p:first-of-type")?.className ?? "").not.toContain(
            "heading-fold-hidden",
        );
    });

    it("the collapsed quote's first line should trail an ellipsis whose click expands", async () => {
        // Arrange
        const editor = await makeEditor(QUOTE);
        const v = view(editor);
        toggle(v, deepPosOf(v, "blockquote"));

        // Act + Assert: the shared `…` chip, mounted in the visible line.
        const ellipsis = document.querySelector<HTMLButtonElement>("blockquote .fold-ellipsis");
        expect(ellipsis).not.toBeNull();
        ellipsis!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        expect(folded(v).size).toBe(0);
    });

    it("a one-block quote should not be foldable", async () => {
        const editor = await makeEditor("> only line");
        const v = view(editor);
        const quotePos = deepPosOf(v, "blockquote");
        expect(foldHiddenRange(v.state.doc, quotePos)).toBeNull();
        toggle(v, quotePos);
        expect(folded(v).size).toBe(0);
    });

    it("a quote that OPENS with a list should not fold; the first item's chevron does", async () => {
        // The stub-rule decision (MAR-116): a container whose first child is
        // not itself a line has no line of its own to fold to — collapsing it
        // would leave that whole first structure on screen under a chevron
        // claiming to have hidden it. The capability moves to the item.
        const editor = await makeEditor("> - alpha\n>   - beta\n> - gamma\n>\n> trailing");
        const v = view(editor);
        const quotePos = deepPosOf(v, "blockquote");

        expect(foldHiddenRange(v.state.doc, quotePos)).toBeNull();
        toggle(v, quotePos);
        expect(folded(v).size).toBe(0);
        // No dead chevron on the quote; the item that owns the line has one.
        expect(document.querySelectorAll("blockquote > .heading-fold-gutter--foldable")).toHaveLength(0);
        expect(foldHiddenRange(v.state.doc, itemPosByLine(v, "alpha"))).not.toBeNull();
    });

    it("a quote opening with a heading should fold (a heading IS a line)", async () => {
        const editor = await makeEditor("> # Title\n>\n> body");
        const v = view(editor);
        const quotePos = deepPosOf(v, "blockquote");
        toggle(v, quotePos);
        expect(textIsHidden(v, "Title")).toBe(false);
        expect(textIsHidden(v, "body")).toBe(true);
    });

    it("a caret dropped into a collapsed quote's hidden tail should be ejected", async () => {
        // Arrange
        const editor = await makeEditor(`${QUOTE}\n\ntail`);
        const v = view(editor);
        const quotePos = deepPosOf(v, "blockquote");
        toggle(v, quotePos);
        const hidden = foldHiddenRange(v.state.doc, quotePos)!;

        // Act
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, hidden.from + 3)));

        // Assert
        expect(
            v.state.selection.from >= hidden.to || v.state.selection.to <= hidden.from,
        ).toBe(true);
    });

    it("Cmd+Alt+[ inside a quote's tail should leave the caret on its first line", async () => {
        // A chrome-less container keeps a visible, editable line, so the fold
        // command's escape stays LOCAL to it (foldEscapeSelection) rather than
        // parking the caret before the block the way a collapsed callout,
        // directive or code block has to.
        // `intro` matters: with no block before the quote, an escape aimed
        // BEFORE it falls forward into the quote's own first line anyway, and
        // the two candidate landings would be equal by construction.
        const editor = await makeEditor(`intro\n\n${QUOTE}`);
        const v = view(editor);
        const quotePos = deepPosOf(v, "blockquote");
        const range = foldHiddenRange(v.state.doc, quotePos)!;
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, range.from + 2)));

        // Act
        expect(foldAtCaret(v.state, v.dispatch)).toBe(true);

        // Assert: inside the quote, before its hidden tail — its first line.
        expect(folded(v).has(quotePos)).toBe(true);
        expect(v.state.selection.from).toBeGreaterThan(quotePos);
        expect(v.state.selection.from).toBeLessThan(range.from);
    });

    it("toggling a quote fold should leave state.doc reference-identical", async () => {
        const editor = await makeEditor(QUOTE);
        const v = view(editor);
        const docBefore = v.state.doc;
        const quotePos = deepPosOf(v, "blockquote");
        toggle(v, quotePos);
        toggle(v, quotePos);
        expect(v.state.doc).toBe(docBefore);
    });

    it("folding a Notion aside should KEEP its first line, never hide the whole body", async () => {
        // Arrange
        const editor = await makeEditor(ASIDE);
        const v = view(editor);
        const asidePos = deepPosOf(v, "notion_callout");
        const aside = v.state.doc.nodeAt(asidePos)!;

        // Act
        const range = foldHiddenRange(v.state.doc, asidePos)!;
        toggle(v, asidePos);

        // Assert: the emoji line is CONTENT here — a callout-style whole-body
        // fold (from === asidePos + 1) would take the aside's title with it.
        expect(range.from).toBe(asidePos + 1 + aside.firstChild!.nodeSize);
        expect(textIsHidden(v, "First line")).toBe(false);
        expect(textIsHidden(v, "second block")).toBe(true);
        expect(document.querySelector(".callout-aside.collapsed")).not.toBeNull();
        expect(document.querySelector(".callout-aside .fold-ellipsis")).not.toBeNull();
    });

    it("a Notion aside with only its first line should not be foldable", async () => {
        const editor = await makeEditor("<aside>\n💡 Only a line\n\n</aside>");
        const v = view(editor);
        const asidePos = deepPosOf(v, "notion_callout");
        expect(foldHiddenRange(v.state.doc, asidePos)).toBeNull();
        toggle(v, asidePos);
        expect(folded(v).size).toBe(0);
    });
});

/**
 * MAR-116 — the chrome-bearing containers. A container directive keeps its
 * header (name badge + title) and a footnote definition its label marker,
 * both held OUTSIDE the document content, so the fold hides the whole body
 * exactly as a callout's does.
 */
describe("directive and footnote-definition folding (fold to the chrome row)", () => {
    it("a directive should hide its whole body, header row untouched", async () => {
        // Arrange
        const editor = await makeEditor(":::note Title\nbody para\n\nsecond para\n:::");
        const v = view(editor);
        const pos = deepPosOf(v, "container_directive");
        const node = v.state.doc.nodeAt(pos)!;

        // Act
        const range = foldHiddenRange(v.state.doc, pos)!;
        toggle(v, pos);

        // Assert: the title lives in an attr, so nothing hidden is chrome.
        expect(range).toEqual({ from: pos + 1, to: pos + node.nodeSize - 1 });
        expect(node.attrs["title"]).toBe("Title");
        expect(textIsHidden(v, "body para")).toBe(true);
        expect(textIsHidden(v, "second para")).toBe(true);
        expect(document.querySelector(".container-directive.collapsed")).not.toBeNull();
    });

    it("an empty directive should not be foldable", async () => {
        const editor = await makeEditor(":::note\n\n:::");
        const v = view(editor);
        const pos = deepPosOf(v, "container_directive");
        expect(foldHiddenRange(v.state.doc, pos)).toBeNull();
        toggle(v, pos);
        expect(folded(v).size).toBe(0);
    });

    it("a footnote definition should hide its whole body, label marker untouched", async () => {
        // Arrange
        const editor = await makeEditor("ref[^1]\n\n[^1]: the note\n\n    a second para");
        const v = view(editor);
        const pos = deepPosOf(v, "footnote_definition");
        const node = v.state.doc.nodeAt(pos)!;

        // Act
        const range = foldHiddenRange(v.state.doc, pos)!;
        toggle(v, pos);

        // Assert: the label is an attr, so the badge survives the fold.
        expect(range).toEqual({ from: pos + 1, to: pos + node.nodeSize - 1 });
        expect(node.attrs["label"]).toBe("1");
        expect(textIsHidden(v, "the note")).toBe(true);
        expect(textIsHidden(v, "a second para")).toBe(true);
        expect(textIsHidden(v, "ref")).toBe(false);
    });

    it("a caret in a directive body should be ejected when the body folds", async () => {
        // The plugin's own caret guard, over a kind it had never seen: an
        // interior-hiding fold ejects to the OWNING node's edges, because
        // Selection.near inside a collapsed body returns hidden positions.
        const editor = await makeEditor("intro\n\n:::note T\nbody\n:::");
        const v = view(editor);
        const pos = deepPosOf(v, "container_directive");
        const range = foldHiddenRange(v.state.doc, pos)!;
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, range.from + 1)));

        // Act
        toggle(v, pos);

        // Assert
        expect(v.state.selection.from).toBeLessThanOrEqual(pos);
    });
});

/**
 * The chrome-parity invariant, from the other side: the model refuses a fold
 * for anything but an ITEM inside a list item, so the decoration pass must
 * not paint a chevron there either. It used to (a nested callout's chevron
 * was a control that did nothing when clicked).
 */
describe("no fold chrome where the model refuses a fold", () => {
    it("a callout inside a list item should render no chevron at all", async () => {
        // Arrange
        const editor = await makeEditor("- item\n\n  > [!note] T\n  > body\n\ntail");
        const v = view(editor);
        const calloutPos = deepPosOf(v, "callout");

        // Assert: model refuses, and no gutter offers it.
        expect(foldHiddenRange(v.state.doc, calloutPos)).toBeNull();
        const chevrons = document.querySelectorAll(".callout .heading-fold-gutter--foldable");
        expect(chevrons).toHaveLength(0);
        // The item itself still folds — this is a parity fix, not a removal.
        expect(document.querySelectorAll("li > .heading-fold-gutter--foldable")).toHaveLength(1);
    });

    it("a blockquote inside a list item should render no chevron either", async () => {
        const editor = await makeEditor("- item\n\n  > first\n  >\n  > second\n\ntail");
        const v = view(editor);
        const quotePos = deepPosOf(v, "blockquote");
        expect(foldHiddenRange(v.state.doc, quotePos)).toBeNull();
        expect(document.querySelectorAll("blockquote > .heading-fold-gutter--foldable")).toHaveLength(0);
    });
});

describe("Fold All scope (one grammar, every foldable)", () => {
    const MIXED = [
        "# Section",
        "",
        "body",
        "",
        NESTED_LIST,
        "",
        TABLE,
        "",
        "```js",
        "const x = 1;",
        "```",
        "",
        "> [!note] T",
        "> callout body",
    ].join("\n");

    it("foldAll should fold headings, callouts, list items, tables, and code blocks", async () => {
        // Arrange
        const editor = await makeEditor(MIXED);
        const v = view(editor);

        // Act
        expect(foldAllCommand(v.state, v.dispatch)).toBe(true);

        // Assert: 1 heading + 3 foldable items + 1 table + 1 code + 1 callout.
        expect(folded(v).size).toBe(allFoldablePositions(v.state.doc).length);
        expect(folded(v).size).toBe(7);
        expect(folded(v).has(itemPosByLine(v, "foo"))).toBe(true);
        expect(folded(v).has(deepPosOf(v, "table"))).toBe(true);
        expect(folded(v).has(deepPosOf(v, "code_block"))).toBe(true);
    });

    it("persistence anchors should round-trip items, tables, and code blocks", async () => {
        // Arrange
        const editor = await makeEditor(MIXED);
        const v = view(editor);
        const foldedSet = new Set([
            itemPosByLine(v, "foo"),
            itemPosByLine(v, "bar"),
            deepPosOf(v, "table"),
            deepPosOf(v, "code_block"),
        ]);

        // Act
        const anchors = computeFoldAnchors(v.state.doc, foldedSet);
        const restored = resolveFoldAnchors(v.state.doc, anchors);

        // Assert
        expect(anchors.blocks).toHaveLength(4);
        expect(anchors.headings).toHaveLength(0);
        expect(restored).toEqual(foldedSet);
    });

    it("stale block anchors (and pre-MAR-125 bags without a blocks array) resolve silently", async () => {
        // Arrange
        const editor = await makeEditor("just a paragraph");
        const v = view(editor);

        // Act + Assert: garbage paths drop; a legacy bag missing `blocks`
        // must not throw.
        expect(
            resolveFoldAnchors(v.state.doc, { headings: [], callouts: [], blocks: ["9/9", "0", "x"] }).size,
        ).toBe(0);
        expect(
            resolveFoldAnchors(v.state.doc, { headings: [], callouts: [] } as never).size,
        ).toBe(0);
    });
});

/**
 * MAR-263 — the exhaustiveness sweep. The matrices above pin the BEHAVIOR of
 * the kinds that fold; nothing above notices a kind that never entered the
 * grammar. These sweeps mirror gutterCoverage: every block node type is
 * either proven foldable (a fixture whose instance yields a non-null
 * foldHiddenRange through the real editor — behavioral, so a broken kind
 * predicate goes red here, not just unlisted) or consciously allowlisted
 * with a reason. Adding a block node type with neither fails at build time.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Markdown per foldable kind, containing at least one instance of the kind
 * that IS foldable (has a body/descendants). Listing a kind here is the
 * "this folds" half of the decision; the liveness test below proves it.
 */
const FOLDABLE_FIXTURES: Record<string, string> = {
    "heading": "# Head\n\nbody",
    "callout": "> [!note] T\n> body",
    "list_item": "- parent\n  - child",
    "table": "| H |\n| --- |\n| a |",
    "code_block": "```js\nconst x = 1;\n```",
    "blockquote": "> first line\n>\n> tail",
    "notion_callout": "<aside>\n💡 First line\n\nbody\n\n</aside>",
    "container_directive": ":::note Title\nbody\n:::",
    "footnote_definition": "ref[^1]\n\n[^1]: the note",
};

/**
 * Block node types that deliberately do NOT fold. Every entry needs a
 * reason — this list is the single place "no fold" is allowed.
 */
const NOT_FOLDABLE_ALLOWLIST: Record<string, string> = {
    "doc": "the document itself",
    "paragraph": "single prose block — it IS its own first line; nothing beyond it to hide",
    "hr": "leaf atom — nothing to hide",
    "link_definition": "leaf atom; orphaned definitions only",
    "bullet_list": "the fold unit is the list ITEM (first-line semantics); the list node has no line of its own to fold to",
    "ordered_list": "per-ITEM folds — same as bullet_list",
    "table_header_row": "table interior — the TABLE folds as a unit, to this very row",
    "table_row": "table interior — hidden by the table's own fold",
    "table_header": "table interior",
    "table_cell": "table interior",
    "mdx_block": "opaque mdx island (MAR-42) — leaf atom whose source is one attr; nothing beyond its own rendering to hide",
};

describe("every block type has a fold decision (MAR-263)", () => {
    it("preset schema: each block node type is foldable by fixture or allowlisted with a reason", async () => {
        const editor = await makeEditor("seed");
        const schema = editor.action((ctx) => ctx.get(schemaCtx));

        const blockTypes = Object.entries(schema.nodes)
            .filter(([, type]) => type.isBlock)
            .map(([name]) => name);

        const undecided: string[] = [];
        for (const name of blockTypes) {
            const foldable = name in FOLDABLE_FIXTURES;
            const allowlisted = name in NOT_FOLDABLE_ALLOWLIST;
            if (foldable && allowlisted) {
                undecided.push(`${name} (in BOTH lists — resolve the contradiction)`);
            } else if (!foldable && !allowlisted) {
                undecided.push(name);
            }
        }
        expect(
            undecided,
            "Block node types with NO fold decision. Either the fold grammar covers " +
                "them (foldHiddenRange in webview/plugins/headingFold/foldModel.ts — add a " +
                "FOLDABLE_FIXTURES entry proving it) or they consciously don't fold (add " +
                "them to NOT_FOLDABLE_ALLOWLIST here with a reason).",
        ).toEqual([]);

        // Both lists stay honest: an entry for a node type the schema no
        // longer has is a stale decision, not a decision.
        const stale = [
            ...Object.keys(FOLDABLE_FIXTURES),
            ...Object.keys(NOT_FOLDABLE_ALLOWLIST),
        ].filter((name) => !(name in schema.nodes));
        expect(stale, "fold decisions for node types that no longer exist").toEqual([]);

        // The sweep asserts its own reach: a loop that enumerated nothing
        // reports no undecided types and passes saying nothing at all. The
        // floor is the decision lists themselves (no magic number), which
        // also catches a decision recorded for an INLINE node type.
        expect(
            blockTypes.length,
            "the schema sweep did not enumerate one block node type per fold decision",
        ).toBe(Object.keys(FOLDABLE_FIXTURES).length + Object.keys(NOT_FOLDABLE_ALLOWLIST).length);
    });

    it("each FOLDABLE_FIXTURES entry demonstrates a live fold through the real editor", async () => {
        for (const [name, markdown] of Object.entries(FOLDABLE_FIXTURES)) {
            const editor = await makeEditor(markdown);
            const v = view(editor);
            let seen = 0;
            let foldable = false;
            v.state.doc.descendants((node, pos) => {
                if (node.type.name === name) {
                    seen++;
                    if (foldHiddenRange(v.state.doc, pos) !== null) {
                        foldable = true;
                    }
                }
                return true;
            });
            expect(seen, `${name}: fixture parses to no ${name} node`).toBeGreaterThan(0);
            expect(
                foldable,
                `${name}: claimed foldable but no fixture instance yields a hidden range — ` +
                    "either the fold grammar regressed or the fixture no longer builds a " +
                    "foldable instance",
            ).toBe(true);
        }
    });

    it("plugin schemas: every $nodeSchema id has a fold decision", () => {
        // Static sweep (mirrors gutterCoverage): node ids registered by our
        // own plugins, so a plugin node the preset editor doesn't load still
        // needs a decision. Inline node ids can't fold by construction.
        const INLINE: Record<string, string> = {
            "footnote_reference": "inline atom despite isBlock quirks in some presets",
            "math_inline": "inline atom",
            "wiki_link": "inline atom",
            "image_ref": "inline atom (![alt][ref] chip)",
            "mdx_inline": "inline atom (opaque mdx island, MAR-42)",
        };
        const files: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === "__tests__" || entry.name === "node_modules") continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith(".ts")) files.push(full);
            }
        };
        walk(path.join(REPO_ROOT, "webview"));
        const ids: string[] = [];
        for (const full of files) {
            const source = fs.readFileSync(full, "utf8");
            for (const match of source.matchAll(/\$nodeSchema[(<][^)]*?["']([\w-]+)["']/g)) {
                ids.push(match[1]!);
            }
            // $nodeSchema(directiveId, ...) style — resolve exported id consts
            for (const match of source.matchAll(/const (\w+Id) = ["']([\w-]+)["']/g)) {
                if (source.includes(`$nodeSchema(${match[1]}`)) {
                    ids.push(match[2]!);
                }
            }
        }
        expect(ids.length).toBeGreaterThanOrEqual(4); // sanity: the sweep found the known ones
        const unexplained = [...new Set(ids)].filter(
            (id) => !(id in FOLDABLE_FIXTURES) && !(id in NOT_FOLDABLE_ALLOWLIST) && !(id in INLINE),
        );
        expect(
            unexplained,
            "New plugin node types with no fold decision. Prove them foldable in " +
                "FOLDABLE_FIXTURES, or record them in NOT_FOLDABLE_ALLOWLIST (or INLINE) " +
                "with a reason.",
        ).toEqual([]);
    });
});
