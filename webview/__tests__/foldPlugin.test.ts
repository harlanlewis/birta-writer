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
import { TextSelection } from "../pm";
import { Fragment, Slice } from "../pm";
import type { EditorView } from "../pm";
import { getMarkdown } from "@milkdown/utils";
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
    revealOnDelete,
    revealOnEnter,
    revealPosition,
    setHeadingLevelAt,
    unfoldAllCommand,
    unfoldAtCaret,
    type FoldMeta,
} from "../plugins/headingFold";
import { insertParagraphAfter } from "../plugins/insertParagraph";
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
        // The reveal keymap registers BEFORE the presets, mirroring
        // production (editor.ts): its Enter/Mod-Enter guards must run before
        // the presets' own Enter handling.
        .use(foldRevealKeymapPlugin)
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(headingFoldPlugin)
        .create();
    editors.push(editor);
    return editor;
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

/** Dispatch a real Enter keydown through the view's keymap chain. */
function pressEnter(v: EditorView): void {
    v.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
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

    it("a persisted anchor for a list-item-nested callout should be dropped on restore", async () => {
        // Arrange: the callout lives inside a list item — never foldable
        // (state/decoration parity), so a stale anchor must not resurrect
        // an invisible fold across tab switches.
        const editor = await makeEditor("- item\n\n  > [!note] T\n  > hidden body\n\ntail");
        const v = view(editor);
        const calloutPos = deepPosOf(v, "callout");

        // Act: an anchor computed for the nested callout (as an older build
        // could have persisted) must not resolve back into the fold set.
        const anchors = computeFoldAnchors(v.state.doc, new Set([calloutPos]));
        const restored = resolveFoldAnchors(v.state.doc, anchors);

        // Assert
        expect(anchors.callouts).toHaveLength(1);
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

describe("list-item-nested callouts (state/decoration parity)", () => {
    // The fold DECORATION pass renders chrome only for top-level blocks and
    // container children; list-item children (emitItemGutters) have no fold
    // context. The STATE layer must therefore never accept a fold on a
    // callout with a list_item ancestor — otherwise the fold is invisible
    // while the caret guard and drop guards still treat the body as hidden.
    const NESTED = "- item\n\n  > [!note] T\n  > hidden body\n\ntail";

    it("foldAtCaret inside a list-item-nested callout should fold the ITEM, never the callout", async () => {
        // Arrange: since MAR-125 the containing list item is itself a
        // foldable (it has a descendant block: the callout), so the fold
        // command targets IT — the callout stays unfoldable (no chrome).
        const editor = await makeEditor(NESTED);
        const v = view(editor);
        const calloutPos = deepPosOf(v, "callout");
        const itemPos = deepPosOf(v, "list_item");
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, calloutPos + 3)));

        // Act + Assert
        expect(foldAtCaret(v.state, v.dispatch)).toBe(true);
        expect(folded(v).has(itemPos)).toBe(true);
        expect(folded(v).has(calloutPos)).toBe(false);
        expect(foldHiddenRange(v.state.doc, calloutPos)).toBeNull();
    });

    it("Fold All should fold top-level foldables but never the nested callout", async () => {
        // Arrange
        const editor = await makeEditor(`# Top\n\nbody\n\n${NESTED}`);
        const v = view(editor);
        const headingPos = posOf(v, "heading");
        const calloutPos = deepPosOf(v, "callout");

        // Act
        expect(foldAllCommand(v.state, v.dispatch)).toBe(true);

        // Assert
        expect(folded(v).has(headingPos)).toBe(true);
        expect(folded(v).has(calloutPos)).toBe(false);
        expect(allFoldablePositions(v.state.doc)).not.toContain(calloutPos);
    });

    it("a toggle/set meta on a list-item-nested callout should be rejected (defense in depth)", async () => {
        // Arrange
        const editor = await makeEditor(NESTED);
        const v = view(editor);
        const calloutPos = deepPosOf(v, "callout");

        // Act: both meta shapes a stale caller could dispatch directly.
        toggle(v, calloutPos);
        v.dispatch(
            v.state.tr
                .setMeta(foldPluginKey, { type: "set", pos: calloutPos, folded: true } satisfies FoldMeta)
                .setMeta("addToHistory", false),
        );

        // Assert: state never contains an entry the decorations won't render.
        expect(folded(v).size).toBe(0);
        expect(foldedHiddenRanges(v.state)).toHaveLength(0);
    });

    it("a caret placed in the nested callout's body should NOT be ejected", async () => {
        // Arrange: attempt the fold (rejected), then enter the body.
        const editor = await makeEditor(NESTED);
        const v = view(editor);
        const calloutPos = deepPosOf(v, "callout");
        toggle(v, calloutPos);
        const target = calloutPos + 3;

        // Act
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, target)));

        // Assert: the caret guard has nothing hidden to eject from.
        expect(v.state.selection.from).toBe(target);
    });

    it("a [!kind]- syntax marker inside a list item should NOT seed a fold", async () => {
        const editor = await makeEditor("- item\n\n  > [!tip]- Folded\n  > hidden body\n\ntail");
        const v = view(editor);
        expect(folded(v).size).toBe(0);
    });
});

