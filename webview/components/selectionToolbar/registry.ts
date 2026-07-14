/**
 * webview/components/selectionToolbar/registry.ts
 *
 * Pure metadata + visibility resolution for the floating selection toolbar's
 * inline (text-mode) buttons. DOM-free and unit-tested, mirroring
 * `toolbar/registry.ts`; the button factories themselves live in `index.ts`.
 *
 * Unlike the top toolbar (zones + order + overflow), the floating bar only
 * needs per-item show/hide: each inline item has its own
 * `birta.floatingToolbar.items.<id>` boolean, default true. Table-mode and
 * block-mode buttons are contextual (driven by the selection type, not by the
 * user), so they are intentionally absent from this registry.
 */

/**
 * Every user-gated inline item id, in canonical render order. Kept in lockstep
 * with the package.json `birta.floatingToolbar.items.*` defaults by
 * shared/__tests__/floatingToolbarDefaultsContributions.test.ts.
 */
export const FLOATING_TOOLBAR_ITEM_IDS = [
    "format",
    "bold",
    "italic",
    "strikethrough",
    "inlineCode",
    "highlight",
    "link",
    "clearFormatting",
    "math",
] as const;

export type FloatingToolbarItemId = (typeof FLOATING_TOOLBAR_ITEM_IDS)[number];

/** Per-item visibility map (birta.floatingToolbar.items.*); default true. */
export type FloatingToolbarItems = Partial<Record<FloatingToolbarItemId, boolean>>;

/**
 * The set of inline items to show, from a (possibly partial or malformed)
 * config. An item is visible unless its flag is exactly `false`, so a newly
 * registered item is shown until a user opts it out — the same "default on"
 * contract the package.json defaults declare.
 */
export function resolveVisible(
    items: FloatingToolbarItems | undefined,
): Set<FloatingToolbarItemId> {
    const visible = new Set<FloatingToolbarItemId>();
    for (const id of FLOATING_TOOLBAR_ITEM_IDS) {
        if (items?.[id] !== false) {
            visible.add(id);
        }
    }
    return visible;
}
