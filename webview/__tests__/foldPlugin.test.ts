/**
 * The unified fold grammar (MAR-110): one kind-agnostic fold plugin over
 * headings and callouts, driven through the REAL Milkdown editor (real
 * parser, real schema, production serialization) so position math matches
 * production. Covers the hard invariants (zero-step toggles: `state.doc`
 * stays reference-identical), the collapsed `…` representation, the fold
 * commands (innermost + bubble), block-selection ←/→, boundary reveals,
 * `editor.folding` off, and the structural persistence anchors.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../serialization";
import {
    allFoldablePositions,
    computeFoldAnchors,
    foldAllCommand,
    foldAtCaret,
    foldHiddenRange,
    foldPluginKey,
    foldedHiddenRanges,
    headingFoldPlugin,
    resolveFoldAnchors,
    revealOnBackspace,
    revealOnDelete,
    revealPosition,
    unfoldAllCommand,
    unfoldAtCaret,
    type FoldMeta,
} from "../plugins/headingFold";
import { foldSelectedBlocks } from "../plugins/blockKeys";
import { BlockRangeSelection } from "../plugins/blockRange";

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

/** Document position of the first top-level node of the given type. */
function posOf(v: EditorView, typeName: string): number {
    let pos = -1;
    v.state.doc.forEach((node, offset) => {
        if (pos === -1 && node.type.name === typeName) {
            pos = offset;
        }
    });
    expect(pos, `no top-level ${typeName}`).toBeGreaterThanOrEqual(0);
    return pos;
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

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
    document.body.className = "";
});

describe("zero-step toggle invariant", () => {
    it("toggling a heading fold should leave state.doc reference-identical", async () => {
        // Arrange
        const editor = await makeEditor("## Title\n\nBody");
        const v = view(editor);
        const docBefore = v.state.doc;
        const pos = posOf(v, "heading");

        // Act
        toggle(v, pos);
        expect(folded(v).has(pos)).toBe(true);
        toggle(v, pos);

        // Assert
        expect(folded(v).has(pos)).toBe(false);
        expect(v.state.doc).toBe(docBefore);
    });

    it("toggling a callout fold should leave state.doc reference-identical", async () => {
        // Arrange
        const editor = await makeEditor("> [!note] T\n> Body.\n\nAfter");
        const v = view(editor);
        const docBefore = v.state.doc;
        const pos = posOf(v, "callout");

        // Act
        toggle(v, pos);
        expect(folded(v).has(pos)).toBe(true);
        toggle(v, pos);

        // Assert
        expect(folded(v).has(pos)).toBe(false);
        expect(v.state.doc).toBe(docBefore);
        expect(editor.action(getMarkdown())).toContain("[!note]");
    });
});

describe("fold hidden ranges (the one fold-range map)", () => {
    it("a heading hides its section OUTSIDE the node and a callout its body INSIDE", async () => {
        // Arrange
        const editor = await makeEditor("## H\n\nBody\n\n> [!note] T\n> Quote body.");
        const v = view(editor);
        const headingPos = posOf(v, "heading");
        const calloutPos = posOf(v, "callout");
        const headingNode = v.state.doc.nodeAt(headingPos)!;
        const calloutNode = v.state.doc.nodeAt(calloutPos)!;

        // Act
        const headingRange = foldHiddenRange(v.state.doc, headingPos)!;
        const calloutRange = foldHiddenRange(v.state.doc, calloutPos)!;
        toggle(v, headingPos);
        toggle(v, calloutPos);

        // Assert
        expect(headingRange.from).toBe(headingPos + headingNode.nodeSize);
        expect(calloutRange).toEqual({ from: calloutPos + 1, to: calloutPos + calloutNode.nodeSize - 1 });
        expect(foldedHiddenRanges(v.state)).toHaveLength(2);
    });

    it("an empty callout should not be foldable", async () => {
        const editor = await makeEditor("> [!note]\n");
        const v = view(editor);
        const pos = posOf(v, "callout");
        expect(foldHiddenRange(v.state.doc, pos)).toBeNull();
        toggle(v, pos);
        expect(folded(v).has(pos)).toBe(false);
    });
});

