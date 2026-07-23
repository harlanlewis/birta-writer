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
import { Selection, TextSelection } from "../pm";
import { CellSelection } from "../pm";
import { BlockRangeSelection } from "../plugins/blockRange";
import type { EditorView } from "../pm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
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
        .use(gfmFidelity)
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
        ).toContain("sel-tb-btn"); // inline-code button
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

    it("hide() should dismiss a shown bar (the choke point the link editor uses to un-sandwich the selection)", async () => {
        // Arrange — a text selection with the bar shown
        editor = await makeEditor("hello world\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(
            () => v,
            () => editor,
            vi.fn(),
        );
        v.dispatch(
            v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)),
        );
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);
        expect(selToolbar().style.display).toBe("flex");

        // Act — the shared link editor opening calls hide() (wired in index.ts
        // on focus entering the popup) so the palette above and the popup below
        // don't sandwich the same range
        selTb.hide();

        // Assert
        expect(selToolbar().style.display).toBe("none");
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

/** A button identified by its aria-label prefix (buttons with a shortcut append
 *  it to the label, e.g. "Bold ⌘B", so match on the leading name). */
function btnByLabel(label: string): HTMLButtonElement {
    const btn = selToolbar().querySelector<HTMLButtonElement>(
        `.sel-tb-btn[aria-label^="${label}"]`,
    );
    expect(btn, `button ${label}`).not.toBeNull();
    return btn!;
}

describe("selection toolbar layout & active state", () => {
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

    it("inline math should sit between inline code and highlight (not in the clear-formatting group)", () => {
        // Arrange / Act
        setupSelectionToolbar(() => null, () => null, vi.fn());

        // Assert — DOM order: … Inline Code, Inline Math, Highlight …
        const math = btnByLabel("Inline Math");
        expect(math.previousElementSibling).toBe(btnByLabel("Inline Code"));
        expect(math.nextElementSibling).toBe(btnByLabel("Highlight"));
    });

    it("a substring selection should hide the format (turn-into) dropdown", async () => {
        // Arrange — select "hello" inside "hello world" (a substring, not the block)
        editor = await makeEditor("hello world\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(() => v, () => editor, vi.fn());
        v.dispatch(
            v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)),
        );

        // Act
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        // Assert — bar shows (marks are relevant) but the format dropdown is hidden
        expect(selToolbar().style.display).toBe("flex");
        const fmtWrap = selToolbar().querySelector<HTMLElement>(".sel-tb-fmt-wrap");
        expect(fmtWrap!.style.display).toBe("none");
    });

    it("a whole-block selection should show the format (turn-into) dropdown", async () => {
        // Arrange — select the entire block text "hello world"
        editor = await makeEditor("hello world\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(() => v, () => editor, vi.fn());
        v.dispatch(
            v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 12)),
        );

        // Act
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        // Assert
        const fmtWrap = selToolbar().querySelector<HTMLElement>(".sel-tb-fmt-wrap");
        expect(fmtWrap!.style.display).not.toBe("none");
    });

    it("a bold selection should light the Bold button active (matching the top toolbar)", async () => {
        // Arrange — "bold" carries a strong mark; select exactly it
        editor = await makeEditor("**bold** plain\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(() => v, () => editor, vi.fn());
        v.dispatch(
            v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 5)),
        );

        // Act
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        // Assert — Bold lit, Italic not
        expect(btnByLabel("Bold").classList.contains("sel-tb-btn--active")).toBe(true);
        expect(btnByLabel("Italic").classList.contains("sel-tb-btn--active")).toBe(false);
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

describe("selection toolbar per-item visibility", () => {
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

    it("a text selection with link hidden by config should not show the link button", async () => {
        // Arrange — link opted out via the per-item config
        editor = await makeEditor("hello world\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(
            () => v,
            () => editor,
            vi.fn(),
            { link: false },
        );
        v.dispatch(
            v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)),
        );

        // Act
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        // Assert — bar shown, but the link button is hidden while bold stays
        expect(selToolbar().style.display).toBe("flex");
        expect(linkButton().style.display).toBe("none");
        const boldBtn = selToolbar().querySelector<HTMLButtonElement>(
            ":scope > .sel-tb-btn",
        );
        expect(boldBtn!.style.display).not.toBe("none");
    });

    it("with all items on a text selection should show the link button", async () => {
        // Arrange — default config (undefined) means every item is visible
        editor = await makeEditor("hello world\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(
            () => v,
            () => editor,
            vi.fn(),
        );
        v.dispatch(
            v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)),
        );

        // Act
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        // Assert
        expect(linkButton().style.display).not.toBe("none");
    });

    it("a text selection with every inline item hidden should not show an empty bar", async () => {
        // Arrange — opt every inline item out; the bar would otherwise be empty
        editor = await makeEditor("hello world\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(() => v, () => editor, vi.fn(), {
            format: false,
            bold: false,
            italic: false,
            strikethrough: false,
            inlineCode: false,
            highlight: false,
            link: false,
            sectionLink: false,
            clearFormatting: false,
            math: false,
        });
        v.dispatch(
            v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)),
        );

        // Act
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        // Assert — the bar stays hidden rather than flashing empty
        expect(selToolbar().style.display).toBe("none");
    });
});

