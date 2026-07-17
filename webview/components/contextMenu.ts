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
 *
 * Every right-click inside the editor also stamps `blockTarget: { blockPos }`
 * (the document position under the pointer) on the root, so commands that fall
 * back to "the block under the cursor" — copy-as with an empty selection —
 * survive the same round-trip.
 *
 * The toolbar is chrome, not content: it gets its own section with the default
 * clipboard items suppressed, showing only the contributed toolbar actions
 * (mirroring the settings-gear dropdown). Text inputs inside it are re-stamped
 * to an uncontributed section so they keep native Cut/Copy/Paste only.
 */

import type { EditorView } from "../pm";
import type { WebviewSection } from "../../shared/editorCommands";

interface ContextObject {
    /** "none" is deliberately uncontributed: only native default items show. */
    webviewSection: WebviewSection | "none";
    preventDefaultContextMenuItems?: boolean;
    documentUri?: string;
    tableTarget?: { cellPos: number };
    blockTarget?: { blockPos: number };
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

/** The document position under the pointer, or undefined if not resolvable. */
export function blockTargetFor(view: EditorView, e: MouseEvent): { blockPos: number } | undefined {
    try {
        const coords = view.posAtCoords({ left: e.clientX, top: e.clientY });
        return coords ? { blockPos: coords.pos } : undefined;
    } catch {
        return undefined;
    }
}

/** Attaches context-menu routing to the editor root element and the toolbar. */
export function initContextMenu(
    root: HTMLElement,
    getView: () => EditorView | null,
    toolbar?: HTMLElement | null,
): void {
    const documentUri = window.__i18n?.documentUri;
    const uriPart = documentUri ? { documentUri } : {};
    const stampRoot = (blockTarget?: { blockPos: number }): void => {
        // Root default: keep native clipboard items and expose the editor
        // section (copy-as / edit-raw-markdown).
        stamp(root, {
            webviewSection: "editor",
            preventDefaultContextMenuItems: false,
            ...uriPart,
            ...(blockTarget ? { blockTarget } : {}),
        });
    };
    stampRoot();

    if (toolbar) {
        // Chrome, not content: suppress the default clipboard items so only the
        // contributed toolbar actions show.
        stamp(toolbar, {
            webviewSection: "toolbar",
            preventDefaultContextMenuItems: true,
            ...uriPart,
        });
    }

    document.addEventListener(
        "contextmenu",
        (e) => {
            const target = e.target as HTMLElement | null;
            if (!target) { return; }
            // Text inputs inside the toolbar keep the native clipboard items
            // (and nothing else) — the toolbar stamp would otherwise suppress
            // them and offer chrome actions instead.
            const field = target.closest("input, textarea");
            if (field instanceof HTMLElement && toolbar?.contains(field)) {
                stamp(field, { webviewSection: "none", preventDefaultContextMenuItems: false });
                return;
            }
            if (root.contains(target)) {
                const view = getView();
                stampRoot(view ? blockTargetFor(view, e) : undefined);
                const cell = target.closest("td, th");
                if (cell instanceof HTMLElement && view) {
                    const tableTarget = cellTargetFor(view, cell);
                    stamp(cell, {
                        webviewSection: "table",
                        ...(tableTarget ? { tableTarget } : {}),
                    });
                }
                const link = target.closest("a");
                if (link instanceof HTMLElement) {
                    stamp(link, { webviewSection: "link" });
                }
            }
        },
        true,
    );
}
