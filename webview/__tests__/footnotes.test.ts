/**
 * Footnote feature tests (MAR-15):
 *   - pure helpers (display numbering, definition lookup, next free label);
 *   - the insert command through the REAL production editor stack;
 *   - reference/definition NodeView rendering + numbering sync.
 *
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

// createEditor pulls in the full production plugin stack (headingSticky, ...)
// which observes layout; jsdom lacks ResizeObserver / rAF.
beforeAll(() => {
    if (typeof globalThis.ResizeObserver === "undefined") {
        globalThis.ResizeObserver = class {
            observe(): void {}
            unobserve(): void {}
            disconnect(): void {}
        } as unknown as typeof ResizeObserver;
    }
    if (typeof globalThis.requestAnimationFrame === "undefined") {
        globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
            setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame;
        globalThis.cancelAnimationFrame = ((id: number) =>
            clearTimeout(id)) as unknown as typeof cancelAnimationFrame;
    }
});

import {
    Editor,
    rootCtx,
    defaultValueCtx,
    editorViewCtx,
    commandsCtx,
} from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { getMarkdown } from "@milkdown/utils";
import type { Node as PMNode } from "@milkdown/prose/model";
import { TextSelection } from "@milkdown/prose/state";
import { configureSerialization, pureCommonmark } from "../serialization";
import { createEditor } from "../editor";
import { insertFootnoteCommand } from "../plugins";
import {
    computeDisplayIndex,
    findDefinitionByLabel,
    findFirstReferencePos,
    nextFreeLabel,
} from "../components/footnote";

/** Lightweight gfm-only editor for parsing markdown into a real doc. */
async function makeDoc(markdown: string): Promise<{ doc: PMNode; destroy: () => Promise<void> }> {
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
        .create();
    const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
    return { doc, destroy: () => editor.destroy() };
}

const SAMPLE = [
    "Intro with a note[^1] and another[^note].",
    "",
    "Cited again[^note] here.",
    "",
    "[^1]: First note.",
    "",
    "[^note]: Second note.",
    "",
    "[^unused]: Never referenced.",
    "",
].join("\n");

describe("computeDisplayIndex", () => {
    it("references in doc order should get 1-based numbers, duplicates sharing one", async () => {
        const { doc, destroy } = await makeDoc(SAMPLE);
        const map = computeDisplayIndex(doc);
        expect(map.get("1")).toBe(1);
        expect(map.get("note")).toBe(2);
        // A second reference to "note" must NOT bump the counter.
        expect(map.size).toBe(2);
        // An unused definition has no reference, so it is not numbered.
        expect(map.has("unused")).toBe(false);
        await destroy();
    });

    it("a document with no footnotes should yield an empty map", async () => {
        const { doc, destroy } = await makeDoc("Just a plain paragraph.\n");
        expect(computeDisplayIndex(doc).size).toBe(0);
        await destroy();
    });
});

describe("findDefinitionByLabel", () => {
    it("an existing label should return its definition node", async () => {
        const { doc, destroy } = await makeDoc(SAMPLE);
        const hit = findDefinitionByLabel(doc, "note");
        expect(hit).not.toBeNull();
        expect(hit!.node.type.name).toBe("footnote_definition");
        expect(hit!.node.textContent).toContain("Second note.");
        await destroy();
    });

    it("a missing label should return null", async () => {
        const { doc, destroy } = await makeDoc(SAMPLE);
        expect(findDefinitionByLabel(doc, "ghost")).toBeNull();
        await destroy();
    });
});

describe("findFirstReferencePos", () => {
    it("a referenced label should return the position of its first reference", async () => {
        const { doc, destroy } = await makeDoc(SAMPLE);
        const pos = findFirstReferencePos(doc, "note");
        expect(pos).not.toBeNull();
        expect(doc.nodeAt(pos!)?.type.name).toBe("footnote_reference");
        await destroy();
    });

    it("an unreferenced label should return null", async () => {
        const { doc, destroy } = await makeDoc(SAMPLE);
        expect(findFirstReferencePos(doc, "unused")).toBeNull();
        await destroy();
    });
});

describe("nextFreeLabel", () => {
    it("should pick the smallest positive integer not already used", async () => {
        // Labels 1 and note are used; next free numeric label is 2.
        const { doc, destroy } = await makeDoc(SAMPLE);
        expect(nextFreeLabel(doc)).toBe("2");
        await destroy();
    });

    it("an empty document should start at 1", async () => {
        const { doc, destroy } = await makeDoc("Nothing here.\n");
        expect(nextFreeLabel(doc)).toBe("1");
        await destroy();
    });

    it("should skip past existing numeric labels", async () => {
        const md = "One[^1] two[^2] three[^3].\n\n[^1]: a\n\n[^2]: b\n\n[^3]: c\n";
        const { doc, destroy } = await makeDoc(md);
        expect(nextFreeLabel(doc)).toBe("4");
        await destroy();
    });
});

