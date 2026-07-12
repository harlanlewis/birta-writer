/**
 * ui/escapeLayers.ts — the Escape layering rule.
 *
 * One Escape closes the TOPMOST open transient surface (the most recently
 * opened one) and nothing else; only when no surface is open does the
 * editor's own Escape grammar engage (caret → block selection → collapse,
 * plugins/blockKeys.ts). Docked panels (TOC, frontmatter) are not layers —
 * they never register here.
 *
 * Surfaces that already claim Escape BEFORE ProseMirror sees it (slash menu
 * and the caret-suggest completions: capture phase on view.dom) don't need
 * the registry to win — they are only ever open while the editor is focused
 * and typing, so being open implies being topmost. The registry exists for
 * surfaces that stay open while the EDITOR owns focus and key routing (find
 * bar, pinned link popup, hover menus, lightboxes): their Escape used to
 * lose to the block-selection keymap.
 *
 * Deliberately dumb: a pure open-order stack — no z-index math, no DOM
 * inspection. Every close path of a registered surface must call the
 * returned unregister (it is idempotent), or a dead entry would swallow one
 * Escape later.
 */

/** One open surface. Object identity distinguishes duplicate close fns. */
interface EscapeLayer {
    close: () => void;
}

const stack: EscapeLayer[] = [];

/**
 * Push an open surface onto the layer stack. Returns an idempotent
 * unregister — call it from EVERY close path (Escape, outside click,
 * action picked, blur, programmatic close).
 */
export function registerEscapeLayer(close: () => void): () => void {
    const layer: EscapeLayer = { close };
    stack.push(layer);
    return () => {
        const i = stack.indexOf(layer);
        if (i >= 0) {
            stack.splice(i, 1);
        }
    };
}

/**
 * Close the most recently opened surface. Returns true when one was closed
 * (the caller consumes the Escape), false when the stack is empty (the
 * editor's own Escape grammar may run). The entry is popped BEFORE its
 * close() runs, so the close path calling its own unregister — which every
 * close path does — is a no-op rather than a reentrant splice.
 */
export function closeTopmostLayer(): boolean {
    const layer = stack.pop();
    if (!layer) {
        return false;
    }
    layer.close();
    return true;
}
