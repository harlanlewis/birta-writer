/**
 * Wikilink in-place editing (MAR-74) against a REAL editor: the raw bytes are
 * the node's text content, the caret can sit inside them, reveal is a pure
 * decoration (never a doc change), an emptied wikilink is deleted when the
 * caret leaves, and — the existential bit — the content model round-trips
 * byte-identically through the save pipeline.
 *
 * Mirrors mathInlineEdit.test.ts, which pins the same behaviors over the node
 * this one was modelled on.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    wikiLinkEditPlugin,
    wikiAroundSelection,
    revealDecorations,
} from "../plugins/wikiLinkEdit";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";

let editors: Editor[] = [];

async function makeEditor(md: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, md);
            configureSerialization(ctx);
        })
        .use(wikiLinkEditPlugin)
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    editors.push(editor);
    return editor;
}

const view = (editor: Editor): EditorView => editor.action((ctx) => ctx.get(editorViewCtx));

/** Position of the first wiki_link node, or -1. */
function wikiPos(v: EditorView): number {
    let pos = -1;
    v.state.doc.descendants((n, p) => {
        if (pos < 0 && n.type.name === "wiki_link") {
            pos = p;
        }
    });
    return pos;
}

/** Put the caret at an absolute doc position. */
function caretAt(v: EditorView, pos: number): void {
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos)));
}

/** Send a keydown through the plugin's handler, as the view would. */
function pressKey(v: EditorView, key: string, shiftKey = false): boolean {
    const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true });
    return v.someProp("handleKeyDown", (f) => f(v, event) === true) === true;
}

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

describe("wikilink source content", () => {
    it("a parsed wikilink should hold its raw bytes as text content", async () => {
        // Arrange / Act
        const v = view(await makeEditor("See [[target#head|alias]] now.\n"));

        // Assert
        const node = v.state.doc.nodeAt(wikiPos(v))!;
        expect(node.textContent).toBe("target#head|alias");
        expect(node.isAtom).toBe(false);
    });

    it("editing the revealed source should round-trip the edited bytes exactly", async () => {
        // Arrange
        const editor = await makeEditor("See [[target]] now.\n");
        const v = view(editor);
        const before = "See [[target]] now.\n";
        const protection = computeRoundTripProtection(before, editor.action(getMarkdown()));
        const pos = wikiPos(v);

        // Act — caret inside, at the end of the source, then type
        caretAt(v, pos + 1 + v.state.doc.nodeAt(pos)!.content.size);
        v.dispatch(v.state.tr.insertText("-page"));

        // Assert
        const merged = applyMinimalChanges(before, editor.action(getMarkdown()), protection);
        expect(merged).toBe("See [[target-page]] now.\n");
    });
});

describe("reveal is pure selection state", () => {
    it("a caret outside the wikilink should decorate nothing", async () => {
        // Arrange
        const v = view(await makeEditor("See [[target]] now.\n"));

        // Act
        caretAt(v, 1);

        // Assert
        expect(wikiAroundSelection(v.state)).toBeNull();
        expect(revealDecorations(v.state)).toBe(
            revealDecorations(v.state).constructor.empty,
        );
    });

    it("a caret inside the wikilink should decorate exactly that node", async () => {
        // Arrange
        const v = view(await makeEditor("See [[target]] now.\n"));
        const pos = wikiPos(v);

        // Act
        caretAt(v, pos + 1);

        // Assert
        const range = wikiAroundSelection(v.state);
        expect(range).not.toBeNull();
        expect(range!.pos).toBe(pos);
        expect(revealDecorations(v.state).find().length).toBe(1);
    });

    it("moving the caret in and out should never change the document", async () => {
        // Arrange
        const editor = await makeEditor("See [[target]] now.\n");
        const v = view(editor);
        const doc = v.state.doc;
        const pos = wikiPos(v);

        // Act
        caretAt(v, pos + 1);
        caretAt(v, 1);

        // Assert — reveal is a decoration, so the doc is the SAME object
        expect(v.state.doc.eq(doc)).toBe(true);
        expect(editor.action(getMarkdown())).toBe("See [[target]] now.\n");
    });
});

