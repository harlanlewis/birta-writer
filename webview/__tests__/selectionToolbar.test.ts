/**
 * Selection toolbar link button tests: the floating selection toolbar renders
 * a link button after the inline-code button, its mousedown invokes the
 * openLinkPrompt callback (the same prompt behind the main toolbar button and
 * Cmd/Ctrl+K) without destroying the editor selection, and the button is
 * hidden in table cell-selection mode.
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
import { TextSelection } from "@milkdown/prose/state";
import { CellSelection } from "@milkdown/prose/tables";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, pureCommonmark } from "../serialization";
import {
    setupSelectionToolbar,
    setPendingToolbarPos,
} from "../components/selectionToolbar";

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfm)
        .create();
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
            () => [],
            () => "",
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
            () => [],
            () => "",
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
            () => [],
            () => "",
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

    it("with a table cell selection the button should be hidden while bold stays visible", async () => {
        // Arrange — real editor with a GFM table, select two header cells
        editor = await makeEditor("| a | b |\n| --- | --- |\n| c | d |\n");
        const v = view(editor);
        const selTb = setupSelectionToolbar(
            () => v,
            () => editor,
            () => [],
            () => "",
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
