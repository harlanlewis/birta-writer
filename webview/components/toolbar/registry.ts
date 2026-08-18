/**
 * webview/components/toolbar/registry.ts
 *
 * Pure metadata + layout resolution for the main toolbar. The item factories
 * themselves live in `index.ts` (they close over the editor handle and other
 * runtime dependencies); this module is DOM-free and unit-tested.
 */
import type { ToolbarConfig, ToolbarPlacement, ToolbarZone } from "../../../shared/messages";
import type { EditorCommandId } from "../../../shared/editorCommands";
import { hostHas, type HostCapability } from "../../../shared/hostCapabilities";

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
    // Edit / Read-only ships hidden: the Toggle Read-only command and
    // `birta.readOnly` cover it, and a lock on the bar of every document is a
    // control most readers never reach for. Shown, it sits beside Edit Raw
    // Markdown, because the two answer the same question ("how am I working
    // with this file right now").
    readOnly: "hidden",
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

/**
 * The editor commands each toolbar item runs, in the shared command
 * vocabulary (`shared/editorCommands.ts`). This is what keeps `ITEM_MUTATES`
 * honest: it and `COMMAND_EFFECTS` (webview/readOnly.ts) are two tables that
 * classify the same gestures, and nothing about their shape stops one from
 * saying "mutates" where the other says "reads". `toolbarRegistry.test.ts`
 * asserts that an item mutates exactly when one of its commands does. Items
 * that reach the document without a command (the image panel's own insert,
 * the link prompt) name the command the palette runs for the same gesture.
 * A renamed command fails to compile here; a reclassified one fails the test.
 */
export const ITEM_COMMANDS: Record<ToolbarItemId, readonly EditorCommandId[]> = {
    format: ["setParagraph", "setHeading1", "setHeading2", "setHeading3", "setHeading4", "setHeading5", "setHeading6"],
    bold: ["toggleBold"],
    italic: ["toggleItalic"],
    strikethrough: ["toggleStrikethrough"],
    highlight: ["toggleHighlight"],
    inlineCode: ["toggleInlineCode"],
    link: ["insertLink"],
    listMenu: ["toggleBulletList", "toggleOrderedList", "toggleTaskList"],
    quote: ["toggleBlockquote", "toggleCallout"],
    codeBlock: ["insertCodeBlock"],
    horizontalRule: ["insertHorizontalRule"],
    table: ["insertTable"],
    image: ["insertImage"],
    math: ["insertMath"],
    footnote: ["insertFootnote"],
    clearFormatting: ["clearFormatting"],
    readOnly: ["toggleReadOnly"],
    viewSource: ["editRawMarkdown"],
    find: ["openFind"],
    styleCheck: ["toggleSpellCheck", "toggleGrammarCheck", "toggleStyleCheck", "toggleNoteHighlights"],
    fontPreset: ["contentWidthFull", "contentWidthFixed", "fontEditor", "fontSans", "fontSerif", "fontMono", "increaseFontSize", "decreaseFontSize"],
    settings: ["openExtensionSettings", "customizeToolbar", "hideToolbar", "openKeyboardShortcuts", "openWhatsNew"],
};

/**
 * The host capability each item needs, or null for an item the editor answers
 * by itself (shared/hostCapabilities.ts). A host that does not declare the
 * capability has no such item: it is not built, and `computeZones` drops it
 * from every zone, the customize tray's hidden set included, so the user is
 * never offered a control that posts to a host that cannot answer.
 *
 * Exhaustive by type like the two tables above, and tied to them the same
 * way: `toolbarRegistry.test.ts` asserts an item needs capability C exactly
 * when one of its `ITEM_COMMANDS` needs C. `settings` is the documented
 * exception: the gear mixes gated rows (Settings, Edit Keyboard Shortcuts,
 * What's New) with unconditional ones (Customize, Hide, Show Keyboard
 * Shortcuts), so it stays and its menu filters row by row.
 */
export const ITEM_HOST_CAPABILITY: Record<ToolbarItemId, HostCapability | null> = {
    format: null,
    bold: null,
    italic: null,
    strikethrough: null,
    highlight: null,
    inlineCode: null,
    link: null,
    listMenu: null,
    quote: null,
    codeBlock: null,
    horizontalRule: null,
    table: null,
    image: "imageUpload",
    math: null,
    footnote: null,
    clearFormatting: null,
    readOnly: "readOnlyMode",
    viewSource: "textEditor",
    find: null,
    styleCheck: "proofreading",
    fontPreset: null,
    settings: null,
};

/** The items the host can carry: everything whose capability it declares. */
export function hostAvailableItems(): ReadonlySet<ToolbarItemId> {
    return new Set(TOOLBAR_ITEM_IDS.filter((id) => {
        const cap = ITEM_HOST_CAPABILITY[id];
        return cap === null || hostHas(cap);
    }));
}

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
 *
 * `available` is the set of items the host can carry (`hostAvailableItems`);
 * an item outside it appears in NO zone, `hidden` included, so the customize
 * tray cannot offer it. The default is every item, which is what every host
 * that declares no capabilities gets (absent means all).
 */
export function computeZones(
    config: ToolbarConfig | undefined,
    available: ReadonlySet<ToolbarItemId> = new Set(TOOLBAR_ITEM_IDS),
): Record<ToolbarZone | "hidden", ToolbarItemId[]> {
    const placements = config?.placements;
    const order = Array.isArray(config?.order) ? config!.order : [];

    const result: Record<ToolbarZone | "hidden", ToolbarItemId[]> = {
        left: [],
        right: [],
        hidden: [],
    };
    for (const id of TOOLBAR_ITEM_IDS) {
        if (!available.has(id)) { continue; }
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
