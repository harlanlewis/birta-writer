/**
 * ui/outsideClick.ts — shared outside-click dismissal.
 *
 * The document-level "mousedown outside my surface closes it" pattern, so
 * each transient surface (block menu, language picker, path completions,
 * proofread popup …) stops hand-rolling the same capture-phase listener.
 * The counterpart to `ui/escapeLayers` (keyboard dismissal): this module
 * covers the pointer path only — Escape routing, blur, and scroll dismissal
 * stay with the surface.
 *
 * Semantics preserved from the hand-rolled originals:
 * - Listens on `document` in the CAPTURE phase by default, so a surface that
 *   stops propagation of its own inner mousedowns still can't swallow an
 *   outside click. Pass `capture: false` for the (rare) bubble-phase surface.
 * - Fires for every mouse button (right-click included) — no button filter,
 *   matching every migrated site. Touch dismisses via the compatibility
 *   `mousedown` the browser synthesizes; no site listened for `touchstart`.
 * - "Inside" elements may be recreated while the listener is attached
 *   (per-render dropdowns), so pass a getter to re-resolve them per event;
 *   null/undefined entries are skipped.
 */

type InsideEls = ReadonlyArray<Node | null | undefined>;

/**
 * Call `dismiss` on any document mousedown whose target is outside every
 * `inside` element. Returns the detach function; call it from every close
 * path (it is safe to call more than once).
 */
export function onOutsideClick(
    inside: InsideEls | (() => InsideEls),
    dismiss: (e: MouseEvent) => void,
    opts: { capture?: boolean } = {},
): () => void {
    const capture = opts.capture ?? true;
    const handler = (e: MouseEvent): void => {
        const target = e.target as Node;
        const els = typeof inside === "function" ? inside() : inside;
        for (const el of els) {
            if (el?.contains(target)) { return; }
        }
        dismiss(e);
    };
    document.addEventListener("mousedown", handler, capture);
    return () => document.removeEventListener("mousedown", handler, capture);
}
