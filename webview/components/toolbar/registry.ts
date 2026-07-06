/**
 * webview/components/toolbar/registry.ts
 *
 * Pure metadata + layout resolution for the main toolbar. The item factories
 * themselves live in `index.ts` (they close over the editor handle and other
 * runtime dependencies); this module is DOM-free and unit-tested.
 */
import type { ToolbarConfig, ToolbarPlacement, ToolbarZone } from "../../../shared/messages";

/**
 * Every toolbar item id, in canonical order. Items render in this order within
 * their zone. `debug` is intentionally absent: it is a dev-only dropdown gated
 * by debugMode, not a user-placeable item.
 */
export const TOOLBAR_ITEM_IDS = [
    "format",
    "clearFormatting",
    "fontPreset",
    "bold",
    "italic",
    "strikethrough",
    "inlineCode",
    "link",
    "image",
    "table",
    "footnote",
    "math",
    "bulletList",
    "orderedList",
    "taskList",
    "blockquote",
    "codeBlock",
    "horizontalRule",
    "viewSource",
    "styleCheck",
    "find",
    "settings",
] as const;

export type ToolbarItemId = (typeof TOOLBAR_ITEM_IDS)[number];

/** Default placement for each item when the user has not overridden it. */
export const DEFAULT_PLACEMENTS: Record<ToolbarItemId, ToolbarPlacement> = {
    format: "center",
    clearFormatting: "center",
    fontPreset: "center",
    bold: "hidden",
    italic: "hidden",
    strikethrough: "hidden",
    inlineCode: "hidden",
    link: "center",
    image: "center",
    table: "center",
    footnote: "hidden",
    math: "hidden",
    bulletList: "hidden",
    orderedList: "hidden",
    taskList: "hidden",
    blockquote: "hidden",
    codeBlock: "hidden",
    horizontalRule: "hidden",
    viewSource: "right",
    styleCheck: "right",
    find: "right",
    settings: "right",
};

function isValidPlacement(value: unknown): value is ToolbarPlacement {
    return value === "left" || value === "center" || value === "right" || value === "hidden";
}

const ZONES: ToolbarZone[] = ["left", "center", "right"];

/**
 * Resolve per-zone ordered item id lists from a (possibly partial or malformed)
 * config. Unknown ids and invalid placement values fall back to the item's
 * default; hidden items are omitted.
 *
 * Within a zone, items listed in `config.order` come first, in that order; the
 * rest follow in the built-in (registry) order. This lets a user reorder a zone
 * (e.g. move Clear Formatting to the end of the left set) via settings without
 * drag-and-drop.
 */
export function computeZones(
    config: ToolbarConfig | undefined,
): Record<ToolbarZone | "hidden", ToolbarItemId[]> {
    const placements = config?.placements;
    const order = Array.isArray(config?.order) ? config!.order : [];

    const result: Record<ToolbarZone | "hidden", ToolbarItemId[]> = {
        left: [],
        center: [],
        right: [],
        hidden: [],
    };
    for (const id of TOOLBAR_ITEM_IDS) {
        const raw = placements?.[id];
        const placement = isValidPlacement(raw) ? raw : DEFAULT_PLACEMENTS[id];
        result[placement].push(id);
    }

    // Rank: items named in `order` sort first (by their position there); the
    // rest keep canonical registry order (Infinity → after all listed items).
    const rankOf = (id: ToolbarItemId): number => {
        const i = order.indexOf(id);
        return i === -1 ? Number.POSITIVE_INFINITY : i;
    };
    for (const zone of [...ZONES, "hidden"] as (ToolbarZone | "hidden")[]) {
        result[zone].sort((a, b) => {
            const ra = rankOf(a);
            const rb = rankOf(b);
            if (ra !== rb) {
                return ra - rb;
            }
            return TOOLBAR_ITEM_IDS.indexOf(a) - TOOLBAR_ITEM_IDS.indexOf(b);
        });
    }
    return result;
}
