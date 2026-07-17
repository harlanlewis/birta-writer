/**
 * contextMenu.ts tests: the `data-vscode-context` stamps that drive VS Code's
 * native webview/context menu. Verifies:
 *   - the editor root keeps native clipboard items and exposes the editor
 *     section (with the document uri for command routing);
 *   - the toolbar is stamped as chrome (default items suppressed);
 *   - right-clicking content stamps a blockTarget position on the root, and a
 *     table cell additionally stamps a tableTarget;
 *   - text inputs inside the toolbar fall back to native clipboard items only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { EditorView } from "../pm";
import { initContextMenu } from "../components/contextMenu";

const DOC_URI = "file:///project/doc.md";

function ctxOf(el: HTMLElement): Record<string, unknown> {
    const raw = el.dataset["vscodeContext"];
    expect(raw, "element should carry a data-vscode-context stamp").toBeDefined();
    return JSON.parse(raw!) as Record<string, unknown>;
}

function rightClick(el: HTMLElement): void {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
}

describe("initContextMenu stamping", () => {
    let root: HTMLElement;
    let toolbar: HTMLElement;
    let view: EditorView;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        window.__i18n = { translations: {}, isMac: false, documentUri: DOC_URI };
        root = document.createElement("div");
        toolbar = document.createElement("div");
        document.body.append(toolbar, root);
        view = {
            posAtDOM: vi.fn(() => 7),
            posAtCoords: vi.fn(() => ({ pos: 3, inside: 2 })),
        } as unknown as EditorView;
        initContextMenu(root, () => view, toolbar);
    });

    it("the editor root should expose the editor section with native items kept", () => {
        expect(ctxOf(root)).toEqual({
            webviewSection: "editor",
            preventDefaultContextMenuItems: false,
            documentUri: DOC_URI,
        });
    });

    it("the toolbar should be stamped as chrome with default items suppressed", () => {
        expect(ctxOf(toolbar)).toEqual({
            webviewSection: "toolbar",
            preventDefaultContextMenuItems: true,
            documentUri: DOC_URI,
        });
    });

    it("right-clicking content should stamp the pointer position as a blockTarget", () => {
        const p = document.createElement("p");
        root.appendChild(p);
        rightClick(p);
        expect(ctxOf(root)["blockTarget"]).toEqual({ blockPos: 3 });
    });

    it("right-clicking a table cell should stamp the table section and cell target", () => {
        const cell = document.createElement("td");
        root.appendChild(cell);
        rightClick(cell);
        expect(ctxOf(cell)).toEqual({
            webviewSection: "table",
            tableTarget: { cellPos: 7 },
        });
        // The root stamp (merged in by VS Code) still supplies the blockTarget.
        expect(ctxOf(root)["blockTarget"]).toEqual({ blockPos: 3 });
    });

    it("right-clicking a link should stamp the link section", () => {
        const link = document.createElement("a");
        root.appendChild(link);
        rightClick(link);
        expect(ctxOf(link)).toEqual({ webviewSection: "link" });
    });

    it("a text input inside the toolbar should keep only native clipboard items", () => {
        const input = document.createElement("input");
        toolbar.appendChild(input);
        rightClick(input);
        expect(ctxOf(input)).toEqual({
            webviewSection: "none",
            preventDefaultContextMenuItems: false,
        });
    });

    it("an unresolvable pointer position should leave the root without a blockTarget", () => {
        (view.posAtCoords as ReturnType<typeof vi.fn>).mockReturnValue(null);
        const p = document.createElement("p");
        root.appendChild(p);
        rightClick(p);
        expect(ctxOf(root)["blockTarget"]).toBeUndefined();
    });
});
