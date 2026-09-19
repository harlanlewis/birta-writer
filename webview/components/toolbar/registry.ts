/**
 * webview/components/toolbar/registry.ts
 *
 * Pure metadata + layout resolution for the main toolbar. The item factories
 * themselves live in `index.ts` (they close over the editor handle and other
 * runtime dependencies); this module is DOM-free and unit-tested.
 */
import type { ToolbarConfig, ToolbarPlacement, ToolbarZone } from "../../../shared/messages";
import type { EditorCommandId } from "../../../shared/editorCommands";
import { hostHas, type HostCapability, hostArranges } from "../../../shared/hostProfile";
import { commandAvailable } from "../../../shared/commandAvailability";

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
    "fontPreset",
    "settings",
    "toc",
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
    fontPreset: "right",
    settings: "right",
    // Last in canonical order, so it is the bar's trailing control on every
    // surface: the sidebar is not one of the document's own controls, and the
    // outer edge is where a window puts the thing that opens a panel beside it.
    toc: "right",
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
    fontPreset: false,
    settings: false,
    toc: false,
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
    fontPreset: ["contentWidthFull", "contentWidthFixed", "fontEditor", "fontSans", "fontSerif", "fontMono", "increaseFontSize", "decreaseFontSize"],
    settings: ["openExtensionSettings", "openHostPreferences", "customizeToolbar", "hideToolbar", "openKeyboardShortcuts", "openWhatsNew"],
    toc: ["toggleToc"],
};

/**
 * The host capability each item needs, or null for an item the editor answers
 * by itself (shared/hostProfile.ts). A host that does not declare the
 * capability has no such item: it is not built, and `computeZones` drops it
 * from every zone, the customize tray's hidden set included, so the user is
 * never offered a control that posts to a host that cannot answer.
 *
 * Exhaustive by type like the two tables above, and tied to them the same way:
 * `toolbarRegistry.test.ts` asserts an item is gated on C exactly when ALL of
 * its `ITEM_COMMANDS` need C. An item whose commands are mixed, some needing a
 * host and some not, or two needing different hosts, must be null and must
 * filter its own rows through `commandAvailable`. The gear does that, the font
 * menu does, and the Checks menu does.
 *
 * That rule is derived rather than a list, and the difference is what it
 * catches. Its earlier form asked whether ANY command needed a capability,
 * which a wholesale-gated mixed menu satisfies, so the Checks menu was
 * withdrawn entire from a host with no lint engine, taking with it the style
 * check and its categories, which the page computes for itself and which that
 * surface could have run all along.
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
    fontPreset: null,
    settings: null,
    toc: "toc",
};

/**
 * The items the host can carry: everything whose capability it declares.
 *
 * Two items have a second reason to be absent, and both are layout choices
 * rather than capabilities. The CONTROL exists either way in both cases, so the
 * palette and slash-menu commands are unaffected; only the bar item is.
 *
 * `fontPreset`: a surface that puts the typography rows inside the gear menu has
 * no use for an item that would open an empty menu beside it.
 *
 * `toc`: the bar's button and the panel's own reveal tab are two routes to one
 * command, and a surface takes exactly one of them. `tocToggleInBar` is the
 * declaration that the bar holds it, so the item is present under that
 * arrangement and absent without it, where the panel shows itself.
 *
 * The arrangement is load-bearing here and not decoration: gate this on the
 * `toc` capability alone and every host with a sidebar draws both controls, a
 * bar button and the panel's tab below it doing the same thing a few pixels
 * apart. The panel half already reads the arrangement (`components/toc/`), so
 * the bar reading it too is what keeps the pair in step.
 */
export function hostAvailableItems(): ReadonlySet<ToolbarItemId> {
    return new Set(TOOLBAR_ITEM_IDS.filter((id) => {
        if (id === "fontPreset" && hostArranges("typographyInGearMenu")) { return false; }
        if (id === "toc" && !hostArranges("tocToggleInBar")) { return false; }
        const cap = ITEM_HOST_CAPABILITY[id];
        return cap === null || hostHas(cap);
    }));
}

/**
 * The items to PLACE right now: what the host can carry, minus what no enabled
 * syntax set spells (shared/syntaxSets.ts).
 *
 * Two functions rather than one, and the split is the difference between a
 * fact that is baked and a setting that is not. `hostAvailableItems` answers
 * at BUILD time, because the host declaration is fixed for the life of the
 * page and an item the host cannot carry is never constructed. A syntax target
 * is the user's and changes while the editor is open, so it is answered at
 * RENDER time over items that already exist; folding it into the build-time
 * set would leave an item unbuilt and unreachable for the rest of the session
 * the moment its target came back.
 *
 * Withdrawal is DERIVED from `ITEM_COMMANDS` rather than declared in a table of
 * its own, and the rule is the one `ITEM_HOST_CAPABILITY` documents: an item
 * goes when EVERY command it runs is withdrawn. An item whose commands are
 * mixed stays and filters its own rows, which is what keeps the list dropdown
 * (bullet and ordered are CommonMark, task lists are not) and the quote
 * dropdown (a blockquote is CommonMark, a callout is not) on the bar with one
 * row fewer instead of taking two CommonMark controls away with them.
 *
 * An item with no commands at all is never withdrawn: an empty `every` is
 * vacuously true, which would read as "all of its commands are gone", so the
 * length check states the intended answer rather than inheriting the wrong one.
 */
