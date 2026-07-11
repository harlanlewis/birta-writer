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
    headingAnchorSlug,
} from "../components/blockMenu";
import { headingFoldPluginKey } from "../plugins/headingFold";
import { TextSelection } from "@milkdown/prose/state";
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

    it("image-only and html-only paragraphs should have no Turn-into kind", async () => {
        const editor = await makeEditor("![img](data:,x)\n\n<div>raw</div>");
        const v = view(editor);
        const kinds: (string | null)[] = [];
        v.state.doc.forEach((_node, offset) => {
            kinds.push(turnIntoKindAt(v, offset));
        });
        expect(kinds).toEqual([null, null]);
    });

    it("a whitespace-only paragraph should still be prose (P marker, paragraph kind)", async () => {
        const editor = await makeEditor("Alpha");
        const v = view(editor);
        // Build a paragraph whose only child is whitespace text.
        const paragraph = v.state.schema.nodes["paragraph"]!;
        const ws = paragraph.create(null, v.state.schema.text("   "));
        v.dispatch(v.state.tr.insert(v.state.doc.content.size, ws));
        let wsPos = -1;
        v.state.doc.forEach((node, offset) => {
            if (!node.textContent.trim()) wsPos = offset;
        });
        expect(turnIntoKindAt(v, wsPos)).toBe("paragraph");
        const glyphs = Array.from(document.querySelectorAll(".heading-fold-marker--block"))
            .map((el) => el.textContent);
        expect(glyphs).toEqual(["P", "P"]);
    });
});

describe("Turn into — non-prose sources", () => {
    it("bullet list → ordered list should retype the node in place", async () => {
        const editor = await makeEditor("- one\n- two");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "Ordered List");
        expect(view(editor).state.doc.firstChild!.type.name).toBe("ordered_list");
        expect(markdown(editor)).toBe("1. one\n2. two");
    });

    it("bullet list → task list should mark every item checkable", async () => {
        const editor = await makeEditor("- one\n- two");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "Task List");
        expect(markdown(editor)).toBe("- [ ] one\n- [ ] two");
    });

    it("bullet list → paragraph should unwrap every item", async () => {
        const editor = await makeEditor("- one\n- two");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "P");
        expect(markdown(editor)).toBe("one\n\ntwo");
    });

    it("bullet list → H2 should turn each item's lead paragraph into a heading", async () => {
        const editor = await makeEditor("- one\n- two");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "H2");
        expect(markdown(editor)).toBe("## one\n\n## two");
    });

    it("bullet list → blockquote should wrap the whole list", async () => {
        const editor = await makeEditor("- one\n- two");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "Blockquote");
        expect(markdown(editor)).toBe("> - one\n> - two");
    });

    it("blockquote → paragraph should unwrap the quote", async () => {
        const editor = await makeEditor("> quoted line");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "P");
        expect(markdown(editor)).toBe("quoted line");
    });

    it("blockquote → H3 should unwrap and retype the first paragraph", async () => {
        const editor = await makeEditor("> quoted line");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "H3");
        expect(markdown(editor)).toBe("### quoted line");
    });

    it("blockquote → bullet list should itemize each paragraph", async () => {
        const editor = await makeEditor("> alpha\n>\n> beta");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "Bullet List");
        expect(markdown(editor)).toBe("- alpha\n- beta");
    });

    it("a whole list → code block should fence its literal markdown source", async () => {
        const editor = await makeEditor("- one\n- two");
        view(editor);
        pickRow(openMenuOn(markers()[0]!), "Code Block");
        const first = view(editor).state.doc.firstChild!;
        expect(first.type.name).toBe("code_block");
        expect(first.textContent).toContain("- one");
        expect(first.textContent).toContain("- two");
    });

    it("a code block's menu should offer no conversions except itself", async () => {
        const editor = await makeEditor("```js\nlet x = 1\n```");
        view(editor);
        const menu = openMenuOn(markers()[0]!);
        const labels = Array.from(menu.querySelectorAll(".block-menu-item")).map((el) => el.textContent);
        expect(labels).toContain("Code Block"); // the filled current row
        expect(labels).not.toContain("P");
        expect(labels).not.toContain("Bullet List");
        expect(labels).toContain("Duplicate"); // actions always present
    });

    it("an image-only paragraph's menu should be actions-only", async () => {
        const editor = await makeEditor("![img](data:,x)");
        view(editor);
        const menu = openMenuOn(markers()[0]!);
        const labels = Array.from(menu.querySelectorAll(".block-menu-item")).map((el) => el.textContent);
        expect(labels).not.toContain("P");
        expect(labels).not.toContain("Code Block");
        expect(labels).toEqual(["Duplicate", "Copy as Markdown", "Move Up", "Move Down", "Delete"]);
    });
});

