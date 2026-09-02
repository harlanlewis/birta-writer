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
import { syntaxAllows, type SyntaxFeature } from "../../../shared/syntaxSets";


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
    "sectionLink",
    "clearFormatting",
    "math",
    "agentReference",
] as const;

export type FloatingToolbarItemId = (typeof FLOATING_TOOLBAR_ITEM_IDS)[number];

/** Per-item visibility map (birta.floatingToolbar.items.*). */
export type FloatingToolbarItems = Partial<Record<FloatingToolbarItemId, boolean>>;

/**
 * Items the palette ships HIDDEN: available, but opt-in via their
 * `birta.floatingToolbar.items.<id>` setting. The palette earns its place by
 * being small — these four are reachable from the toolbar, block menu, or
 * command palette, and cost more in width than they return in reach. Kept in
 * lockstep with the package.json `default` values by
 * floatingToolbarDefaultsContributions.test.ts.
 */
export const FLOATING_TOOLBAR_DEFAULT_OFF: ReadonlySet<FloatingToolbarItemId> = new Set([
    "math",
    "highlight",
    "sectionLink",
    "clearFormatting",
]);

/**
 * The syntax each inline item writes, or null for one whose output is
 * CommonMark (shared/syntaxSets.ts).
 *
 * A `Record` over every id rather than a list of the three that are gated, so
 * a new palette item fails to compile until its author has answered the
 * question — the same shape, and the same reason, as `ITEM_MUTATES` on the top
 * bar. `agentReference` writes to the CLIPBOARD rather than the document, so
 * there is no syntax for a target to withhold.
 */
export const ITEM_SYNTAX: Record<FloatingToolbarItemId, SyntaxFeature | null> = {
    format: null,
    bold: null,
    italic: null,
    strikethrough: "strikethrough",
    inlineCode: null,
    highlight: "highlight",
    link: null,
    sectionLink: null,
    clearFormatting: null,
    math: "math",
    agentReference: null,
};

/**
 * The set of inline items to show, from a (possibly partial or malformed)
 * config. An explicit flag always wins; a missing flag falls back to the
 * item's shipped default (on, unless listed in FLOATING_TOOLBAR_DEFAULT_OFF)
 * — the same contract the package.json defaults declare.
 *
 * A syntax target the reader has narrowed withdraws on top of that, and it
 * wins over an explicit `true`: the setting says which controls this reader
 * wants on the palette, and the target says which of them write Markdown the
 * document is meant to contain. Turning an item on cannot make a target spell
 * a syntax it does not have.
 */
export function resolveVisible(
    items: FloatingToolbarItems | undefined,
): Set<FloatingToolbarItemId> {
    const visible = new Set<FloatingToolbarItemId>();
    for (const id of FLOATING_TOOLBAR_ITEM_IDS) {
        const flag = items?.[id];
        const wanted = flag === true || (flag === undefined && !FLOATING_TOOLBAR_DEFAULT_OFF.has(id));
        if (wanted && syntaxAllows(ITEM_SYNTAX[id] ?? undefined)) {
            visible.add(id);
        }
    }
    return visible;
}
