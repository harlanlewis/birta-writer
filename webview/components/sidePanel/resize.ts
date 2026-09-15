/**
 * Drag-to-resize handle on the panel's inner edge (VS Code sash style).
 *
 * Width is applied per pointer move and COMMITTED once, on mouseup, and only
 * when it changed: the commit is what the composer persists (a setting write
 * per move would be a write per pixel). Double-click resets to the default and
 * commits that. The docked/overlay decision is re-evaluated after either,
 * never per move, because a viewport that flips mode mid-drag would yank the
 * panel out from under the pointer.
 *
 * The cursor and the selection guard for the drag's life live on the
 * interaction shield: written on the body, either one is inherited by every
 * element and restyles the whole document on the way in and out
 * (ui/interactionShield.ts). The `${prefix}-resizing` body class stays for the
 * reveal tab's transition suppression, which is narrow.
 */
import { hideInteractionShield, showInteractionShield } from "@/ui/interactionShield";

export interface ResizeHandleOptions {
    panel: HTMLElement;
    prefix: string;
    /** `col-resize` on macOS, `ew-resize` elsewhere; the composer's platform read. */
    cursor: string;
    isRight: () => boolean;
    width: () => number;
    defaultWidth: number;
    /** Clamp, write the width variable and re-commit what depends on it. */
    applyWidth: (width: number) => void;
    /** Body `${prefix}-resizing` and the tab's transition suppression, together. */
    setResizing: (on: boolean) => void;
    /** The reveal tab, flushed so a reset snaps with the panel. */
    tabEl: HTMLElement;
    /** The width the user settled on: persisted by the composer. */
    onCommit: (width: number) => void;
    /** Runs after every commit: the docked/overlay re-evaluation. */
    afterCommit: () => void;
}

export function wireResizeHandle(opts: ResizeHandleOptions): HTMLElement {
    const handle = document.createElement("div");
    handle.className = `side-panel-resize-handle ${opts.prefix}-resize-handle`;
    handle.style.cursor = opts.cursor;
    opts.panel.appendChild(handle);

    const setActive = (on: boolean): void => {
        handle.classList.toggle("side-panel-resize-handle--active", on);
        handle.classList.toggle(`${opts.prefix}-resize-handle--active`, on);
    };

    handle.addEventListener("mousedown", (e) => {
        if (e.button !== 0) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startWidth = opts.width();
        setActive(true);
        opts.setResizing(true);
        showInteractionShield("resize", { cursor: opts.cursor });
        const onMove = (ev: MouseEvent): void => {
            const delta = opts.isRight() ? startX - ev.clientX : ev.clientX - startX;
            opts.applyWidth(startWidth + delta);
        };
        const onUp = (): void => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            setActive(false);
            opts.setResizing(false);
            hideInteractionShield();
            const width = opts.width();
            if (width !== startWidth) {
                opts.onCommit(width);
            }
            opts.afterCommit();
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });

    // Double-click resets to the default width.
    handle.addEventListener("dblclick", () => {
        // Suppress the tab's slide transition so it snaps with the panel; the
        // forced style flush commits the new position while the suppression is
        // still active.
        opts.setResizing(true);
        opts.applyWidth(opts.defaultWidth);
        void opts.tabEl.offsetWidth;
        opts.setResizing(false);
        opts.onCommit(opts.defaultWidth);
        opts.afterCommit();
    });

    return handle;
}