describe("insertFootnoteCommand (real editor stack)", () => {
    let editor: Editor;
    let container: HTMLElement;

    afterEach(async () => {
        await editor?.destroy();
    });

    async function boot(initial: string): Promise<void> {
        container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, initial, () => {});
    }

    it("should add a reference at the cursor and a definition at the doc end", async () => {
        await boot("Hello world.\n");
        editor.action((ctx) => {
            ctx.get(commandsCtx).call(insertFootnoteCommand.key);
        });

        const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
        let refs = 0;
        let defs = 0;
        let defLabel = "";
        let refLabel = "";
        doc.descendants((node) => {
            if (node.type.name === "footnote_reference") { refs++; refLabel = node.attrs["label"] as string; }
            if (node.type.name === "footnote_definition") { defs++; defLabel = node.attrs["label"] as string; }
            return true;
        });
        expect(refs).toBe(1);
        expect(defs).toBe(1);
        // Reference and definition share the same (numeric) label.
        expect(refLabel).toBe("1");
        expect(defLabel).toBe("1");
        // The definition is the LAST block in the document.
        expect(doc.lastChild?.type.name).toBe("footnote_definition");
    });

    it("should place the cursor inside the new definition", async () => {
        await boot("Hello world.\n");
        editor.action((ctx) => {
            ctx.get(commandsCtx).call(insertFootnoteCommand.key);
        });
        const view = editor.action((ctx) => ctx.get(editorViewCtx));
        const { $from } = view.state.selection;
        let insideDef = false;
        for (let d = $from.depth; d >= 0; d--) {
            if ($from.node(d).type.name === "footnote_definition") insideDef = true;
        }
        expect(insideDef).toBe(true);
    });

    it("should pick the next free label when a footnote already exists", async () => {
        await boot("Text[^1] here.\n\n[^1]: Existing.\n");
        editor.action((ctx) => {
            ctx.get(commandsCtx).call(insertFootnoteCommand.key);
        });
        const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
        const labels: string[] = [];
        doc.descendants((node) => {
            if (node.type.name === "footnote_definition") labels.push(node.attrs["label"] as string);
            return true;
        });
        expect(labels).toContain("1");
        expect(labels).toContain("2");
    });

    it("the inserted footnote should survive serialization with its label", async () => {
        await boot("Body text.\n");
        editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            // Put the cursor at the end of the paragraph, then insert.
            const end = view.state.doc.content.size - 1;
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
            ctx.get(commandsCtx).call(insertFootnoteCommand.key);
            // Type the note body into the definition (cursor is already there).
            const v2 = ctx.get(editorViewCtx);
            v2.dispatch(v2.state.tr.insertText("Inserted note body."));
        });
        const md = editor.action(getMarkdown());
        expect(md).toContain("Body text.[^1]");
        expect(md).toContain("[^1]: Inserted note body.");
    });
});

describe("footnote NodeViews (real editor stack)", () => {
    let editor: Editor;

    afterEach(async () => {
        await editor?.destroy();
    });

    it("reference chips should render their display number and definitions their badge", async () => {
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, SAMPLE, () => {});

        const chips = container.querySelectorAll<HTMLElement>(".footnote-ref");
        // Three references in the source (1, note, note) → three chips.
        expect(chips.length).toBe(3);
        const byLabel = (l: string) =>
            Array.from(chips).find((c) => c.dataset["label"] === l)!;
        expect(byLabel("1").textContent).toBe("1");
        expect(byLabel("note").textContent).toBe("2");

        // Definitions render an editable content region + a numbered badge.
        const defs = container.querySelectorAll<HTMLElement>(".footnote-def");
        expect(defs.length).toBe(3);
        const contentEls = container.querySelectorAll(".footnote-def-content");
        expect(contentEls.length).toBe(3);
        const badge1 = Array.from(
            container.querySelectorAll<HTMLElement>(".footnote-def-badge"),
        ).find((b) => b.dataset["label"] === "note");
        expect(badge1?.textContent).toBe("2");
    });

    function countRefs(container: HTMLElement): number {
        return container.querySelectorAll(".footnote-ref").length;
    }

    /** Simulates typing `char` at the end of the first paragraph. */
    function typeAtFirstParaEnd(view: import("@milkdown/prose/view").EditorView, char: string): boolean {
        const firstPara = view.state.doc.child(0);
        const at = 1 + firstPara.content.size; // inside first paragraph, at its end
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
        return (
            view.someProp("handleTextInput", (f) => f(view, at, at, char)) ?? false
        );
    }

    it("typing [^label] with a matching definition should become a reference chip", async () => {
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, "See [^1\n\n[^1]: Def.\n", () => {});
        const view = editor.action((ctx) => ctx.get(editorViewCtx));
        expect(countRefs(container)).toBe(0);

        const handled = typeAtFirstParaEnd(view, "]");
        expect(handled).toBe(true);
        expect(countRefs(container)).toBe(1);
    });

    it("typing [^label] with NO matching definition should stay literal text", async () => {
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, "Orphan [^x\n", () => {});
        const view = editor.action((ctx) => ctx.get(editorViewCtx));

        const handled = typeAtFirstParaEnd(view, "]");
        expect(handled).toBe(false);
        expect(countRefs(container)).toBe(0);
    });

    it("editing a definition body should keep the label on serialize", async () => {
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, "Ref[^1].\n\n[^1]: Original.\n", () => {});

        editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            let at = -1;
            view.state.doc.descendants((node, pos) => {
                if (node.isText && node.text === "Original.") { at = pos + node.text!.length; return false; }
                return true;
            });
            view.dispatch(view.state.tr.insertText(" Edited.", at));
        });
        const md = editor.action(getMarkdown());
        expect(md).toContain("[^1]: Original. Edited.");
    });
});
