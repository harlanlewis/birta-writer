/**
 * webview/components/contextMenu.ts
 *
 * Wires the right-click `webview/context` menu (MAR-9). VS Code decides which
 * contributed menu items to show by reading a `data-vscode-context` JSON
 * attribute off the DOM element under the cursor, merging the objects it finds
 * walking up to the document root (a child's keys win).
 *
 * We stamp:
 *   - the editor root ONCE, declaring the default "editor" section, keeping the
 *     native cut/copy/paste items (`preventDefaultContextMenuItems: false`), and
 *     carrying `documentUri` so the extension can route the command even if the
 *     active-panel bookkeeping ever lags;
 *   - the closest table cell or link ON DEMAND, in a capture-phase contextmenu
 *     listener that runs before VS Code's own bubble-phase handler. This avoids
 *     permanently attributing ProseMirror's frequently re-rendered nodes while
 *     still surfacing the table/link menu sections for the element clicked.
 */

interface ContextObject {
    webviewSection: "editor" | "table" | "link";
    preventDefaultContextMenuItems?: boolean;
    documentUri?: string;
}

function stamp(el: HTMLElement, ctx: ContextObject): void {
    el.dataset["vscodeContext"] = JSON.stringify(ctx);
}

/** Attaches context-menu routing to the editor root element. */
export function initContextMenu(root: HTMLElement): void {
    const documentUri = window.__i18n?.documentUri;
    // The root default: keep native clipboard items and expose the editor
    // section (copy-as-HTML / copy-as-Markdown).
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
                stamp(cell, { webviewSection: "table" });
            }
            const link = target.closest("a");
            if (link instanceof HTMLElement) {
                stamp(link, { webviewSection: "link" });
            }
        },
        true,
    );
}