describe("Enter at a collapsed heading boundary", () => {
    const DOC = "# A\n\nbody a\n\n# B\n\nbody b";

    /** Collapse the first heading and put the caret at the end of its line. */
    async function collapseWithCaretAtEnd(doc: string) {
        const editor = await makeEditor(doc);
        const v = view(editor);
        const pos = posOf(v, "heading");
        toggle(v, pos);
        const node = v.state.doc.nodeAt(pos)!;
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos + node.nodeSize - 1)));
        return { v, pos };
    }

    it("Enter at the end of a collapsed heading should unfold and insert a visible paragraph", async () => {
        // Arrange
        const { v } = await collapseWithCaretAtEnd(DOC);

        // Act
        pressEnter(v);

        // Assert: the fold is gone, the new paragraph is the heading's next
        // sibling, and the caret sits inside it — not teleported into "B".
        expect(folded(v).size).toBe(0);
        const second = v.state.doc.child(1);
        expect(second.type.name).toBe("paragraph");
        expect(second.textContent).toBe("");
        expect(v.state.selection.$from.parent).toBe(second);
        expect(document.querySelector(".heading-fold-hidden")).toBeNull();
    });

    it("repeated Enter should never accrete hidden paragraphs", async () => {
        // Arrange
        const { v } = await collapseWithCaretAtEnd(DOC);
        const blocksBefore = v.state.doc.childCount;

        // Act
        pressEnter(v);
        pressEnter(v);

        // Assert: two visible paragraphs added, zero hidden content.
        expect(v.state.doc.childCount).toBe(blocksBefore + 2);
        expect(foldedHiddenRanges(v.state)).toHaveLength(0);
        expect(document.querySelector(".heading-fold-hidden")).toBeNull();
    });

    it("Enter at doc end on a collapsed trailing heading should still produce a visible paragraph", async () => {
        // Arrange: the section is the last content — the old failure mode was
        // a caret snapping back while hidden empty paragraphs accreted.
        const { v } = await collapseWithCaretAtEnd("# A\n\nbody a");

        // Act
        pressEnter(v);

        // Assert
        expect(folded(v).size).toBe(0);
        expect(v.state.selection.$from.parent.type.name).toBe("paragraph");
        expect(document.querySelector(".heading-fold-hidden")).toBeNull();
    });

    it("Mod-Enter (insert paragraph below) should unfold first via the same guard", async () => {
        // Arrange
        const { v } = await collapseWithCaretAtEnd(DOC);

        // Act: the production chain — revealOnEnter runs first (registered
        // before insertParagraphKeymapPlugin), never consumes, and the
        // insert command then acts on the unfolded state.
        expect(revealOnEnter(v.state, v.dispatch)).toBe(false);
        expect(insertParagraphAfter(v.state, v.dispatch, v)).toBe(true);

        // Assert
        expect(folded(v).size).toBe(0);
        const second = v.state.doc.child(1);
        expect(second.type.name).toBe("paragraph");
        expect(second.textContent).toBe("");
        expect(v.state.selection.$from.parent).toBe(second);
        expect(document.querySelector(".heading-fold-hidden")).toBeNull();
    });

    it("Enter away from any fold boundary should not dispatch and fall through", async () => {
        // Arrange: collapsed heading exists, but the caret is elsewhere.
        const editor = await makeEditor(DOC);
        const v = view(editor);
        toggle(v, posOf(v, "heading"));
        const end = v.state.doc.content.size - 1;
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, end)));
        const stateBefore = v.state;

        // Act + Assert: falls through without touching the fold.
        expect(revealOnEnter(v.state, v.dispatch)).toBe(false);
        expect(v.state).toBe(stateBefore);
        expect(folded(v).size).toBe(1);
    });
});