describe("block markers for every top-level type", () => {
    it("lists, quotes, code blocks, images, and html should carry glyph markers", async () => {
        const editor = await makeEditor(
            [
                "text",
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
                "![img](data:,x)",
                "",
                "<div>raw</div>",
                "",
            ].join("\n"),
        );
        view(editor);
        const glyphs = Array.from(
            document.querySelectorAll(".heading-fold-marker--block"),
        ).map((el) => el.textContent);
        expect(glyphs).toEqual(["P", "-", "1.", "[ ]", ">", "```", "![]", "<>"]);
        // The P marker keeps its historical class; glyph markers don't.
        expect(document.querySelectorAll(".heading-fold-marker--paragraph")).toHaveLength(1);
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

describe("fold state across moves and deletes", () => {
    const DOC = "# A\n\ncontent A\n\n# B\n\ncontent B";
    const foldedSet = (v: ReturnType<typeof view>) =>
        headingFoldPluginKey.getState(v.state) ?? new Set<number>();
    const collapse = (v: ReturnType<typeof view>, pos: number) =>
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, { type: "toggle", pos }));

    it("a collapsed section should stay collapsed after Move Section Down", async () => {
        const editor = await makeEditor(DOC);
        const v = view(editor);
        collapse(v, 0); // fold section A
        expect(foldedSet(v).has(0)).toBe(true);
        expect(moveBlockAt(v, 0, 1)).toBe(true);
        expect(markdown(editor)).toBe("# B\n\ncontent B\n\n# A\n\ncontent A");
        // Section A now starts after B's section; its fold entry moved along.
        let posA = -1;
        v.state.doc.forEach((node, offset) => {
            if (node.type.name === "heading" && node.textContent === "A") posA = offset;
        });
        const folded = foldedSet(v);
        expect(folded.has(posA)).toBe(true);
        expect(folded.size).toBe(1); // and ONLY A — B must not inherit it
    });

    it("moving an expanded section past a collapsed one should not steal its fold", async () => {
        const editor = await makeEditor(DOC);
        const v = view(editor);
        // Collapse B, then move A (expanded) down past it.
        let posB = -1;
        v.state.doc.forEach((node, offset) => {
            if (node.type.name === "heading" && node.textContent === "B") posB = offset;
        });
        collapse(v, posB);
        expect(moveBlockAt(v, 0, 1)).toBe(true);
        // B now leads the doc, still collapsed; A (now second) is expanded.
        const folded = foldedSet(v);
        expect(folded.has(0)).toBe(true);
        expect(folded.size).toBe(1);
    });

    it("deleting a collapsed heading should not transfer its fold to the next heading", async () => {
        const editor = await makeEditor("# A\n\n# B\n\ncontent B");
        const v = view(editor);
        collapse(v, 0);
        pickRow(openMenuOn(markers().filter((m) => !m.classList.contains("heading-fold-marker--paragraph"))[0]!), "Delete");
        expect(markdown(editor)).toBe("# B\n\ncontent B");
        expect(foldedSet(v).size).toBe(0); // B stays expanded
    });
});

describe("copy actions", () => {
    it("Copy as Markdown should ignore a non-empty ambient selection elsewhere", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        const v = view(editor);
        // Select "Alph" in block 1, then copy block 2 from its gutter menu.
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 5)));
        pickRow(openMenuOn(markers()[1]!), "Copy as Markdown");
        const call = mockVscodeApi.postMessage.mock.calls
            .map((args) => args[0] as { type: string; data?: string })
            .find((msg) => msg.type === "clipboardWrite");
        expect(call?.data?.trim()).toBe("Beta");
    });

    it("Copy Link on a duplicate heading should carry the -N anchor suffix", async () => {
        const editor = await makeEditor("## Setup\n\ntext\n\n## Setup");
        const v = view(editor);
        let secondPos = -1;
        v.state.doc.forEach((node, offset) => {
            if (node.type.name === "heading") secondPos = offset; // last wins
        });
        expect(headingAnchorSlug(v.state.doc, 0)).toBe("setup");
        expect(headingAnchorSlug(v.state.doc, secondPos)).toBe("setup-1");
        const headingMarkers = markers().filter((m) => !m.classList.contains("heading-fold-marker--paragraph"));
        pickRow(openMenuOn(headingMarkers[1]!), "Copy Link");
        const call = mockVscodeApi.postMessage.mock.calls
            .map((args) => args[0] as { type: string; data?: string })
            .find((msg) => msg.type === "clipboardWrite");
        expect(call?.data).toBe("[Setup](#setup-1)");
    });
});

describe("menu lifecycle", () => {
    it("a document change while the menu is open should close it", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        const v = view(editor);
        openMenuOn(markers()[0]!);
        // Simulate an inbound edit (external sync / typing): insert text.
        v.dispatch(v.state.tr.insertText("x", 1));
        expect(document.querySelector(".block-menu")).toBeNull();
    });

    it("a selection-only transaction should NOT close the menu", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        const v = view(editor);
        openMenuOn(markers()[0]!);
        const { TextSelection } = await import("@milkdown/prose/state");
        v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(3))));
        expect(document.querySelector(".block-menu")).not.toBeNull();
    });

    it("an action whose block was replaced under it should be a no-op", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        const v = view(editor);
        const menu = openMenuOn(markers()[0]!);
        // Bypass the doc-change close (unit-level: pretend the close was
        // missed) by swapping the first block for a different node directly.
        const heading = v.state.schema.nodes["heading"]!;
        v.dispatch(v.state.tr.setNodeMarkup(0, heading, { level: 2 }));
        document.body.appendChild(menu); // re-attach to click a row
        pickRow(menu, "Delete");
        // The identity guard must refuse: both blocks still present.
        expect(markdown(editor)).toBe("## Alpha\n\nBeta");
    });

    it("opening a marker should set aria-expanded, closing should clear it", async () => {
        const editor = await makeEditor("Alpha");
        view(editor);
        const marker = markers()[0]!;
        expect(marker.getAttribute("aria-expanded")).toBe("false");
        openMenuOn(marker);
        expect(marker.getAttribute("aria-expanded")).toBe("true");
        marker.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        expect(marker.getAttribute("aria-expanded")).toBe("false");
        expect(document.querySelector(".block-menu")).toBeNull();
    });

    it("only one menu should be open at a time", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        view(editor);
        openMenuOn(markers()[0]!);
        openMenuOn(markers()[1]!);
        expect(document.querySelectorAll(".block-menu")).toHaveLength(1);
    });

    it("a mousedown outside the menu should close it", async () => {
        const editor = await makeEditor("Alpha");
        view(editor);
        openMenuOn(markers()[0]!);
        document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        expect(document.querySelector(".block-menu")).toBeNull();
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
