/**
 * Tests for the block keyboard model (MAR-22 move keys / MAR-82 keyboard
 * remainder): Escape's caret↔block toggle, Shift+arrow block-wise
 * extend/shrink (and its never-steal-text-selection gate), and Alt/Cmd+Shift
 * arrow moves through the shared moveBlockTo machinery.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import { historyPlugin } from "../plugins/history";
import { contentGuardPlugin } from "../plugins/contentGuard";
import { undo } from "@milkdown/prose/history";
import {
    isBlockSpanning,
    toggleBlockSelection,
    extendBlockSelection,
    escalateSelectAll,
    moveSelectedBlocks,
    duplicateSelectedBlocks,
    deleteSelectedBlocks,
    handleBlockKeydown,
} from "../plugins/blockKeys";
import { registerEscapeLayer, closeTopmostLayer } from "../ui/escapeLayers";
import { BlockRangeSelection } from "../plugins/blockRange";
import { headingFoldPluginKey } from "../plugins/headingFold";
import { NodeSelection } from "@milkdown/prose/state";

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
        .use(gfmFidelity)
        .use(headingFoldPlugin)
        .use(historyPlugin)
        // Real guard in the loop: these suites exercise moves/duplicates,
        // which must now pass the content-conservation guard (MAR-108).
        .use(contentGuardPlugin)
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

/** Caret inside the block whose text is `text`. */
function placeCaretIn(view: EditorView, text: string): void {
    let inside = -1;
    view.state.doc.forEach((node, offset) => {
        if (node.textContent === text) inside = offset + 1;
    });
    expect(inside).toBeGreaterThan(-1);
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(inside))));
}

function selectedText(view: EditorView): string {
    const sel = view.state.selection;
    return view.state.doc.textBetween(sel.from, sel.to, " ");
}

function blockOrder(view: EditorView): string[] {
    const texts: string[] = [];
    view.state.doc.forEach((node) => {
        texts.push(node.textContent);
    });
    return texts;
}

describe("toggleBlockSelection (Escape)", () => {
    it("a caret should expand to a block range over its whole block", async () => {
        const view = await makeEditor("Alpha\n\nBeta gamma\n\nDelta");
        placeCaretIn(view, "Beta gamma");
        expect(toggleBlockSelection(view.state, view.dispatch)).toBe(true);
        expect(view.state.selection).toBeInstanceOf(BlockRangeSelection);
        expect(selectedText(view)).toBe("Beta gamma");
        expect(isBlockSpanning(view.state)).toBe(true);
    });

    it("a caret in an EMPTY paragraph should still select its block", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        // Build an empty paragraph after Beta, put the caret in it.
        const end = view.state.doc.content.size;
        const paragraph = view.state.schema.nodes["paragraph"]!;
        view.dispatch(view.state.tr.insert(end, paragraph.create()));
        view.dispatch(view.state.tr.setSelection(
            TextSelection.near(view.state.doc.resolve(view.state.doc.content.size - 1)),
        ));
        expect(view.state.selection.empty).toBe(true);
        expect(toggleBlockSelection(view.state, view.dispatch)).toBe(true);
        expect(view.state.selection).toBeInstanceOf(BlockRangeSelection);
    });

    it("a block range should collapse back to a caret", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Beta");
        toggleBlockSelection(view.state, view.dispatch);
        expect(view.state.selection).toBeInstanceOf(BlockRangeSelection);
        expect(toggleBlockSelection(view.state, view.dispatch)).toBe(true);
        expect(view.state.selection.empty).toBe(true);
    });

    it("a partial text selection should escalate to its block", async () => {
        const view = await makeEditor("Alpha beta gamma\n\nDelta");
        view.dispatch(view.state.tr.setSelection(
            TextSelection.create(view.state.doc, 2, 6),
        ));
        expect(isBlockSpanning(view.state)).toBe(false);
        expect(toggleBlockSelection(view.state, view.dispatch)).toBe(true);
        expect(view.state.selection).toBeInstanceOf(BlockRangeSelection);
        expect(selectedText(view)).toBe("Alpha beta gamma");
    });
});

