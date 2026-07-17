/**
 * Tests for the selection case transforms (MAR-97): uppercase / lowercase /
 * title case over the current selection, VS Code "Transform To …" parity.
 * Covers mark-extent preservation, partial-word selections, multi-block
 * selections, inline atoms (math / wikilink) staying untouched, title-case
 * word-boundary behavior, block-range selections, return-value contract
 * (caret → false, no-change → true without dispatch), and single-step undo.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { NodeSelection, TextSelection } from "../pm";
import { undo } from "../pm";
import type { Command } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { historyPlugin } from "../plugins/history";
import { BlockRangeSelection } from "../plugins/blockRange";
import {
    transformToUppercase,
    transformToLowercase,
    transformToTitleCase,
} from "../plugins/caseTransform";

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
        .use(historyPlugin)
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

/** Doc range [from, to) of the first text node containing `target`. */
function textRange(view: EditorView, target: string): { from: number; to: number } {
    let found: { from: number; to: number } | null = null;
    view.state.doc.descendants((node, pos) => {
        if (found || !node.isText) return found === null;
        const idx = node.text!.indexOf(target);
        if (idx >= 0) found = { from: pos + idx, to: pos + idx + target.length };
        return false;
    });
    expect(found).not.toBeNull();
    return found!;
}

/** Position of the first node named `name`. */
function nodePos(view: EditorView, name: string): number {
    let found = -1;
    view.state.doc.descendants((node, pos) => {
        if (found < 0 && node.type.name === name) found = pos;
        return found < 0;
    });
    expect(found).toBeGreaterThanOrEqual(0);
    return found;
}

/** Selects the given absolute range as a TextSelection. */
function selectRange(view: EditorView, from: number, to: number): void {
    view.dispatch(
        view.state.tr.setSelection(
            TextSelection.between(view.state.doc.resolve(from), view.state.doc.resolve(to)),
        ),
    );
}

/** Selects every text position in the document. */
function selectAll(view: EditorView): void {
    selectRange(view, 0, view.state.doc.content.size);
}

/** Runs a PM command against the live view. */
function run(view: EditorView, command: Command): boolean {
    return command(view.state, (tr) => view.dispatch(tr));
}

/** Flat list of text runs with their mark names, in document order. */
function inlineRuns(view: EditorView): Array<{ text: string; marks: string[] }> {
    const runs: Array<{ text: string; marks: string[] }> = [];
    view.state.doc.descendants((node) => {
        if (node.isText) {
            runs.push({ text: node.text!, marks: node.marks.map((m) => m.type.name) });
        }
        return true;
    });
    return runs;
}

/** Text of each top-level block, in order. */
function blockTexts(view: EditorView): string[] {
    const texts: string[] = [];
    view.state.doc.forEach((node) => {
        texts.push(node.textContent);
    });
    return texts;
}