describe("collapsed representation", () => {
    it("a collapsed heading should render a fold-ellipsis whose click expands", async () => {
        // Arrange
        const editor = await makeEditor("## Title\n\nOne\n\nTwo");
        const v = view(editor);
        const pos = posOf(v, "heading");
        toggle(v, pos);

        // Assert: the `…` sits at the heading line's end, naming the count.
        const ellipsis = document.querySelector<HTMLButtonElement>("h2 .fold-ellipsis");
        expect(ellipsis).not.toBeNull();
        expect(ellipsis!.getAttribute("aria-label")).toContain("2 blocks hidden");

        // Act: clicking expands (mirrors editor.unfoldOnClickAfterEndOfLine).
        ellipsis!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        expect(folded(v).size).toBe(0);
        expect(document.querySelector(".fold-ellipsis")).toBeNull();
    });

    it("a collapsed callout should carry the collapsed class as a decoration", async () => {
        // Arrange: no NodeView here — the decoration must land on the default
        // DOM too (the class is the state channel, not NodeView bookkeeping).
        const editor = await makeEditor("> [!note] T\n> Body.\n");
        const v = view(editor);
        const pos = posOf(v, "callout");

        // Act
        toggle(v, pos);

        // Assert
        expect(document.querySelector(".callout.collapsed")).not.toBeNull();
        toggle(v, pos);
        expect(document.querySelector(".callout.collapsed")).toBeNull();
    });

    it("a [!kind]- syntax marker should seed the collapsed state at init", async () => {
        const editor = await makeEditor("> [!tip]- Folded\n> Hidden.\n");
        const v = view(editor);
        expect(folded(v).has(posOf(v, "callout"))).toBe(true);
    });
});

describe("fold commands", () => {
    it("foldAtCaret should fold the innermost foldable and bubble to the ancestor on repeat", async () => {
        // Arrange: a callout inside a heading's section; caret in the body.
        const editor = await makeEditor("## H\n\n> [!note] T\n> Inner body.\n\nTail");
        const v = view(editor);
        const headingPos = posOf(v, "heading");
        const calloutPos = posOf(v, "callout");
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, calloutPos + 3)));

        // Act + Assert: innermost (the callout) first…
        expect(foldAtCaret(v.state, v.dispatch)).toBe(true);
        expect(folded(v).has(calloutPos)).toBe(true);
        expect(folded(v).has(headingPos)).toBe(false);
        // …then the caret was ejected out of the hidden body; folding again
        // from the new caret bubbles to the heading.
        expect(foldAtCaret(v.state, v.dispatch)).toBe(true);
        expect(folded(v).has(headingPos)).toBe(true);
    });

    it("unfoldAtCaret on a collapsed heading line should unfold it", async () => {
        // Arrange
        const editor = await makeEditor("## H\n\nBody");
        const v = view(editor);
        const pos = posOf(v, "heading");
        toggle(v, pos);
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos + 1)));

        // Act + Assert
        expect(unfoldAtCaret(v.state, v.dispatch)).toBe(true);
        expect(folded(v).size).toBe(0);
        expect(unfoldAtCaret(v.state, v.dispatch)).toBe(false);
    });

    it("foldAll should fold every foldable and unfoldAll should clear them", async () => {
        // Arrange
        const editor = await makeEditor("# A\n\ntext\n\n## B\n\nmore\n\n> [!note] T\n> body");
        const v = view(editor);

        // Act
        expect(foldAllCommand(v.state, v.dispatch)).toBe(true);

        // Assert
        expect(folded(v).size).toBe(allFoldablePositions(v.state.doc).length);
        expect(folded(v).size).toBeGreaterThanOrEqual(3);
        expect(unfoldAllCommand(v.state, v.dispatch)).toBe(true);
        expect(folded(v).size).toBe(0);
        expect(unfoldAllCommand(v.state, v.dispatch)).toBe(false);
    });

    it("a document with nothing foldable should make foldAll a no-op returning false", async () => {
        const editor = await makeEditor("just a paragraph");
        const v = view(editor);
        expect(foldAllCommand(v.state, v.dispatch)).toBe(false);
    });
});