describe("an edit must not hide content it didn't put there (MAR-149)", () => {
    /**
     * Text of every block the fold decoration currently hides — read from the
     * DOM class that actually drives display:none, NOT from the fold set or
     * foldedHiddenRanges, which are the state the fix manipulates (asserting
     * those would only restate the mechanism).
     */
    const hiddenTexts = (v: EditorView): string[] =>
        Array.from(v.dom.querySelectorAll(".heading-fold-hidden")).map((el) => el.textContent ?? "");

    /** `# One / ### Deep / deep text / ## Two / two text / # Three`, Deep collapsed. */
    async function docWithDeepCollapsed(): Promise<EditorView> {
        const v = view(await makeEditor("# One\n\n### Deep\n\ndeep text\n\n## Two\n\ntwo text\n\n# Three\n"));
        toggle(v, posOf(v, "heading") + 5); // ### Deep
        expect(hiddenTexts(v)).toEqual(["deep text"]);
        return v;
    }

    /** Top-level position of the heading whose text is `text`. */
    function headingPos(v: EditorView, text: string): number {
        let pos = -1;
        v.state.doc.forEach((node, offset) => {
            if (node.type.name === "heading" && node.textContent === text) {
                pos = offset;
            }
        });
        expect(pos, `no heading "${text}"`).toBeGreaterThanOrEqual(0);
        return pos;
    }

    it("retyping a heading below the fold's rank should reveal rather than bury the blocks it swallows", async () => {
        // Arrange: Deep (H3) is collapsed; Two (H2) out-ranks it, so Two and
        // its body sit OUTSIDE Deep's section and are visible.
        const v = await docWithDeepCollapsed();

        // Act: retype Two H2 -> H4 (the gutter H-badge path). Deep now
        // out-ranks Two, so Deep's rank-derived section grows over it.
        expect(setHeadingLevelAt(v, headingPos(v, "Two"), 4)).toBe(true);

        // Assert: one click must not put blocks the user never touched at
        // display:none. Deep expands instead.
        expect(hiddenTexts(v)).toEqual([]);
    });

    it("deleting a terminating heading should reveal rather than bury the body it orphans", async () => {
        // Arrange
        const v = await docWithDeepCollapsed();

        // Act: delete the `## Two` heading node alone. `two text` loses the
        // heading that kept it out of Deep's section.
        const pos = headingPos(v, "Two");
        v.dispatch(v.state.tr.delete(pos, pos + v.state.doc.nodeAt(pos)!.nodeSize));

        // Assert
        expect(hiddenTexts(v)).toEqual([]);
    });

    it("retyping a heading that leaves the fold's extent alone should keep it collapsed", async () => {
        // Arrange
        const v = await docWithDeepCollapsed();

        // Act: retype Two H2 -> H1. Deep's section still ends at Two.
        expect(setHeadingLevelAt(v, headingPos(v, "Two"), 1)).toBe(true);

        // Assert: the rule is narrow — an edit that hides nothing new must not
        // cost the user their fold.
        expect(hiddenTexts(v)).toEqual(["deep text"]);
    });

    it("typing in a sibling section should keep the fold collapsed", async () => {
        // Arrange
        const v = await docWithDeepCollapsed();

        // Act: type into `two text`, below the collapsed section.
        v.dispatch(v.state.tr.insertText("X", headingPos(v, "Two") + 6));

        // Assert
        expect(hiddenTexts(v)).toEqual(["deep text"]);
    });

    it("appending at the END of a collapsed callout's body should keep it collapsed", async () => {
        // Arrange: unlike a heading (whose `to` is the VISIBLE terminating
        // heading), a callout's `to` is the last position INSIDE the collapsed
        // node — an append there was never visible, so it must not read as the
        // fold swallowing anything. An external sync (git pull, an edit in the
        // raw text editor) appends at exactly this position, and treating the
        // two kinds alike silently expanded the callout.
        const v = view(await makeEditor("> [!note] T\n> Body.\n\nAfter"));
        const pos = posOf(v, "callout");
        toggle(v, pos);
        // The `collapsed` class is the node decoration the CSS keys on to
        // hide the body — the observable, not the fold set the fix touches.
        expect(v.dom.querySelector(".callout.collapsed")).not.toBeNull();
        const range = foldHiddenRange(v.state.doc, pos)!;

        // Act
        v.dispatch(v.state.tr.insertText(" more", range.to));

        // Assert: the user keeps the fold they set.
        expect(v.dom.querySelector(".callout.collapsed")).not.toBeNull();
    });
});