describe("handleBlockKeydown (Escape layering)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Drain layer entries left behind by other tests (module-level stack).
        while (closeTopmostLayer()) { /* drain */ }
    });

    const escapeEvent = () =>
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });

    it("Escape with an open layer should close it, consume the key, and leave the selection alone", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Beta");
        const before = view.state.selection;
        const close = vi.fn();
        registerEscapeLayer(close);
        const event = escapeEvent();
        const stop = vi.spyOn(event, "stopPropagation");
        expect(handleBlockKeydown(view, event)).toBe(true);
        expect(close).toHaveBeenCalledTimes(1);
        // Consumed WITHOUT touching the selection — no block escalation.
        expect(view.state.selection.eq(before)).toBe(true);
        // The consumed chord must not reach the workbench key forwarder.
        expect(stop).toHaveBeenCalled();
    });

    it("Escape with no layers should run the existing escalate/collapse grammar", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Beta");
        expect(handleBlockKeydown(view, escapeEvent())).toBe(true);
        expect(view.state.selection).toBeInstanceOf(BlockRangeSelection);
        expect(handleBlockKeydown(view, escapeEvent())).toBe(true);
        expect(view.state.selection.empty).toBe(true);
    });

    it("one Escape should close exactly one layer, topmost first", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        placeCaretIn(view, "Beta");
        const closes: string[] = [];
        const offLower = registerEscapeLayer(() => { closes.push("lower"); offLower(); });
        const offUpper = registerEscapeLayer(() => { closes.push("upper"); offUpper(); });
        handleBlockKeydown(view, escapeEvent());
        expect(closes).toEqual(["upper"]);
        handleBlockKeydown(view, escapeEvent());
        expect(closes).toEqual(["upper", "lower"]);
        // Third Escape: nothing left — the block grammar takes over.
        handleBlockKeydown(view, escapeEvent());
        expect(view.state.selection).toBeInstanceOf(BlockRangeSelection);
    });

    it("a modified Escape (Shift+Escape) should not touch the layer stack", async () => {
        const view = await makeEditor("Alpha");
        const close = vi.fn();
        const off = registerEscapeLayer(close);
        const event = new KeyboardEvent("keydown", {
            key: "Escape", shiftKey: true, bubbles: true, cancelable: true,
        });
        handleBlockKeydown(view, event);
        expect(close).not.toHaveBeenCalled();
        off();
    });
});

describe("extendBlockSelection (Shift+arrows)", () => {
    it("a plain text selection should return false — native selection untouched", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        view.dispatch(view.state.tr.setSelection(
            TextSelection.create(view.state.doc, 2, 4),
        ));
        expect(extendBlockSelection(1)(view.state, view.dispatch)).toBe(false);
        expect(extendBlockSelection(-1)(view.state, view.dispatch)).toBe(false);
    });

    it("Shift+Down on a block selection should add the next block", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Alpha");
        toggleBlockSelection(view.state, view.dispatch);
        expect(extendBlockSelection(1)(view.state, view.dispatch)).toBe(true);
        expect(selectedText(view)).toBe("Alpha Beta");
        expect(isBlockSpanning(view.state)).toBe(true);
    });

    it("Shift+Up on a downward-grown selection should shrink it from the bottom", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Alpha");
        toggleBlockSelection(view.state, view.dispatch);
        extendBlockSelection(1)(view.state, view.dispatch);
        expect(extendBlockSelection(-1)(view.state, view.dispatch)).toBe(true);
        expect(selectedText(view)).toBe("Alpha");
    });

    it("Shift+Up at the first block should grow upward when possible", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Beta");
        toggleBlockSelection(view.state, view.dispatch);
        expect(extendBlockSelection(-1)(view.state, view.dispatch)).toBe(true);
        expect(selectedText(view)).toBe("Alpha Beta");
    });

    it("Shift+Down at the last block should consume the key without change", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        placeCaretIn(view, "Beta");
        toggleBlockSelection(view.state, view.dispatch);
        expect(extendBlockSelection(1)(view.state, view.dispatch)).toBe(true);
        expect(selectedText(view)).toBe("Beta");
    });
});