describe("block-selection arrow folding (←/→)", () => {
    it("ArrowLeft on a block-selected heading should fold it and keep consuming the key", async () => {
        // Arrange: block-select the heading (its unit).
        const editor = await makeEditor("## H\n\nBody\n\nTail");
        const v = view(editor);
        const pos = posOf(v, "heading");
        const node = v.state.doc.nodeAt(pos)!;
        const range = BlockRangeSelection.tryCreate(v.state.doc, pos, pos + node.nodeSize)!;
        v.dispatch(v.state.tr.setSelection(range));

        // Act + Assert: ← folds; a second ← still consumes (fold verb, not
        // a selection exit); → expands.
        expect(foldSelectedBlocks(true)(v.state, v.dispatch)).toBe(true);
        expect(folded(v).has(pos)).toBe(true);
        expect(foldSelectedBlocks(true)(v.state, v.dispatch)).toBe(true);
        expect(foldSelectedBlocks(false)(v.state, v.dispatch)).toBe(true);
        expect(folded(v).has(pos)).toBe(false);
    });

    it("a plain caret should fall through (no block selection, no fold)", async () => {
        const editor = await makeEditor("## H\n\nBody");
        const v = view(editor);
        expect(foldSelectedBlocks(true)(v.state, v.dispatch)).toBe(false);
        expect(folded(v).size).toBe(0);
    });
});

describe("caret skip-over and boundary reveals", () => {
    it("a caret landing inside a hidden range should be ejected past the fold", async () => {
        // Arrange
        const editor = await makeEditor("## H\n\nHidden body\n\nTail");
        const v = view(editor);
        const pos = posOf(v, "heading");
        toggle(v, pos);
        const hidden = foldHiddenRange(v.state.doc, pos)!;

        // Act: programmatically drop the caret inside the hidden paragraph.
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, hidden.from + 2)));

        // Assert: the guard moved it out (forward, past the fold).
        expect(v.state.selection.from >= hidden.to || v.state.selection.to <= hidden.from).toBe(true);
    });

    it("Backspace at the block after a collapsed section should reveal instead of editing", async () => {
        // Arrange: collapse H (its section ends at the sibling heading);
        // caret at the very start of that next visible block.
        const editor = await makeEditor("## H\n\nHidden\n\n## Next");
        const v = view(editor);
        const pos = posOf(v, "heading");
        toggle(v, pos);
        const docBefore = v.state.doc;
        const hidden = foldHiddenRange(v.state.doc, pos)!;
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, hidden.to + 1)));

        // Act + Assert
        expect(revealOnBackspace(v.state, v.dispatch)).toBe(true);
        expect(folded(v).size).toBe(0);
        expect(v.state.doc).toBe(docBefore);
        // Expanded now: a second Backspace falls through to normal editing.
        expect(revealOnBackspace(v.state, v.dispatch)).toBe(false);
    });

    it("Delete at the end of a collapsed heading line should reveal instead of editing", async () => {
        // Arrange
        const editor = await makeEditor("## H\n\nHidden");
        const v = view(editor);
        const pos = posOf(v, "heading");
        toggle(v, pos);
        const node = v.state.doc.nodeAt(pos)!;
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos + node.nodeSize - 1)));

        // Act + Assert
        expect(revealOnDelete(v.state, v.dispatch)).toBe(true);
        expect(folded(v).size).toBe(0);
    });

    it("revealPosition should unfold every fold containing the target", async () => {
        // Arrange: nested folds — H1 section containing a collapsed H2.
        const editor = await makeEditor("# A\n\n## B\n\nDeep\n\nTail");
        const v = view(editor);
        const h1 = posOf(v, "heading");
        let h2 = -1;
        v.state.doc.forEach((node, offset) => {
            if (node.type.name === "heading" && offset !== h1 && h2 === -1) {
                h2 = offset;
            }
        });
        toggle(v, h2);
        toggle(v, h1);
        const deepRange = foldHiddenRange(v.state.doc, h2)!;

        // Act: navigate into the deepest hidden block (Find/TOC intent).
        revealPosition(v, deepRange.from + 2);

        // Assert: both containing folds expanded, and left expanded.
        expect(folded(v).size).toBe(0);
    });
});

