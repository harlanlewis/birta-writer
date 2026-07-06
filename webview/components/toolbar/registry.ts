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
    "bold",
    "italic",
    "strikethrough",
    "inlineCode",
    "link",
    "bulletList",
    "orderedList",
    "taskList",
    "codeBlock",
    "blockquote",
    "horizontalRule",
    "table",
    "image",
    "math",
    "footnote",
    "clearFormatting",
    "viewSource",
    "find",
    "styleCheck",
    "fontPreset",
    "settings",
] as const;

export type ToolbarItemId = (typeof TOOLBAR_ITEM_IDS)[number];

/**
 * Default placement for each item when the user has not overridden it.
 * The shipped layout: every editing control in the left zone (in
 * TOOLBAR_ITEM_IDS order), utilities on the right, center empty, and
 * footnote opt-in. Kept in lockstep with the package.json setting defaults
 * by shared/__tests__/toolbarDefaultsContributions.test.ts.
 */
export const DEFAULT_PLACEMENTS: Record<ToolbarItemId, ToolbarPlacement> = {
    format: "left",
    bold: "left",
    italic: "left",
    strikethrough: "left",
    inlineCode: "left",
    link: "left",
    bulletList: "left",
    orderedList: "left",
    taskList: "left",
    codeBlock: "left",
    blockquote: "left",
    horizontalRule: "left",
    table: "left",
    image: "left",
    math: "left",
    footnote: "hidden",
    clearFormatting: "left",
    viewSource: "right",
    find: "right",
    styleCheck: "right",
    fontPreset: "right",
    settings: "right",
};

// "center" is intentionally NOT valid: the zone was removed, and persisted
// "center" placements from older builds fall back to the item's default.
function isValidPlacement(value: unknown): value is ToolbarPlacement {
    return value === "left" || value === "right" || value === "hidden";
}

const ZONES: ToolbarZone[] = ["left", "right"];

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