describe("a fold must not grow at its FROM end over visible content (MAR-155)", () => {
    /** Same DOM-level observable as the MAR-149 suite above. */
    const hiddenTexts = (v: EditorView): string[] =>
        Array.from(v.dom.querySelectorAll(".heading-fold-hidden")).map((el) => el.textContent ?? "");

    /** Absolute position of `needle`'s first character in the document. */
    function textPos(v: EditorView, needle: string): number {
        let pos = -1;
        v.state.doc.descendants((node, offset) => {
            if (pos === -1 && node.isText && node.text!.includes(needle)) {
                pos = offset + node.text!.indexOf(needle);
            }
            return pos === -1;
        });
        expect(pos, `text "${needle}" not found`).toBeGreaterThanOrEqual(0);
        return pos;
    }

    /** Collapsed `- First` item hiding its two child bullets. */
    async function collapsedItem(): Promise<EditorView> {
        const v = view(await makeEditor("- First\n  - Child A\n  - Child B\n"));
        toggle(v, deepPosOf(v, "list_item"));
        expect(hiddenTexts(v)).toEqual(["Child AChild B"]);
        return v;
    }

    it("pasting block content into a collapsed item's first line should reveal rather than tear its text into the fold", async () => {
        // Arrange
        const v = await collapsedItem();

        // Act: paste two paragraphs mid-way through the visible first line —
        // the exact slice shape ProseMirror's paste handler builds
        // (openStart/openEnd 1). The item's first child becomes "FirP1",
        // pushing the fold's `from` forward over "st": text the user typed,
        // could see, and never selected.
        const at = textPos(v, "First") + 3; // Fir|st
        const p = v.state.schema.nodes["paragraph"]!;
        const slice = new Slice(
            Fragment.from([
                p.create(null, v.state.schema.text("P1")),
                p.create(null, v.state.schema.text("P2 line")),
            ]),
            1,
            1,
        );
        v.dispatch(
            v.state.tr.setSelection(TextSelection.create(v.state.doc, at)).replaceSelection(slice),
        );

        // Assert: nothing the user could see is at display:none — the fold
        // expands instead of the item silently reading "- FirP1".
        expect(hiddenTexts(v)).toEqual([]);
    });

    it("typing in a collapsed item's first line should keep it collapsed", async () => {
        // Arrange
        const v = await collapsedItem();

        // Act: an ordinary insertion inside the visible first line moves the
        // fold's `from` by exactly the mapped delta.
        v.dispatch(v.state.tr.insertText("X", textPos(v, "First") + 5));

        // Assert: the narrow rule — an edit that hides nothing new must not
        // cost the user their fold.
        expect(hiddenTexts(v)).toEqual(["Child AChild B"]);
    });

    it("a block landing directly under a collapsed heading should reveal rather than vanish", async () => {
        // Arrange: a heading's `from` is the first hidden position; content
        // landed exactly there (a programmatic insert — the interactive Enter
        // path has its own reveal keymap) disappears into the fold.
        const v = view(await makeEditor("## H\n\nBody\n\n## Next"));
        const pos = posOf(v, "heading");
        toggle(v, pos);
        const hidden = foldHiddenRange(v.state.doc, pos)!;

        // Act
        const p = v.state.schema.nodes["paragraph"]!;
        v.dispatch(v.state.tr.insert(hidden.from, p.create(null, v.state.schema.text("landed"))));

        // Assert: same reveal semantics as content landing at the section's
        // END boundary (MAR-146/149) — the two boundaries must not differ.
        expect(hiddenTexts(v)).toEqual([]);
    });

    it("content inserted at the start of a collapsed callout's body should keep it collapsed", async () => {
        // Arrange: the FROM-end mirror of "appending at the END of a
        // collapsed callout's body" above — a prepend at exactly `from` is
        // INSIDE the collapsed node, was never visible, and is how an
        // external sync lands. It must not cost the user their fold.
        const v = view(await makeEditor("> [!note] T\n> Body.\n\nAfter"));
        const pos = posOf(v, "callout");
        toggle(v, pos);
        expect(v.dom.querySelector(".callout.collapsed")).not.toBeNull();
        const range = foldHiddenRange(v.state.doc, pos)!;

        // Act
        const p = v.state.schema.nodes["paragraph"]!;
        v.dispatch(v.state.tr.insert(range.from, p.create(null, v.state.schema.text("prepended"))));

        // Assert
        expect(v.dom.querySelector(".callout.collapsed")).not.toBeNull();
    });
});

