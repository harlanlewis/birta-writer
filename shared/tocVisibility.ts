/**
 * Table-of-contents show/hide preference (`birta.tocVisibility`) — shared between
 * the extension host (reads/writes the setting) and the webview (applies it).
 *
 * This is ORTHOGONAL to the docked↔overlay responsive mode, which is driven by
 * window width (does the window fit the drawer plus a content column?). Visibility
 * is about whether the panel is open at all:
 *
 * - `auto`   — the default: decide shown/hidden by the document's heading count,
 *              opening only when it exceeds `birta.tocAutoHideThreshold`. Keeps a
 *              short note uncluttered while auto-opening a long document.
 * - `shown`  — always start shown.
 * - `hidden` — always start hidden.
 *
 * Toggling the panel writes `shown`/`hidden`; `auto` is the default until then
 * (or set explicitly in settings).
 */
export type TocVisibility = "auto" | "shown" | "hidden";

/** The valid values, in Settings-UI order. Kept in sync with the package.json enum. */
export const TOC_VISIBILITY_VALUES = ["auto", "shown", "hidden"] as const;

export const DEFAULT_TOC_VISIBILITY: TocVisibility = "auto";

/** Coerce an arbitrary setting value to a known visibility, defaulting to `auto`
 *  (so a hand-edited settings.json with a typo can't hide the panel). */
export function normalizeTocVisibility(value: unknown): TocVisibility {
    return value === "shown" || value === "hidden" ? value : DEFAULT_TOC_VISIBILITY;
}
