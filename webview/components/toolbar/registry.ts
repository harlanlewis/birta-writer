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
    "highlight",
    "inlineCode",
    "link",
    "listMenu",
    "quote",
    "codeBlock",
    "horizontalRule",
    "table",
    "image",
    "math",
    "footnote",
    "clearFormatting",
    "readOnly",
    "viewSource",
    "find",
    "styleCheck",
    "fontPreset",
    "settings",
] as const;

export type ToolbarItemId = (typeof TOOLBAR_ITEM_IDS)[number];

/**
 * Default placement for each item when the user has not overridden it.
 * The shipped layout: the common editing controls in the left zone (in
 * TOOLBAR_ITEM_IDS order), utilities on the right. Less-used inserts ship
 * hidden (opt-in), since each has an input-rule / slash / palette path:
 * strikethrough, highlight, inlineCode, horizontalRule,
 * math, footnote, clearFormatting. Kept in lockstep
 * with the package.json setting defaults by
 * shared/__tests__/toolbarDefaultsContributions.test.ts.
 */
export const DEFAULT_PLACEMENTS: Record<ToolbarItemId, ToolbarPlacement> = {
    format: "left",
    bold: "left",
    italic: "left",
    // Strikethrough ships hidden: the ~~…~~ input rule and Mod-Shift-x cover it.
    strikethrough: "hidden",
    // Highlight ships hidden (like footnote): opt-in via settings, the
    // ==…== input rule and command palette are always available.
    highlight: "hidden",
    // Inline code ships hidden: the `` `…` `` input rule and Mod-e cover it.
    inlineCode: "hidden",
    link: "left",
    // Lists: one dropdown (bullet / ordered / task), mirroring the format
    // (P + headings) picker. Each list type is still reachable by its input
    // rule (`- `, `1. `, `- [ ] `), the slash menu, and the command palette.
    listMenu: "left",
    codeBlock: "left",
    // Quote: one dropdown holding a plain blockquote (top) + the five callout
    // types. Ships visible where the standalone Blockquote button used to;
    // callouts (previously a hidden dropdown) now ride along on the visible bar.
    quote: "left",
    // Horizontal rule ships hidden: the `---` input rule covers it.
    horizontalRule: "hidden",
    table: "left",
    image: "left",
    // Inline math ships hidden: the `$…$` input rule and slash menu cover it
    // (block math is a LaTeX code block, reached via the code-block language switcher).
    math: "hidden",
    footnote: "hidden",
    // Clear Formatting ships hidden: reachable via the command palette and slash menu.
    clearFormatting: "hidden",
    // Edit / Read-only, beside Edit Raw Markdown: the two controls answer the
    // same question ("how am I working with this file right now") and belong
    // next to each other.
    readOnly: "right",
    viewSource: "right",
    find: "right",
    styleCheck: "right",
    fontPreset: "right",
    settings: "right",
};

/**
 * Which toolbar items act on the document, and so must go inert while the
 * editor is read-only (MAR-53).
 *
 * A `Record` over every id rather than a list of the mutating ones, so a new
 * toolbar item fails to compile until its author has answered the question.
 * The mode's correctness never depends on this table — a missed entry is a
 * button that no-ops against the transaction filter, not one that edits — but
 * a live-looking button that does nothing is the failure the mode's whole
 * trust argument rests on avoiding, so the table is exhaustive by type for the
 * same reason the command classification is.
 */
export const ITEM_MUTATES: Record<ToolbarItemId, boolean> = {
    format: true,
    bold: true,
    italic: true,
    strikethrough: true,
    highlight: true,
    inlineCode: true,
    link: true,
    listMenu: true,
    quote: true,
    codeBlock: true,
    horizontalRule: true,
    table: true,
    image: true,
    math: true,
    footnote: true,
    clearFormatting: true,
    // Find without Replace, the mode toggle itself, the view controls and the
    // gear all leave the document alone.
    readOnly: false,
    viewSource: false,
    find: false,
    styleCheck: false,
    fontPreset: false,
    settings: false,
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
