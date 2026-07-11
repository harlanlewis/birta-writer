/**
 * Tests for the gutter block menu (MAR-78): the Turn-into conversions and the
 * block actions (duplicate / delete / move / copy), all targeted by position.
 *
 * Drives the REAL Milkdown editor (real parser, real schema, the production
 * serialization config) through the marker buttons the headingFold plugin
 * renders, exactly like the browser. acquireVsCodeApi is injected by setup.ts.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import type { EditorView } from "@milkdown/prose/view";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import {
    setBlockMenuContext,
    turnIntoKindAt,
    moveRangeAt,
    moveBlockAt,
} from "../components/blockMenu";
import { mockVscodeApi } from "./setup";

let editors: Editor[] = [];
let activeEditor: Editor | null = null;

setBlockMenuContext({ getEditor: () => activeEditor });

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
    activeEditor = editor;
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function markdown(editor: Editor): string {
    return editor.action(getMarkdown()).trim();
}

/** All gutter markers, in document order (headings and paragraphs alike). */
function markers(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>(".heading-fold-marker"));
}

function openMenuOn(markerEl: HTMLButtonElement): HTMLElement {
    markerEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const menu = document.querySelector<HTMLElement>(".block-menu");
    expect(menu, "block menu did not open").not.toBeNull();
    return menu!;
}

function pickRow(menu: HTMLElement, label: string): HTMLElement {
    const row = Array.from(menu.querySelectorAll<HTMLElement>(".block-menu-item"))
        .find((el) => el.textContent === label);
    expect(row, `menu row "${label}" not found`).not.toBeNull();
    row!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    return row!;
}

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    activeEditor = null;
    document.querySelectorAll(".block-menu").forEach((el) => el.remove());
    document.body.innerHTML = "";
});

describe("turnIntoKindAt", () => {
    it("each top-level block type should map to its Turn-into kind", async () => {
        const editor = await makeEditor(
            [
                "plain text",
                "",
                "## Title",
                "",
                "- bullet",
                "",
                "1. ordered",
                "",
                "- [ ] task",
                "",
                "> quote",
                "",
                "```js",
                "code",
                "```",
                "",
                "---",
                "",
            ].join("\n"),
        );
        const v = view(editor);
        const kinds: (string | null)[] = [];
        v.state.doc.forEach((_node, offset) => {
            kinds.push(turnIntoKindAt(v, offset));
        });
        expect(kinds).toEqual([
            "paragraph",
            "h2",
            "bulletList",
            "orderedList",
            "taskList",
            "blockquote",
            "codeBlock",
            null, // hr — actions only
        ]);
    });
});

describe("Turn into", () => {
    it("picking Bullet List on a paragraph should convert it to a single-item list", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "Bullet List");
        expect(view(editor).state.doc.firstChild!.type.name).toBe("bullet_list");
        expect(markdown(editor)).toContain("Alpha");
    });

    it("picking Blockquote on a paragraph should wrap it", async () => {
        const editor = await makeEditor("Alpha");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "Blockquote");
        expect(view(editor).state.doc.firstChild!.type.name).toBe("blockquote");
        expect(markdown(editor)).toBe("> Alpha");
    });

    it("picking Bullet List on a heading should retype to prose first (list item, not a no-op)", async () => {
        const editor = await makeEditor("## Title");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "Bullet List");
        expect(view(editor).state.doc.firstChild!.type.name).toBe("bullet_list");
        expect(markdown(editor)).not.toContain("##");
    });

    it("picking Code Block on a heading should preserve its literal markdown source", async () => {
        const editor = await makeEditor("## Ti *em*");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "Code Block");
        const first = view(editor).state.doc.firstChild!;
        expect(first.type.name).toBe("code_block");
        expect(first.textContent).toBe("## Ti *em*");
    });

    it("picking the current type should be a no-op", async () => {
        const editor = await makeEditor("Alpha");
        view(editor);
        const before = markdown(editor);
        pickRow(openMenuOn(markers()[0]!), "P");
        expect(markdown(editor)).toBe(before);
    });
});