describe("moveSelectedBlocks (Alt+arrows / Cmd+Shift+arrows)", () => {
    it("a caret block should move down past its neighbor", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Alpha");
        expect(moveSelectedBlocks(1)(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Beta", "Alpha", "Gamma"]);
    });

    it("a multi-block selection should move as one run and stay selected", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma\n\nDelta");
        placeCaretIn(view, "Alpha");
        toggleBlockSelection(view.state, view.dispatch);
        extendBlockSelection(1)(view.state, view.dispatch);
        expect(moveSelectedBlocks(1)(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Gamma", "Alpha", "Beta", "Delta"]);
        expect(selectedText(view)).toBe("Alpha Beta");
        expect(isBlockSpanning(view.state)).toBe(true);
    });

    it("a multi-block selection at the top should consume Alt+Up without change", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Alpha");
        toggleBlockSelection(view.state, view.dispatch);
        extendBlockSelection(1)(view.state, view.dispatch);
        expect(moveSelectedBlocks(-1)(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Alpha", "Beta", "Gamma"]);
    });

    it("a heading caret should carry its section when moving", async () => {
        const view = await makeEditor("Intro\n\n## One\n\nBody one\n\n## Two\n\nBody two");
        placeCaretIn(view, "One");
        expect(moveSelectedBlocks(1)(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Intro", "Two", "Body two", "One", "Body one"]);
    });

    it("moving down then undo should restore the original order", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        placeCaretIn(view, "Alpha");
        moveSelectedBlocks(1)(view.state, view.dispatch, view);
        expect(blockOrder(view)).toEqual(["Beta", "Alpha"]);
        undo(view.state, view.dispatch);
        expect(blockOrder(view)).toEqual(["Alpha", "Beta"]);
    });
});

describe("escalateSelectAll (Mod+A ladder)", () => {
    it("a caret should first select its block's text", async () => {
        const view = await makeEditor("Alpha beta\n\nGamma");
        placeCaretIn(view, "Alpha beta");
        expect(escalateSelectAll(view.state, view.dispatch)).toBe(true);
        expect(view.state.selection).toBeInstanceOf(TextSelection);
        expect(selectedText(view)).toBe("Alpha beta");
    });

    it("block text fully selected should step up to the block range", async () => {
        const view = await makeEditor("Alpha beta\n\nGamma");
        placeCaretIn(view, "Alpha beta");
        escalateSelectAll(view.state, view.dispatch);
        expect(escalateSelectAll(view.state, view.dispatch)).toBe(true);
        expect(view.state.selection).toBeInstanceOf(BlockRangeSelection);
        expect(selectedText(view)).toBe("Alpha beta");
    });

    it("a block range should step up to every block", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Beta");
        toggleBlockSelection(view.state, view.dispatch);
        expect(escalateSelectAll(view.state, view.dispatch)).toBe(true);
        const sel = view.state.selection;
        expect(sel).toBeInstanceOf(BlockRangeSelection);
        expect(sel.from).toBe(0);
        expect(sel.to).toBe(view.state.doc.content.size);
    });

    it("everything selected should consume further presses stably", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        placeCaretIn(view, "Alpha");
        escalateSelectAll(view.state, view.dispatch);
        escalateSelectAll(view.state, view.dispatch);
        escalateSelectAll(view.state, view.dispatch);
        const before = view.state.selection;
        expect(escalateSelectAll(view.state, view.dispatch)).toBe(true);
        expect(view.state.selection.eq(before)).toBe(true);
    });

    it("inside a table should bail to native select-all", async () => {
        const view = await makeEditor("| a | b |\n| --- | --- |\n| c | d |");
        // Caret into the first cell's text.
        let inTable = -1;
        view.state.doc.descendants((node, pos) => {
            if (inTable === -1 && node.isText && node.text === "a") inTable = pos;
            return inTable === -1;
        });
        expect(inTable).toBeGreaterThan(-1);
        view.dispatch(view.state.tr.setSelection(
            TextSelection.create(view.state.doc, inTable),
        ));
        expect(escalateSelectAll(view.state, view.dispatch)).toBe(false);
    });
});

describe("extendBlockSelection honors the anchor", () => {
    it("an upward-grown range should shrink from the TOP on Shift+Down", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Gamma");
        toggleBlockSelection(view.state, view.dispatch);
        extendBlockSelection(-1)(view.state, view.dispatch); // Gamma + Beta (backward)
        expect(selectedText(view)).toBe("Beta Gamma");
        expect(extendBlockSelection(1)(view.state, view.dispatch)).toBe(true);
        expect(selectedText(view)).toBe("Gamma");
    });

    it("a leaf block (HR) should join the range when extended over", async () => {
        const view = await makeEditor("alpha\n\n---\n\nomega");
        placeCaretIn(view, "alpha");
        toggleBlockSelection(view.state, view.dispatch);
        extendBlockSelection(1)(view.state, view.dispatch); // alpha + HR
        const sel = view.state.selection;
        expect(sel).toBeInstanceOf(BlockRangeSelection);
        let hrEnd = -1;
        view.state.doc.forEach((node, offset) => {
            if (node.type.name === "hr") hrEnd = offset + node.nodeSize;
        });
        expect(sel.to).toBe(hrEnd);
        extendBlockSelection(1)(view.state, view.dispatch); // + omega
        expect(view.state.selection.to).toBe(view.state.doc.content.size);
    });
});

describe("moveSelectedBlocks in lists", () => {
    it("a caret in a list item should move the ITEM, not the whole list", async () => {
        const view = await makeEditor("Intro\n\n- one\n- two\n- three");
        // Caret into "two".
        let pos = -1;
        view.state.doc.descendants((node, nodePos) => {
            if (node.isTextblock && node.textContent === "two") pos = nodePos + 1;
            return pos === -1;
        });
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
        expect(moveSelectedBlocks(-1)(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Intro", "twoonethree"]);
        const { getMarkdown } = await import("@milkdown/utils");
        expect(editors[0]!.action(getMarkdown()).trimEnd()).toBe(
            "Intro\n\n- two\n- one\n- three",
        );
    });

    it("a caret in a NESTED item should move it among its own siblings", async () => {
        const view = await makeEditor("- outer\n  - alpha\n  - beta");
        let pos = -1;
        view.state.doc.descendants((node, nodePos) => {
            if (node.isTextblock && node.textContent === "beta") pos = nodePos + 1;
            return pos === -1;
        });
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
        expect(moveSelectedBlocks(-1)(view.state, view.dispatch, view)).toBe(true);
        const { getMarkdown } = await import("@milkdown/utils");
        expect(editors[0]!.action(getMarkdown()).trimEnd()).toBe(
            "- outer\n  - beta\n  - alpha",
        );
    });
});

describe("fold-aware block units (collapsed headings)", () => {
    async function makeFolded(): Promise<EditorView> {
        const view = await makeEditor(
            "Intro\n\n## Section\n\nBody one\n\nBody two\n\n## Next\n\nTail",
        );
        let hPos = -1;
        view.state.doc.forEach((node, offset) => {
            if (node.type.name === "heading" && node.textContent === "Section") hPos = offset;
        });
        expect(hPos).toBeGreaterThan(-1);
        view.dispatch(view.state.tr.setMeta(headingFoldPluginKey, { type: "toggle", pos: hPos }));
        expect(headingFoldPluginKey.getState(view.state)!.folded.has(hPos)).toBe(true);
        return view;
    }

    it("Escape on a collapsed heading should select the heading WITH its hidden section", async () => {
        const view = await makeFolded();
        placeCaretIn(view, "Section");
        toggleBlockSelection(view.state, view.dispatch);
        const sel = view.state.selection;
        expect(sel).toBeInstanceOf(BlockRangeSelection);
        expect(view.state.doc.textBetween(sel.from, sel.to, " "))
            .toBe("Section Body one Body two");
    });

    it("moving a collapsed heading's selection should carry the hidden body", async () => {
        const view = await makeFolded();
        placeCaretIn(view, "Section");
        toggleBlockSelection(view.state, view.dispatch);
        expect(moveSelectedBlocks(1)(view.state, view.dispatch, view)).toBe(true);
        // Hops ONE visible unit ("## Next" is expanded, so its heading line
        // alone) — but the collapsed section moved as an atom: heading and
        // hidden body land together, never separated.
        expect(blockOrder(view)).toEqual([
            "Intro", "Next", "Section", "Body one", "Body two", "Tail",
        ]);
        // Still one selected unit, still collapsed at its destination.
        const sel = view.state.selection;
        expect(view.state.doc.textBetween(sel.from, sel.to, " "))
            .toBe("Section Body one Body two");
    });

    it("Shift+Down from the block above should absorb the WHOLE collapsed unit", async () => {
        const view = await makeFolded();
        placeCaretIn(view, "Intro");
        toggleBlockSelection(view.state, view.dispatch);
        extendBlockSelection(1)(view.state, view.dispatch);
        const sel = view.state.selection;
        // Not just the heading line — the hidden body came too.
        expect(view.state.doc.textBetween(sel.from, sel.to, " "))
            .toBe("Intro Section Body one Body two");
        // And the next step lands on "Next", never inside the hidden run.
        extendBlockSelection(1)(view.state, view.dispatch);
        expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, " "))
            .toBe("Intro Section Body one Body two Next");
    });
});

describe("duplicateSelectedBlocks (Shift+Alt+arrows / palette)", () => {
    /** Index of the top-level block containing the selection head. */
    function caretBlockIndex(view: EditorView): number {
        return view.state.doc.resolve(view.state.selection.head).index(0);
    }

    it("a caret block duplicated down should insert the copy after and land the caret on it", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Beta");
        expect(duplicateSelectedBlocks(1)(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Alpha", "Beta", "Beta", "Gamma"]);
        expect(view.state.selection.empty).toBe(true);
        expect(caretBlockIndex(view)).toBe(2); // the later copy
    });

    it("a caret block duplicated up should keep the caret on the earlier copy", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Beta");
        expect(duplicateSelectedBlocks(-1)(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Alpha", "Beta", "Beta", "Gamma"]);
        expect(caretBlockIndex(view)).toBe(1); // the earlier copy
    });

    it("the FIRST block should duplicate up and the LAST block down (document edges)", async () => {
        const view = await makeEditor("Alpha\n\nOmega");
        placeCaretIn(view, "Alpha");
        expect(duplicateSelectedBlocks(-1)(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Alpha", "Alpha", "Omega"]);
        expect(caretBlockIndex(view)).toBe(0);
        placeCaretIn(view, "Omega");
        expect(duplicateSelectedBlocks(1)(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Alpha", "Alpha", "Omega", "Omega"]);
        expect(caretBlockIndex(view)).toBe(3);
    });

    it("a block range duplicated down should copy the whole run and select the copy", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Alpha");
        toggleBlockSelection(view.state, view.dispatch);
        extendBlockSelection(1)(view.state, view.dispatch); // Alpha + Beta
        expect(duplicateSelectedBlocks(1)(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Alpha", "Beta", "Alpha", "Beta", "Gamma"]);
        const sel = view.state.selection;
        expect(sel).toBeInstanceOf(BlockRangeSelection);
        expect(selectedText(view)).toBe("Alpha Beta");
        expect(view.state.doc.resolve(sel.from).index(0)).toBe(2); // the later run
    });

    it("a block range duplicated up should keep the selection on the earlier run", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Alpha");
        toggleBlockSelection(view.state, view.dispatch);
        extendBlockSelection(1)(view.state, view.dispatch);
        expect(duplicateSelectedBlocks(-1)(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Alpha", "Beta", "Alpha", "Beta", "Gamma"]);
        const sel = view.state.selection;
        expect(sel).toBeInstanceOf(BlockRangeSelection);
        expect(sel.from).toBe(0); // the earlier run
        expect(selectedText(view)).toBe("Alpha Beta");
    });

    it("a caret in a list item should duplicate the ITEM alone, not the whole list", async () => {
        const view = await makeEditor("Intro\n\n- one\n- two");
        let pos = -1;
        view.state.doc.descendants((node, nodePos) => {
            if (node.isTextblock && node.textContent === "one") pos = nodePos + 1;
            return pos === -1;
        });
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
        expect(duplicateSelectedBlocks(1)(view.state, view.dispatch, view)).toBe(true);
        const { getMarkdown } = await import("@milkdown/utils");
        expect(editors[0]!.action(getMarkdown()).trimEnd()).toBe(
            "Intro\n\n- one\n- one\n- two",
        );
    });

    it("a caret inside a blockquote should duplicate the whole top-level block", async () => {
        const view = await makeEditor("Alpha\n\n> quoted");
        placeCaretIn(view, "quoted");
        expect(duplicateSelectedBlocks(1)(view.state, view.dispatch, view)).toBe(true);
        const { getMarkdown } = await import("@milkdown/utils");
        expect(editors[0]!.action(getMarkdown()).trimEnd()).toBe(
            "Alpha\n\n> quoted\n\n> quoted",
        );
    });

    it("a COLLAPSED heading's line duplicated down should land past its hidden section", async () => {
        const view = await makeEditor(
            "Intro\n\n## Section\n\nBody one\n\n## Next\n\nTail",
        );
        let hPos = -1;
        view.state.doc.forEach((node, offset) => {
            if (node.type.name === "heading" && node.textContent === "Section") hPos = offset;
        });
        view.dispatch(view.state.tr.setMeta(headingFoldPluginKey, { type: "toggle", pos: hPos }));
        expect(headingFoldPluginKey.getState(view.state)!.folded.has(hPos)).toBe(true);
        placeCaretIn(view, "Section");
        expect(duplicateSelectedBlocks(1)(view.state, view.dispatch, view)).toBe(true);
        // The copy must not vanish into the fold's hidden run.
        expect(blockOrder(view)).toEqual([
            "Intro", "Section", "Body one", "Section", "Next", "Tail",
        ]);
    });

    it("duplicate then undo should restore the original document in one step", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        placeCaretIn(view, "Alpha");
        duplicateSelectedBlocks(1)(view.state, view.dispatch, view);
        expect(blockOrder(view)).toEqual(["Alpha", "Alpha", "Beta"]);
        undo(view.state, view.dispatch);
        expect(blockOrder(view)).toEqual(["Alpha", "Beta"]);
    });

    it("a missing view should be a safe no-op returning false", async () => {
        const view = await makeEditor("Alpha");
        placeCaretIn(view, "Alpha");
        expect(duplicateSelectedBlocks(1)(view.state, view.dispatch)).toBe(false);
        expect(blockOrder(view)).toEqual(["Alpha"]);
    });
});

describe("deleteSelectedBlocks (Cmd+Shift+K / palette)", () => {
    it("a caret block should be deleted whole", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Beta");
        expect(deleteSelectedBlocks(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Alpha", "Gamma"]);
    });

    it("a block range should be deleted in one undo step", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Alpha");
        toggleBlockSelection(view.state, view.dispatch);
        extendBlockSelection(1)(view.state, view.dispatch); // Alpha + Beta
        expect(deleteSelectedBlocks(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Gamma"]);
        undo(view.state, view.dispatch);
        expect(blockOrder(view)).toEqual(["Alpha", "Beta", "Gamma"]);
    });

    it("deleting the ONLY block should leave the schema-required empty paragraph", async () => {
        const view = await makeEditor("Alpha");
        placeCaretIn(view, "Alpha");
        expect(deleteSelectedBlocks(view.state, view.dispatch, view)).toBe(true);
        expect(view.state.doc.childCount).toBe(1);
        expect(view.state.doc.textContent).toBe("");
    });

    it("a caret in a list item should delete the ITEM alone", async () => {
        const view = await makeEditor("Intro\n\n- one\n- two");
        let pos = -1;
        view.state.doc.descendants((node, nodePos) => {
            if (node.isTextblock && node.textContent === "one") pos = nodePos + 1;
            return pos === -1;
        });
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
        expect(deleteSelectedBlocks(view.state, view.dispatch, view)).toBe(true);
        const { getMarkdown } = await import("@milkdown/utils");
        expect(editors[0]!.action(getMarkdown()).trimEnd()).toBe("Intro\n\n- two");
    });

    it("deleting a list's LAST item should dissolve the emptied list", async () => {
        const view = await makeEditor("Intro\n\n- solo\n\nTail");
        let pos = -1;
        view.state.doc.descendants((node, nodePos) => {
            if (node.isTextblock && node.textContent === "solo") pos = nodePos + 1;
            return pos === -1;
        });
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
        expect(deleteSelectedBlocks(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Intro", "Tail"]);
    });

    it("a caret on a COLLAPSED heading should delete the line alone, revealing its section", async () => {
        const view = await makeEditor("Intro\n\n## Section\n\nBody one\n\nTail");
        let hPos = -1;
        view.state.doc.forEach((node, offset) => {
            if (node.type.name === "heading" && node.textContent === "Section") hPos = offset;
        });
        view.dispatch(view.state.tr.setMeta(headingFoldPluginKey, { type: "toggle", pos: hPos }));
        placeCaretIn(view, "Section");
        expect(deleteSelectedBlocks(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Intro", "Body one", "Tail"]);
    });

    it("a missing view should be a safe no-op returning false", async () => {
        const view = await makeEditor("Alpha");
        placeCaretIn(view, "Alpha");
        expect(deleteSelectedBlocks(view.state, view.dispatch)).toBe(false);
        expect(blockOrder(view)).toEqual(["Alpha"]);
    });

    it("a bare caret inside a table cell should NOT delete the table (MAR-107)", async () => {
        const view = await makeEditor("Intro\n\n| a | b |\n| --- | --- |\n| c | d |");
        // Caret into the first cell's text.
        let cell = -1;
        view.state.doc.descendants((node, pos) => {
            if (cell === -1 && node.isText && node.text === "a") cell = pos;
            return cell === -1;
        });
        expect(cell).toBeGreaterThan(-1);
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cell)));
        // No-op: the surprising blast radius is refused, the table stays.
        expect(deleteSelectedBlocks(view.state, view.dispatch, view)).toBe(false);
        expect(view.state.doc.child(1).type.name).toBe("table");
    });

    it("an explicit whole-table NodeSelection should still delete the table", async () => {
        const view = await makeEditor("Intro\n\n| a | b |\n| --- | --- |\n| c | d |");
        let tablePos = -1;
        view.state.doc.forEach((node, offset) => {
            if (node.type.name === "table") tablePos = offset;
        });
        expect(tablePos).toBeGreaterThan(-1);
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, tablePos)));
        expect(deleteSelectedBlocks(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Intro"]);
    });
});

describe("escalateSelectAll with a NodeSelection", () => {
    it("a selected HR should climb block → all, not jump to all", async () => {
        const view = await makeEditor("alpha\n\n---\n\nomega");
        let hrPos = -1;
        view.state.doc.forEach((node, offset) => {
            if (node.type.name === "hr") hrPos = offset;
        });
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, hrPos)));
        expect(escalateSelectAll(view.state, view.dispatch)).toBe(true);
        const sel = view.state.selection;
        expect(sel).toBeInstanceOf(BlockRangeSelection);
        expect(sel.from).toBe(hrPos);
        expect(sel.to).toBe(hrPos + 1);
        // Second press: everything.
        escalateSelectAll(view.state, view.dispatch);
        expect(view.state.selection.from).toBe(0);
        expect(view.state.selection.to).toBe(view.state.doc.content.size);
    });
});
