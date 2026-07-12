/**
 * Selection toolbar tests.
 *
 * Link button: the floating selection toolbar renders a link button after the
 * inline-code button, its mousedown invokes the openLinkPrompt callback (the
 * same prompt behind the main toolbar button and Cmd/Ctrl+K) without
 * destroying the editor selection, and the button is hidden in table
 * cell-selection mode.
 *
 * Format menu: the P/H1–H6 picks must route through the shared editor-command
 * registry so they behave exactly like the main toolbar — in particular a
 * heading pick inside a list item lifts the line out of the list instead of
 * silently no-oping (MAR-111).
 *
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    Editor,
    rootCtx,
    defaultValueCtx,
    editorViewCtx,
} from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { Selection, TextSelection } from "@milkdown/prose/state";
import { CellSelection } from "@milkdown/prose/tables";
import type { EditorView } from "@milkdown/prose/view";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../serialization";
import {
    setupSelectionToolbar,
    setPendingToolbarPos,
} from "../components/selectionToolbar";
import { initToolbar } from "../components/toolbar";
import { setupLinkPopup } from "../components/linkPopup";

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
        .create();
    // The link button routes through the shared link editor (the hover popup
    // singleton); wire it to this editor's view.
    const v = editor.action((ctx) => ctx.get(editorViewCtx));
    setupLinkPopup(root, () => v);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function selToolbar(): HTMLElement {
    const tb = document.querySelector<HTMLElement>(".sel-toolbar");
    expect(tb).not.toBeNull();
    return tb!;
}

function linkButton(): HTMLButtonElement {
    const btn = selToolbar().querySelector<HTMLButtonElement>(
        ".sel-tb-link-btn",
    );
    expect(btn).not.toBeNull();
    return btn!;
}

function mousedown(el: Element): MouseEvent {
    const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
}

/** Find the format-menu item carrying the given short label (P, H1…H6). */
function fmtItem(label: string): HTMLElement {
    const item = Array.from(
        document.querySelectorAll<HTMLElement>(".sel-tb-fmt-item"),
    ).find((el) => el.textContent === label);
    expect(item, `format menu item ${label}`).toBeTruthy();
    return item!;
}

/** Put the caret just inside the first text node whose content equals `text`. */
function caretInText(v: EditorView, text: string): void {
    let pos = -1;
    v.state.doc.descendants((n, p) => {
        if (pos < 0 && n.isText && n.text === text) { pos = p; }
    });
    if (pos < 0) { throw new Error(`text not found: ${text}`); }
    v.dispatch(v.state.tr.setSelection(Selection.near(v.state.doc.resolve(pos + 1))));
}

const md = (editor: Editor): string => editor.action(getMarkdown()).trim();