describe("editor.folding disabled", () => {
    it("setEnabled(false) should expand every UI-only fold and emit no fold chrome", async () => {
        // Arrange
        const editor = await makeEditor("## H\n\nBody");
        const v = view(editor);
        toggle(v, posOf(v, "heading"));
        expect(document.querySelector(".heading-fold-hidden")).not.toBeNull();

        // Act
        v.dispatch(
            v.state.tr
                .setMeta(foldPluginKey, { type: "setEnabled", enabled: false } satisfies FoldMeta)
                .setMeta("addToHistory", false),
        );

        // Assert: folds expanded, no chevrons, commands no-op.
        expect(folded(v).size).toBe(0);
        expect(document.querySelector(".heading-fold-hidden")).toBeNull();
        expect(document.querySelector(".heading-fold-toggle")).toBeNull();
        expect(foldAllCommand(v.state, v.dispatch)).toBe(false);
        expect(foldAtCaret(v.state, v.dispatch)).toBe(false);
        // The gutter MARKERS survive — only the fold layer is off.
        expect(document.querySelector(".heading-fold-marker")).not.toBeNull();
    });

    it("a folding-disabled body class at init should start the layer off", async () => {
        // Arrange
        document.body.classList.add("folding-disabled");
        const editor = await makeEditor("> [!tip]- Folded\n> Hidden.\n");
        const v = view(editor);

        // Assert: no T1 seed, no chevrons, zero fold decoration cost.
        expect(folded(v).size).toBe(0);
        expect(foldPluginKey.getState(v.state)!.enabled).toBe(false);
        expect(document.querySelector(".heading-fold-toggle")).toBeNull();
    });
});

describe("persistence anchors", () => {
    it("computeFoldAnchors and resolveFoldAnchors should round-trip headings and callouts", async () => {
        // Arrange: duplicate heading texts to exercise the occurrence index.
        const editor = await makeEditor(
            "# Setup\n\none\n\n# Setup\n\ntwo\n\n> [!note] T\n> body",
        );
        const v = view(editor);
        const headings: number[] = [];
        v.state.doc.forEach((node, offset) => {
            if (node.type.name === "heading") {
                headings.push(offset);
            }
        });
        const calloutPos = posOf(v, "callout");
        const foldedSet = new Set([headings[1]!, calloutPos]);

        // Act
        const anchors = computeFoldAnchors(v.state.doc, foldedSet);
        const restored = resolveFoldAnchors(v.state.doc, anchors);

        // Assert: the SECOND "Setup" (occurrence 1) and the callout resolve.
        expect(anchors.headings).toEqual(["setup:1"]);
        expect(anchors.callouts).toHaveLength(1);
        expect(restored).toEqual(foldedSet);
    });

    it("anchors that no longer resolve should be dropped silently", async () => {
        // Arrange: a doc that has neither the heading nor a callout at 9/9.
        const editor = await makeEditor("# Other\n\ntext");
        const v = view(editor);

        // Act
        const restored = resolveFoldAnchors(v.state.doc, {
            headings: ["setup:0", "missing:3"],
            callouts: ["9/9", "not-a-path", "0"],
        });

        // Assert
        expect(restored.size).toBe(0);
    });

    it("fold changes should persist anchors into the webview state bag", async () => {
        // Arrange
        const { setWebviewState } = await import("../messaging");
        void setWebviewState; // state writes go through the mocked vscode api
        const { mockVscodeApi } = await import("./setup");
        mockVscodeApi.setState.mockClear();
        const editor = await makeEditor("## Title\n\nBody");
        const v = view(editor);

        // Act
        toggle(v, posOf(v, "heading"));

        // Assert: the state bag write carries the structural anchor.
        const lastWrite = mockVscodeApi.setState.mock.calls.at(-1)?.[0] as
            | { foldAnchors?: { headings: string[] } }
            | undefined;
        expect(lastWrite?.foldAnchors?.headings).toEqual(["title:0"]);
    });
});