describe("boundary keys reach the hidden source", () => {
    it("ArrowRight into the node should place the caret inside at the start", async () => {
        // Arrange
        const v = view(await makeEditor("See [[target]] now.\n"));
        const pos = wikiPos(v);
        caretAt(v, pos);

        // Act
        expect(pressKey(v, "ArrowRight")).toBe(true);

        // Assert
        expect(v.state.selection.$from.parent.type.name).toBe("wiki_link");
        expect(v.state.selection.$from.parentOffset).toBe(0);
    });

    it("ArrowLeft into the node should place the caret inside at the end", async () => {
        // Arrange
        const v = view(await makeEditor("See [[target]] now.\n"));
        const pos = wikiPos(v);
        const size = v.state.doc.nodeAt(pos)!.nodeSize;
        caretAt(v, pos + size);

        // Act
        expect(pressKey(v, "ArrowLeft")).toBe(true);

        // Assert
        const { $from } = v.state.selection;
        expect($from.parent.type.name).toBe("wiki_link");
        expect($from.parentOffset).toBe($from.parent.content.size);
    });

    it("Backspace against the edge should reveal instead of deleting the node", async () => {
        // Arrange
        const editor = await makeEditor("See [[target]] now.\n");
        const v = view(editor);
        const pos = wikiPos(v);
        caretAt(v, pos + v.state.doc.nodeAt(pos)!.nodeSize);

        // Act
        expect(pressKey(v, "Backspace")).toBe(true);

        // Assert — the caret is inside and nothing was deleted
        expect(v.state.selection.$from.parent.type.name).toBe("wiki_link");
        expect(editor.action(getMarkdown())).toBe("See [[target]] now.\n");
    });

    it("ArrowRight at the end of the source should leave the node", async () => {
        // Arrange
        const v = view(await makeEditor("See [[target]] now.\n"));
        const pos = wikiPos(v);
        const node = v.state.doc.nodeAt(pos)!;
        caretAt(v, pos + 1 + node.content.size);

        // Act
        expect(pressKey(v, "ArrowRight")).toBe(true);

        // Assert
        expect(v.state.selection.$from.parent.type.name).not.toBe("wiki_link");
    });
});

describe("bracket keys cannot break the delimiter grammar", () => {
    it("a bracket typed inside the source should be swallowed", async () => {
        // Arrange
        const editor = await makeEditor("See [[target]] now.\n");
        const v = view(editor);
        const pos = wikiPos(v);
        caretAt(v, pos + 1); // start of the source

        // Act — both brackets, at a position that is NOT the end
        const swallowedOpen = v.someProp(
            "handleTextInput",
            (f) => f(v, pos + 1, pos + 1, "[") === true,
        );
        const swallowedClose = v.someProp(
            "handleTextInput",
            (f) => f(v, pos + 1, pos + 1, "]") === true,
        );

        // Assert — neither reached the document
        expect(swallowedOpen).toBe(true);
        expect(swallowedClose).toBe(true);
        expect(editor.action(getMarkdown())).toBe("See [[target]] now.\n");
    });

    it("a closing bracket at the end of the source should exit the node", async () => {
        // Arrange
        const editor = await makeEditor("See [[target]] now.\n");
        const v = view(editor);
        const pos = wikiPos(v);
        const end = pos + 1 + v.state.doc.nodeAt(pos)!.content.size;
        caretAt(v, end);

        // Act
        v.someProp("handleTextInput", (f) => f(v, end, end, "]") === true);

        // Assert — caret left, bytes unchanged
        expect(v.state.selection.$from.parent.type.name).not.toBe("wiki_link");
        expect(editor.action(getMarkdown())).toBe("See [[target]] now.\n");
    });
});

describe("an emptied wikilink", () => {
    it("should survive while the caret is still inside it", async () => {
        // Arrange
        const editor = await makeEditor("See [[target]] now.\n");
        const v = view(editor);
        const pos = wikiPos(v);
        const node = v.state.doc.nodeAt(pos)!;

        // Act — clear the source, caret stays inside
        const tr = v.state.tr.delete(pos + 1, pos + 1 + node.content.size);
        v.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)));

        // Assert
        expect(wikiPos(v)).toBe(pos);
    });

    it("should be deleted once the caret leaves", async () => {
        // Arrange
        const editor = await makeEditor("See [[target]] now.\n");
        const v = view(editor);
        const pos = wikiPos(v);
        const node = v.state.doc.nodeAt(pos)!;
        const tr = v.state.tr.delete(pos + 1, pos + 1 + node.content.size);
        v.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)));

        // Act — caret leaves
        caretAt(v, 1);

        // Assert
        expect(wikiPos(v)).toBe(-1);
        expect(editor.action(getMarkdown())).toBe("See  now.\n");
    });
});