export function offeredItems(): ReadonlySet<ToolbarItemId> {
    const host = hostAvailableItems();
    return new Set([...host].filter((id) => {
        const commands = ITEM_COMMANDS[id];
        return commands.length === 0 || commands.some((cmd) => commandAvailable(cmd));
    }));
}

/**
 * The two surfaces under `formattingInSecondRow`, as one partition of the
 * items this host can carry.
 *
 * The split is `ITEM_MUTATES` and nothing else: a control that changes the
 * document docks, and one that only reads stays on the top bar. That table is
 * exhaustive by type and already tied to `COMMAND_EFFECTS` by
 * `toolbarRegistry.test.ts`, so a new item cannot join the wrong surface
 * without failing to compile first and failing that test second. A hand-kept
 * list of "the formatting ones" is exactly the list a new item never joins.
 *
 * `dock` is in canonical `TOOLBAR_ITEM_IDS` order and takes no config: this
 * arrangement travels with `fixedToolbarLayout`, so there is no placement to
 * consult, nothing hidden, and no order to override. Every item the host can
 * carry appears on exactly one of the two, which is the property the test
 * asserts rather than the two lists themselves.
 */
export function computeDockPartition(
    available: ReadonlySet<ToolbarItemId> = new Set(TOOLBAR_ITEM_IDS),
): { dock: ToolbarItemId[]; topBar: ToolbarItemId[] } {
    const dock: ToolbarItemId[] = [];
    const topBar: ToolbarItemId[] = [];
    for (const id of TOOLBAR_ITEM_IDS) {
        if (!available.has(id)) { continue; }
        (ITEM_MUTATES[id] ? dock : topBar).push(id);
    }
    return { dock, topBar };
}

/**
 * The kinds of thing a toolbar item is, which is what a separator separates.
 *
 * A run of evenly spaced glyphs is scanned one glyph at a time, because nothing
 * in it tells the eye where it may skip. Grouping is what lets somebody look
 * for an insert and pass the marks without reading them, and it costs no
 * control.
 */
export type ToolbarItemGroup =
    /** The paragraph-style picker: what this block IS. */
    | "paragraph"
    /** Inline marks, link included: what a RUN of text is. */
    | "mark"
    /** Block containers the caret goes inside: lists, quotes, code. */
    | "container"
    /** Things put INTO the document that were not there: a table, an image. */
    | "insert"
    /** Taking formatting away again. */
    | "revert"
    /** How the document is being worked with rather than what it says. */
    | "mode"
    /** Controls over the view: find, typography. */
    | "view"
    /** The window's own furniture: the gear, the panels it opens. */
    | "shell";

/**
 * Which group each item belongs to.
 *
 * Exhaustive by type, like the three tables above and for the same reason: a
 * new toolbar item must answer where it sits rather than inherit the answer of
 * whichever item it happens to be declared next to. The formatting row
 * (`dock.ts`) is the one reader today, through `groupRuns`.
 *
 * The groups are CONTIGUOUS in `TOOLBAR_ITEM_IDS`, and that is a property
 * rather than a coincidence: a run is the unit a separator bounds, so a group
 * split across the canonical order would draw two of them and read as two
 * different kinds of thing with the same name. `toolbarRegistry.test.ts` holds
 * it, which is what turns an item declared in the wrong place into a failure
 * rather than into a second divider nobody notices.
 */
export const ITEM_GROUP: Record<ToolbarItemId, ToolbarItemGroup> = {
    format: "paragraph",
    bold: "mark",
    italic: "mark",
    strikethrough: "mark",
    highlight: "mark",
    inlineCode: "mark",
    // A link is a mark, and it sits with the marks rather than with the
    // inserts although it is reached by a dialog: what it does to the
    // selection is what bold does to it.
    link: "mark",
    listMenu: "container",
    quote: "container",
    codeBlock: "container",
    horizontalRule: "insert",
    table: "insert",
    image: "insert",
    math: "insert",
    footnote: "insert",
    clearFormatting: "revert",
    readOnly: "mode",
    viewSource: "mode",
    find: "view",
    fontPreset: "view",
    settings: "shell",
    toc: "shell",
};

/**
 * Split `ids` into runs of one group each, in the order given.
 *
 * The caller draws a separator BETWEEN runs, never around them, so a row of
 * one group carries no chrome at all and a leading or trailing rule is
 * impossible by construction rather than by a check at the call site.
 *
 * Splitting on CHANGE rather than collecting by group is what keeps the
 * caller's order intact: this never reorders, so a surface that has already
 * decided its order gets its own order back with rules in it.
 */
export function groupRuns(ids: readonly ToolbarItemId[]): ToolbarItemId[][] {
    const runs: ToolbarItemId[][] = [];
    let group: ToolbarItemGroup | undefined;
    for (const id of ids) {
        const next = ITEM_GROUP[id];
        if (next !== group || runs.length === 0) { runs.push([]); }
        runs[runs.length - 1]!.push(id);
        group = next;
    }
    return runs;
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