describe("stale fold entries on section-less headings", () => {
    it("a collapsed heading whose section is deleted should reset to open", async () => {
        // Arrange
        const editor = await makeEditor("## H\n\nBody\n\n## Next");
        const v = view(editor);
        const pos = posOf(v, "heading");
        toggle(v, pos);
        const hidden = foldHiddenRange(v.state.doc, pos)!;

        // Act: an edit empties the section (external sync / block delete).
        v.dispatch(v.state.tr.delete(hidden.from, hidden.to));

        // Assert: the entry is gone — not silently retained on a heading
        // that owns nothing (no chevron, no ellipsis, no cue).
        expect(folded(v).size).toBe(0);
    });

    it("content typed under a heading that lost its section should stay visible", async () => {
        // Arrange: collapse, then empty the section.
        const editor = await makeEditor("## H\n\nBody\n\n## Next");
        const v = view(editor);
        const pos = posOf(v, "heading");
        toggle(v, pos);
        const hidden = foldHiddenRange(v.state.doc, pos)!;
        v.dispatch(v.state.tr.delete(hidden.from, hidden.to));

        // Act: new content appears under the heading.
        const paragraph = v.state.schema.nodes["paragraph"]!;
        const node = v.state.doc.nodeAt(pos)!;
        v.dispatch(v.state.tr.insert(pos + node.nodeSize, paragraph.create(null, v.state.schema.text("new content"))));

        // Assert: nothing swallows it.
        expect(folded(v).size).toBe(0);
        expect(foldedHiddenRanges(v.state)).toHaveLength(0);
        expect(document.querySelector(".heading-fold-hidden")).toBeNull();
    });
});