describe("block actions", () => {
    it("Duplicate should insert a copy right after the block", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "Duplicate");
        expect(markdown(editor)).toBe("Alpha\n\nAlpha\n\nBeta");
    });

    it("Delete should remove the block", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "Delete");
        expect(markdown(editor)).toBe("Beta");
    });

    it("Delete on the only block should leave a valid empty doc", async () => {
        const editor = await makeEditor("Alpha");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "Delete");
        expect(markdown(editor)).toBe("");
    });

    it("Move Down should swap the block with its next sibling", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "Move Down");
        expect(markdown(editor)).toBe("Beta\n\nAlpha");
    });

    it("Move Up on the first block should be disabled", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        view(editor);
        const menu = openMenuOn(markers()[0]!);
        const row = Array.from(menu.querySelectorAll<HTMLElement>(".block-menu-item"))
            .find((el) => el.textContent === "Move Up")!;
        expect(row.getAttribute("aria-disabled")).toBe("true");
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        expect(markdown(editor)).toBe("Alpha\n\nBeta"); // unchanged
    });

    it("Copy as Markdown should post the block's serialized source", async () => {
        const editor = await makeEditor("Alpha *em*\n\nBeta");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "Copy as Markdown");
        const call = mockVscodeApi.postMessage.mock.calls
            .map((args) => args[0] as { type: string; format?: string; data?: string })
            .find((msg) => msg.type === "clipboardWrite");
        expect(call).toBeDefined();
        expect(call!.format).toBe("markdown");
        expect(call!.data!.trim()).toBe("Alpha *em*");
    });

    it("Copy Link on a heading should post a [text](#slug) markdown link", async () => {
        const editor = await makeEditor("## My Great Title");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "Copy Link");
        const call = mockVscodeApi.postMessage.mock.calls
            .map((args) => args[0] as { type: string; data?: string })
            .find((msg) => msg.type === "clipboardWrite");
        expect(call?.data).toBe("[My Great Title](#my-great-title)");
    });

    it("a paragraph's menu should not offer Copy Link or section moves", async () => {
        const editor = await makeEditor("Alpha");
        view(editor);
        const menu = openMenuOn(markers()[0]!);
        const labels = Array.from(menu.querySelectorAll(".block-menu-item")).map((el) => el.textContent);
        expect(labels).not.toContain("Copy Link");
        expect(labels).toContain("Move Up");
        expect(labels).not.toContain("Move Section Up");
    });
});

describe("heading section semantics", () => {
    const DOC = "# A\n\ncontent A\n\n# B\n\ncontent B";

    it("moveRangeAt on a heading should span its whole section", async () => {
        const editor = await makeEditor(DOC);
        const v = view(editor);
        const range = moveRangeAt(v, 0)!;
        // Section A = heading A + its paragraph; B starts where A's range ends.
        expect(range.from).toBe(0);
        expect(v.state.doc.resolve(range.to).nodeAfter?.type.name).toBe("heading");
    });

    it("Move Section Up on the second section should swap whole sections", async () => {
        const editor = await makeEditor(DOC);
        view(editor);
        // markers(): [# A, P content A, # B, P content B] in document order.
        const headingMarkers = markers().filter((m) => !m.classList.contains("heading-fold-marker--paragraph"));
        pickRow(openMenuOn(headingMarkers[1]!), "Move Section Up");
        expect(markdown(editor)).toBe("# B\n\ncontent B\n\n# A\n\ncontent A");
    });

    it("moveBlockAt down on the first section should hop the whole next section", async () => {
        const editor = await makeEditor(DOC);
        const v = view(editor);
        expect(moveBlockAt(v, 0, 1)).toBe(true);
        expect(markdown(editor)).toBe("# B\n\ncontent B\n\n# A\n\ncontent A");
    });
});