describe("transformToUppercase", () => {
    it("a plain paragraph selection should uppercase all selected text", async () => {
        // Arrange
        const view = await makeEditor("hello world");
        selectAll(view);
        // Act
        const handled = run(view, transformToUppercase);
        // Assert
        expect(handled).toBe(true);
        expect(view.state.doc.textContent).toBe("HELLO WORLD");
    });

    it("a partial-word selection should uppercase only the selected characters", async () => {
        // Arrange
        const view = await makeEditor("hello world");
        const { from, to } = textRange(view, "ell");
        selectRange(view, from, to);
        // Act
        run(view, transformToUppercase);
        // Assert
        expect(view.state.doc.textContent).toBe("hELLo world");
    });

    it("a selection spanning a bold run should preserve the mark extents", async () => {
        // Arrange
        const view = await makeEditor("hello **bold** world");
        selectAll(view);
        // Act
        run(view, transformToUppercase);
        // Assert
        expect(inlineRuns(view)).toEqual([
            { text: "HELLO ", marks: [] },
            { text: "BOLD", marks: ["strong"] },
            { text: " WORLD", marks: [] },
        ]);
    });

    it("a selection spanning a link should keep the link mark and href", async () => {
        // Arrange
        const view = await makeEditor("a [link](https://example.test) b");
        selectAll(view);
        // Act
        run(view, transformToUppercase);
        // Assert
        const runs = inlineRuns(view);
        expect(runs.map((r) => r.text)).toEqual(["A ", "LINK", " B"]);
        expect(runs[1]!.marks).toEqual(["link"]);
        let href = "";
        view.state.doc.descendants((node) => {
            const link = node.marks.find((m) => m.type.name === "link");
            if (link) href = link.attrs["href"] as string;
            return true;
        });
        expect(href).toBe("https://example.test");
    });

    it("a selection across multiple blocks should transform every block", async () => {
        // Arrange
        const view = await makeEditor("alpha one\n\nbeta two");
        selectAll(view);
        // Act
        run(view, transformToUppercase);
        // Assert
        expect(blockTexts(view)).toEqual(["ALPHA ONE", "BETA TWO"]);
    });

    it("an inline math node inside the selection should keep its LaTeX source", async () => {
        // Arrange
        const view = await makeEditor("before $E=mc^2$ after");
        selectAll(view);
        // Act
        run(view, transformToUppercase);
        // Assert
        const mathNode = view.state.doc.nodeAt(nodePos(view, "math_inline"))!;
        expect(mathNode.textContent).toBe("E=mc^2");
        expect(blockTexts(view)).toEqual(["BEFORE E=mc^2 AFTER"]);
    });

    it("a wikilink atom inside the selection should stay untouched", async () => {
        // Arrange
        const view = await makeEditor("see [[Target|alias]] now");
        selectAll(view);
        // Act
        run(view, transformToUppercase);
        // Assert
        const wiki = view.state.doc.nodeAt(nodePos(view, "wiki_link"))!;
        expect(wiki.attrs["raw"]).toBe("Target|alias");
        expect(inlineRuns(view).map((r) => r.text)).toEqual(["SEE ", " NOW"]);
    });

    it("a caret-only selection should return false and dispatch nothing", async () => {
        // Arrange
        const view = await makeEditor("hello");
        const { from } = textRange(view, "hello");
        selectRange(view, from, from);
        const dispatch = vi.fn();
        // Act
        const handled = transformToUppercase(view.state, dispatch);
        // Assert
        expect(handled).toBe(false);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("a node selection containing no text should return false", async () => {
        // Arrange
        const view = await makeEditor("see [[Target]] now");
        const pos = nodePos(view, "wiki_link");
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
        const dispatch = vi.fn();
        // Act
        const handled = transformToUppercase(view.state, dispatch);
        // Assert
        expect(handled).toBe(false);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("an already-uppercase selection should return true without dispatching", async () => {
        // Arrange
        const view = await makeEditor("SHOUTING TEXT");
        selectAll(view);
        const dispatch = vi.fn();
        // Act
        const handled = transformToUppercase(view.state, dispatch);
        // Assert
        expect(handled).toBe(true);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("running the transform twice should not change the doc again", async () => {
        // Arrange
        const view = await makeEditor("some text");
        selectAll(view);
        run(view, transformToUppercase);
        const docAfterFirst = view.state.doc;
        // Act
        const handled = run(view, transformToUppercase);
        // Assert
        expect(handled).toBe(true);
        expect(view.state.doc).toBe(docAfterFirst);
    });

    it("a multi-segment transform should undo in a single step", async () => {
        // Arrange
        const view = await makeEditor("hello **bold** world\n\nsecond block");
        selectAll(view);
        run(view, transformToUppercase);
        expect(blockTexts(view)).toEqual(["HELLO BOLD WORLD", "SECOND BLOCK"]);
        // Act
        undo(view.state, (tr) => view.dispatch(tr));
        // Assert
        expect(blockTexts(view)).toEqual(["hello bold world", "second block"]);
    });
});

describe("transformToLowercase", () => {
    it("a mixed-case selection should lowercase all selected text", async () => {
        // Arrange
        const view = await makeEditor("Hello WORLD Again");
        selectAll(view);
        // Act
        const handled = run(view, transformToLowercase);
        // Assert
        expect(handled).toBe(true);
        expect(view.state.doc.textContent).toBe("hello world again");
    });

    it("a selection spanning a bold run should preserve the mark extents", async () => {
        // Arrange
        const view = await makeEditor("HELLO **BOLD** WORLD");
        selectAll(view);
        // Act
        run(view, transformToLowercase);
        // Assert
        expect(inlineRuns(view)).toEqual([
            { text: "hello ", marks: [] },
            { text: "bold", marks: ["strong"] },
            { text: " world", marks: [] },
        ]);
    });

    it("an already-lowercase selection should return true without dispatching", async () => {
        // Arrange
        const view = await makeEditor("quiet text");
        selectAll(view);
        const dispatch = vi.fn();
        // Act
        const handled = transformToLowercase(view.state, dispatch);
        // Assert
        expect(handled).toBe(true);
        expect(dispatch).not.toHaveBeenCalled();
    });
});

describe("transformToTitleCase", () => {
    it("a mixed-case sentence should capitalize each word and lowercase the rest", async () => {
        // Arrange
        const view = await makeEditor("hello WORLD aGaIn");
        selectAll(view);
        // Act
        const handled = run(view, transformToTitleCase);
        // Assert
        expect(handled).toBe(true);
        expect(view.state.doc.textContent).toBe("Hello World Again");
    });

    it("punctuation should act as a word boundary", async () => {
        // Arrange
        const view = await makeEditor("foo-bar (baz) qux.quux");
        selectAll(view);
        // Act
        run(view, transformToTitleCase);
        // Assert
        expect(view.state.doc.textContent).toBe("Foo-Bar (Baz) Qux.Quux");
    });

    it("multiple spaces should be preserved and still start a new word", async () => {
        // Arrange — the &#32; entities keep remark from collapsing the run.
        const view = await makeEditor("one&#32;&#32;&#32;two");
        selectAll(view);
        // Act
        run(view, transformToTitleCase);
        // Assert
        expect(view.state.doc.textContent).toBe("One   Two");
    });

    it("an already-title-cased selection should return true without dispatching", async () => {
        // Arrange
        const view = await makeEditor("Hello World");
        selectAll(view);
        const dispatch = vi.fn();
        // Act
        const handled = transformToTitleCase(view.state, dispatch);
        // Assert
        expect(handled).toBe(true);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("an apostrophe inside a word should not start a new word", async () => {
        // Arrange
        const view = await makeEditor("it's fine");
        selectAll(view);
        // Act
        run(view, transformToTitleCase);
        // Assert
        expect(view.state.doc.textContent).toBe("It's Fine");
    });

    it("a word starting with punctuation should capitalize its first letter", async () => {
        // Arrange
        const view = await makeEditor('"quoted" words');
        selectAll(view);
        // Act
        run(view, transformToTitleCase);
        // Assert
        expect(view.state.doc.textContent).toBe('"Quoted" Words');
    });

    it("a word split by a mark boundary should be capitalized only once", async () => {
        // Arrange — "hello" spans an unmarked and a bold text node.
        const view = await makeEditor("he**llo** world");
        selectAll(view);
        // Act
        run(view, transformToTitleCase);
        // Assert
        expect(inlineRuns(view)).toEqual([
            { text: "He", marks: [] },
            { text: "llo", marks: ["strong"] },
            { text: " World", marks: [] },
        ]);
    });

    it("an inline atom between words should start a new word", async () => {
        // Arrange
        const view = await makeEditor("alpha [[Link]]beta");
        selectAll(view);
        // Act
        run(view, transformToTitleCase);
        // Assert — "beta" follows the atom with no space, yet starts a word.
        expect(inlineRuns(view).map((r) => r.text)).toEqual(["Alpha ", "Beta"]);
    });

    it("each block of a multi-block selection should start a new word", async () => {
        // Arrange
        const view = await makeEditor("alpha one\n\nbeta two");
        selectAll(view);
        // Act
        run(view, transformToTitleCase);
        // Assert
        expect(blockTexts(view)).toEqual(["Alpha One", "Beta Two"]);
    });

    it("a block-range selection should transform every covered block", async () => {
        // Arrange
        const view = await makeEditor("alpha one\n\nbeta two\n\ngamma three");
        const sel = BlockRangeSelection.tryCreate(view.state.doc, 1, view.state.doc.content.size - 1);
        expect(sel).not.toBeNull();
        view.dispatch(view.state.tr.setSelection(sel!));
        // Act
        const handled = run(view, transformToTitleCase);
        // Assert
        expect(handled).toBe(true);
        expect(blockTexts(view)).toEqual(["Alpha One", "Beta Two", "Gamma Three"]);
    });
});
