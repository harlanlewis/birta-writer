/**
 * plugins/blockHandles.ts
 *
 * Late-bound handles for the block-chrome interactions the fold layer
 * renders but does not own: opening/closing the gutter block menu, arming a
 * marker for drag-to-reorder, and wiring marquee selection. The gutter
 * widgets and the fold plugin's view call through here at INTERACTION time;
 * the block menu component (components/blockMenu) registers the real
 * implementations when it loads.
 *
 * This is the inversion that broke the headingFold ⇄ blockMenu package
 * cycle (round-2 finding F1): the plugin layer used to import the component
 * functions directly. Same late-binding posture as setDocChangeListener and
 * setBlockMenuContext — a dependency-light module both sides can import
 * (the foldState.ts precedent), with the registration owned by the side
 * that has the implementation.
 *
 * Defaults are inert no-ops: a graph that never loads components/blockMenu
 * simply has no menu/drag/marquee behavior — the same as when that chrome
 * didn't exist. The production bundle always loads it (webview/index.ts
 * imports the facade), and so does every jsdom suite that exercises these
 * interactions (they import the facade, directly or via plugins/blockKeys).
 */
import type { EditorView } from "../pm";

export interface BlockHandles {
    /** Open the gutter block menu for the block at `blockPos`, anchored to
     * `anchor` (see components/blockMenu's openBlockMenu for the modes). */
    openBlockMenu(view: EditorView, blockPos: number, anchor: HTMLElement, viaKeyboard: boolean): void;
    /** Close the currently open block menu, if any. */
    closeBlockMenu(): void;
    /** Arm a gutter marker for drag-to-reorder (blockPos is resolved at
     * interaction time — never captured at build time). */
    wireMarkerDrag(view: EditorView, marker: HTMLElement, blockPos: () => number | null): void;
    /** Arm margin marquee selection on the view; returns the dispose fn. */
    wireMarquee(view: EditorView): () => void;
}

let handles: BlockHandles = {
    openBlockMenu: () => {},
    closeBlockMenu: () => {},
    wireMarkerDrag: () => {},
    wireMarquee: () => () => {},
};

/** Register the real implementations (called by components/blockMenu when
 * its facade loads; last registration wins). */
export function registerBlockHandles(next: BlockHandles): void {
    handles = next;
}

/** The current handles — resolve at CALL time, never capture the result. */
export function blockHandles(): BlockHandles {
    return handles;
}
