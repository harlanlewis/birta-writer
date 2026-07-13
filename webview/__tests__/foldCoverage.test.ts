/**
 * MAR-125 — fold-grammar coverage for the three structures beyond headings
 * and callouts: nested list items (fold to the first line, heading-section
 * semantics applied to list nesting), tables (fold to the header row), and
 * code blocks incl. math/mermaid fences (fold to the chrome row). Driven
 * through the REAL Milkdown editor (real parser, real schema) like
 * foldPlugin.test.ts, so position math matches production.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, pureCommonmark } from "../serialization";
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
        .use(gfm)
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
