/**
 * webview/components/contextMenu.ts
 *
 * Wires the right-click `webview/context` menu. VS Code decides which contributed
 * menu items to show by reading a `data-vscode-context` JSON attribute off the
 * DOM element under the cursor, merging the objects it finds walking up to the
 * document root (a child's keys win), and passes that object to the invoked
 * command.
 *
 * For a table cell we stamp `tableTarget: { cellPos }` — the ProseMirror
 * document position inside the clicked cell. The command carries it back to the
 * webview and operates on that exact cell, because the ProseMirror selection is
 * NOT reliably preserved across VS Code's native context-menu round-trip.
 * (That's why the older "set the selection on right-click" approach produced
 * no-ops and popped the floating toolbar; passing the target avoids both.)
 */

import type { EditorView } from "@milkdown/prose/view";

interface ContextObject {
    webviewSection: "editor" | "table" | "link";
    preventDefaultContextMenuItems?: boolean;
    documentUri?: string;
    tableTarget?: { cellPos: number };
}

function stamp(el: HTMLElement, ctx: ContextObject): void {
    el.dataset["vscodeContext"] = JSON.stringify(ctx);
}

/** The document position inside the clicked cell, or undefined if not resolvable. */
export function cellTargetFor(view: EditorView, cellEl: HTMLElement): { cellPos: number } | undefined {
    try {
        return { cellPos: view.posAtDOM(cellEl, 0) };
    } catch {
        return undefined;
    }
}

/** Attaches context-menu routing to the editor root element. */
export function initContextMenu(root: HTMLElement, getView: () => EditorView | null): void {
    const documentUri = window.__i18n?.documentUri;
    // Root default: keep native clipboard items and expose the editor section
    // (copy-as-HTML / copy-as-Markdown).
    stamp(root, {
        webviewSection: "editor",
        preventDefaultContextMenuItems: false,
        ...(documentUri ? { documentUri } : {}),
    });

    document.addEventListener(
        "contextmenu",
        (e) => {
            const target = e.target as HTMLElement | null;
            if (!target) { return; }
            const cell = target.closest("td, th");
            if (cell instanceof HTMLElement) {
                const view = getView();
                const tableTarget = view ? cellTargetFor(view, cell) : undefined;
                stamp(cell, {
                    webviewSection: "table",
                    ...(tableTarget ? { tableTarget } : {}),
                });
            }
            const link = target.closest("a");
            if (link instanceof HTMLElement) {
                stamp(link, { webviewSection: "link" });
            }
        },
        true,
    );
}