describe("selection toolbar block-range mode", () => {
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

    /** Select whole top-level blocks [fromBlock, toBlock] as a BlockRangeSelection. */
    function selectBlocks(v: EditorView, anchor: number, head: number): void {
        const range = BlockRangeSelection.tryCreate(v.state.doc, anchor, head);
        expect(range, "block range").toBeTruthy();
        v.dispatch(v.state.tr.setSelection(range!));
    }

    function dangerButton(): HTMLButtonElement {
        const btn = selToolbar().querySelector<HTMLButtonElement>(
            ".sel-tb-danger-btn",
        );
        expect(btn, "block delete button").not.toBeNull();
        return btn!;
    }

    function blockMenuBtn(): HTMLButtonElement {
        const btn = selToolbar().querySelector<HTMLButtonElement>(
            '.sel-tb-btn[aria-label^="Block menu"]',
        );
        expect(btn, "block menu button").not.toBeNull();
        return btn!;
    }

    it("the block-menu button shows the selected block's symbol — H1 for a heading", async () => {
        // Arrange — a heading followed by a paragraph; select the heading block
        editor = await makeEditor("# Title\n\nbody\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(() => v, () => editor, vi.fn());
        selectBlocks(v, 0, 1); // snaps to the first whole block (the heading)

        // Act
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        // Assert — the menu button reads "H1" (the gutter's heading badge), not
        // a generic grip
        expect(blockMenuBtn().querySelector(".sel-tb-block-badge")?.textContent).toBe("H1");
    });

    it("the block-menu button shows an icon (not a text badge) for a paragraph", async () => {
        // Arrange
        editor = await makeEditor("one\n\ntwo\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(() => v, () => editor, vi.fn());
        selectBlocks(v, 0, 1);

        // Act
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        // Assert — a paragraph badges as its gutter icon (the pilcrow SVG)
        const btn = blockMenuBtn();
        expect(btn.querySelector("svg"), "paragraph icon").not.toBeNull();
        expect(btn.querySelector(".sel-tb-block-badge"), "no text badge").toBeNull();
    });

    /** innerHTML-normalized icon markup (the DOM serializes self-closing
     *  SVG tags to open/close pairs, so raw icon strings never match). */
    function renderedIcon(icon: string): string {
        const el = document.createElement("div");
        el.innerHTML = icon;
        return el.innerHTML;
    }

    it("the block-menu button shows the LIST flavor icon for a selected list", async () => {
        // Arrange — a bullet list with a nested sublist; select the whole list
        editor = await makeEditor("- one\n- two\n  - nested\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(() => v, () => editor, vi.fn());
        selectBlocks(v, 0, 1);

        // Act
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        // Assert — the button reads as the list's own gutter symbol (the
        // bullet-list icon), not the generic grip.
        const { IconList } = await import("../ui/icons");
        expect(blockMenuBtn().innerHTML).toBe(renderedIcon(IconList));
    });

    it("the block-menu button shows the ordered icon for an ordered list", async () => {
        editor = await makeEditor("1. one\n2. two\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(() => v, () => editor, vi.fn());
        selectBlocks(v, 0, 1);

        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        const { IconListOrdered } = await import("../ui/icons");
        expect(blockMenuBtn().innerHTML).toBe(renderedIcon(IconListOrdered));
    });

    it("the block-menu button shows the task icon for a task list", async () => {
        editor = await makeEditor("- [ ] a\n- [x] b\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(() => v, () => editor, vi.fn());
        selectBlocks(v, 0, 1);

        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        const { IconCheckSquare } = await import("../ui/icons");
        expect(blockMenuBtn().innerHTML).toBe(renderedIcon(IconCheckSquare));
    });

    it("a uniform multi-block run shows the shared symbol; a mixed run the grip", async () => {
        // Arrange — two paragraphs then a list: [p, p] is uniform (pilcrow),
        // [p, list] is mixed (grip).
        editor = await makeEditor("one\n\ntwo\n\n- item\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(() => v, () => editor, vi.fn());
        const p1 = v.state.doc.child(0).nodeSize;
        const p2 = v.state.doc.child(1).nodeSize;

        // Uniform: both paragraphs.
        selectBlocks(v, 0, p1 + 1);
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);
        const { IconPilcrow, IconGripVertical } = await import("../ui/icons");
        expect(blockMenuBtn().innerHTML).toBe(renderedIcon(IconPilcrow));

        // Mixed: second paragraph + the list.
        selectBlocks(v, p1, p1 + p2 + 1);
        selTb.onSelectionChange(v);
        expect(blockMenuBtn().innerHTML).toBe(renderedIcon(IconGripVertical));
    });

    it("an ITEM-level range inside a list shows the item flavor icon", async () => {
        // Arrange — select two list ITEMS (a nested block range, not the
        // whole list): the symbol walk runs over the item siblings.
        editor = await makeEditor("- one\n- two\n- three\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(() => v, () => editor, vi.fn());
        // Items start at pos 1 (inside the list); select the first two.
        const firstItem = v.state.doc.child(0).child(0);
        selectBlocks(v, 1, 1 + firstItem.nodeSize + 1);

        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        const { IconList } = await import("../ui/icons");
        expect(blockMenuBtn().innerHTML).toBe(renderedIcon(IconList));
    });

    it("a whole-block selection should lead with the Block menu (grab) button, before Move Up", async () => {
        // Arrange — three paragraphs, select the first two as whole blocks
        editor = await makeEditor("one\n\ntwo\n\nthree\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(() => v, () => editor, vi.fn());
        selectBlocks(v, 0, v.state.doc.child(0).nodeSize + 1);

        // Act
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        // Assert — the grab-menu button is shown, and it precedes Move Up (the
        // whole gutter menu is reachable from the block palette itself)
        const menuBtn = selToolbar().querySelector<HTMLButtonElement>(
            '.sel-tb-btn[aria-label^="Block menu"]',
        );
        expect(menuBtn, "block menu button").not.toBeNull();
        expect(menuBtn!.style.display).not.toBe("none");
        const moveUp = selToolbar().querySelector<HTMLButtonElement>(
            '.sel-tb-btn[aria-label^="Move Up"]',
        );
        expect(
            Boolean(
                menuBtn!.compareDocumentPosition(moveUp!) &
                    Node.DOCUMENT_POSITION_FOLLOWING,
            ),
            "Block menu precedes Move Up",
        ).toBe(true);
    });

    it("a whole-block selection should show block ops and hide the inline buttons", async () => {
        // Arrange — three paragraphs, select the first two as whole blocks
        editor = await makeEditor("one\n\ntwo\n\nthree\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(
            () => v,
            () => editor,
            vi.fn(),
        );
        // Anchor at doc start, head inside the second block → snaps to two blocks
        selectBlocks(v, 0, v.state.doc.child(0).nodeSize + 1);

        // Act
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        // Assert — bar shown in block mode: delete (danger) visible, link hidden
        expect(selToolbar().style.display).toBe("flex");
        expect(dangerButton().style.display).not.toBe("none");
        expect(linkButton().style.display).toBe("none");
    });

    it("clicking the block delete button should remove the selected blocks in one step", async () => {
        // Arrange — three paragraphs, select the first two
        editor = await makeEditor("one\n\ntwo\n\nthree\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(
            () => v,
            () => editor,
            vi.fn(),
        );
        const before = v.state.doc.childCount;
        selectBlocks(v, 0, v.state.doc.child(0).nodeSize + 1);
        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        // Act — click Delete
        mousedown(dangerButton());

        // Assert — two blocks gone (only "three" remains)
        expect(v.state.doc.childCount).toBeLessThan(before);
        expect(md(editor)).toBe("three");
    });
});