describe("selection toolbar link button", () => {
    let editor: Editor | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    afterEach(async () => {
        if (editor) {
            await editor.destroy();
            editor = null;
        }
    });

    it("setup should render a link button right after the inline-code button, separated", () => {
        // Arrange / Act
        setupSelectionToolbar(
            () => null,
            () => null,
            vi.fn(),
        );

        // Assert — the button exists, carries an icon, and sits behind a
        // separator that follows the inline format buttons
        const btn = linkButton();
        expect(btn.querySelector("svg")).not.toBeNull();
        expect(btn.previousElementSibling?.className).toBe("sel-tb-sep");
        expect(
            btn.previousElementSibling?.previousElementSibling?.className,
        ).toBe("sel-tb-btn"); // inline-code button
    });

    it("mousedown on the link button should invoke openLinkPrompt exactly once and preventDefault", () => {
        // Arrange
        const openLinkPrompt = vi.fn();
        setupSelectionToolbar(
            () => null,
            () => null,
            openLinkPrompt,
        );

        // Act
        const e = mousedown(linkButton());

        // Assert — one invocation, and default prevented so the editor
        // selection is not collapsed by the click
        expect(openLinkPrompt).toHaveBeenCalledTimes(1);
        expect(e.defaultPrevented).toBe(true);
    });

    it("with a text selection the button should be visible and clicking should keep the selection", async () => {
        // Arrange — real editor with "hello" selected
        editor = await makeEditor("hello world\n");
        const v = view(editor);
        const openLinkPrompt = vi.fn();
        const selTb = setupSelectionToolbar(
            () => v,
            () => editor,
            openLinkPrompt,
        );
        v.dispatch(
            v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)),
        );

        // Act — show the toolbar (pending pos skips jsdom-unfriendly
        // coordsAtPos measurement) and click the link button
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        // Assert — toolbar shown, link button visible
        expect(selToolbar().style.display).toBe("flex");
        const btn = linkButton();
        expect(btn.style.display).not.toBe("none");

        mousedown(btn);
        expect(openLinkPrompt).toHaveBeenCalledTimes(1);
        // The editor selection is untouched by the click
        expect(v.state.selection.from).toBe(1);
        expect(v.state.selection.to).toBe(6);
    });

    it("the link button wired to the REAL prompt should clamp a cross-paragraph selection", async () => {
        // Arrange — real editor + real top toolbar; the selection toolbar's
        // link button gets the SAME openLinkPrompt the Cmd/Ctrl+K shortcut
        // uses. Select "two" (p1) through "three" (p2).
        editor = await makeEditor("one two\n\nthree four\n");
        const v = view(editor);
        const topbar = document.createElement("div");
        topbar.className = "editor-topbar";
        document.body.appendChild(topbar);
        const tb = initToolbar(topbar, () => editor);
        const selTb = setupSelectionToolbar(
            () => v,
            () => editor,
            tb.openLinkPrompt,
        );
        v.dispatch(
            v.state.tr.setSelection(TextSelection.create(v.state.doc, 5, 15)),
        );
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        // Act — click the link button, confirm the prompt in the popup
        mousedown(linkButton());
        const popup = Array.from(
            document.querySelectorAll<HTMLElement>(".lp-root"),
        ).find((p) => p.style.display !== "none");
        expect(popup).toBeTruthy();
        const textInput = popup!.querySelector<HTMLInputElement>(".lp-text-input")!;
        const urlInput = popup!.querySelector<HTMLInputElement>(".lp-url-input")!;
        expect(textInput.value).toBe("two"); // clamped pre-fill
        urlInput.value = "x";
        urlInput.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "Enter",
                bubbles: true,
                cancelable: true,
            }),
        );

        // Assert — paragraphs survive; the link applies only inside p1
        expect(v.state.doc.childCount).toBe(2);
        expect(v.state.doc.child(0).textContent).toBe("one two");
        expect(v.state.doc.child(1).textContent).toBe("three four");
        let linkedText = "";
        let linkedHref = "";
        v.state.doc.descendants((node) => {
            const link = node.marks.find((m) => m.type.name === "link");
            if (node.isText && link) {
                linkedText = node.text ?? "";
                linkedHref = link.attrs["href"] as string;
            }
        });
        expect(linkedText).toBe("two");
        expect(linkedHref).toBe("x");
    });

    it("with a table cell selection the button should be hidden while bold stays visible", async () => {
        // Arrange — real editor with a GFM table, select two header cells
        editor = await makeEditor("| a | b |\n| --- | --- |\n| c | d |\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(
            () => v,
            () => editor,
            vi.fn(),
        );
        const cellPositions: number[] = [];
        v.state.doc.descendants((node, pos) => {
            const name = node.type.name;
            if (name === "table_cell" || name === "table_header") {
                cellPositions.push(pos);
            }
        });
        expect(cellPositions.length).toBeGreaterThanOrEqual(2);
        v.dispatch(
            v.state.tr.setSelection(
                CellSelection.create(
                    v.state.doc,
                    cellPositions[0],
                    cellPositions[1],
                ),
            ),
        );

        // Act
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        // Assert — toolbar shown in cell mode: link hidden, bold visible
        const toolbar = selToolbar();
        expect(toolbar.style.display).toBe("flex");
        expect(linkButton().style.display).toBe("none");
        const boldBtn = toolbar.querySelector<HTMLButtonElement>(
            ":scope > .sel-tb-btn",
        );
        expect(boldBtn).not.toBeNull();
        expect(boldBtn!.style.display).not.toBe("none");
    });
});

describe("selection toolbar format menu", () => {
    let editor: Editor | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    afterEach(async () => {
        if (editor) {
            await editor.destroy();
            editor = null;
        }
    });

    it("picking H1 with the caret inside a list item should lift the line out and make it a heading (MAR-111)", async () => {
        // Arrange — caret on the middle item of a bullet list
        editor = await makeEditor("- one\n- two\n- three");
        const v = view(editor);
        setupSelectionToolbar(
            () => v,
            () => editor,
            vi.fn(),
        );
        caretInText(v, "two");

        // Act — click the H1 entry of the format dropdown
        mousedown(fmtItem("H1"));

        // Assert — same result as the main toolbar's Heading 1: the line is
        // promoted out of the list, splitting it (not a silent no-op)
        expect(md(editor)).toBe("- one\n\n# two\n\n- three");
    });

    it("picking H3 with the caret inside a nested list item should promote it to a top-level heading", async () => {
        // Arrange
        editor = await makeEditor("- a\n  - b\n  - c");
        const v = view(editor);
        setupSelectionToolbar(
            () => v,
            () => editor,
            vi.fn(),
        );
        caretInText(v, "b");

        // Act
        mousedown(fmtItem("H3"));

        // Assert — lifted out of both list levels
        const out = md(editor);
        expect(out).toContain("### b");
        expect(out).not.toContain("- ### b");
    });

    it("picking H2 on a plain paragraph should apply the heading", async () => {
        // Arrange
        editor = await makeEditor("plain paragraph");
        const v = view(editor);
        setupSelectionToolbar(
            () => v,
            () => editor,
            vi.fn(),
        );
        caretInText(v, "plain paragraph");

        // Act
        mousedown(fmtItem("H2"));

        // Assert
        expect(md(editor)).toBe("## plain paragraph");
    });

    it("picking P on a heading should convert it back to a paragraph", async () => {
        // Arrange
        editor = await makeEditor("## Heading");
        const v = view(editor);
        setupSelectionToolbar(
            () => v,
            () => editor,
            vi.fn(),
        );
        caretInText(v, "Heading");

        // Act
        mousedown(fmtItem("P"));

        // Assert
        expect(md(editor)).toBe("Heading");
    });
});
