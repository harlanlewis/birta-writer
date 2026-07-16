/**
 * Markdown serialization configuration, shared by the editor and by the
 * round-trip tests so both exercise the exact same serializer behavior.
 */
import { remarkStringifyOptionsCtx, type Editor } from "@milkdown/core";
import { commonmark, remarkPreserveEmptyLinePlugin } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { calloutsPlugin } from "./plugins/callouts";
import { directivesPlugin } from "./plugins/directives";
import { fidelitySerializerPlugin } from "./plugins/fidelitySerializer";
import { highlightPlugin } from "./plugins/highlight";
import { listItemSpreadBoolPlugins, listSpreadBooleanPlugins, listSpreadReplacedPlugins } from "./plugins/list";
import { notionCalloutNodes, notionCalloutRemark } from "./plugins/notionCallouts";
import { referenceLinksPlugin } from "./plugins/referenceLinks";
import { reparseHazardPlugin } from "./plugins/reparseHazard";
import { tableAlignDefaultPlugin } from "./plugins/tableAlignDefault";
import { wikiLinksPlugin } from "./plugins/wikiLinks";
import { mathPlugin } from "./plugins/math";
import { headingInputReplacedPlugins } from "./plugins/headingInput";
import {
    sourceStyleHandlers,
    sourceStylePlugin,
    sourceStyleReplacedPlugins,
} from "./plugins/sourceStyle";
import { tableBreakReplacedPlugins, tableBreaksPlugin } from "./plugins/tableBreaks";

type EditorCtx = Parameters<Parameters<Editor["config"]>[0]>[0];

/**
 * The commonmark preset minus two of Milkdown's remark transforms, plus our
 * reference-link schemas.
 *
 * `remark-preserve-empty-line` round-trips empty paragraphs (and empty table
 * cells) as literal `<br />` HTML, which pollutes a file that should stay
 * pure Markdown. With it removed, empty paragraphs degrade to blank lines —
 * the closest Markdown has to an empty paragraph — and empty table cells
 * serialize as genuinely empty cells. Standalone `<br />` lines already
 * present in a file are no longer swallowed on parse either; they stay as
 * inert HTML nodes and round-trip unchanged.
 *
 * `remark-inline-links` rewrites `[text][ref]` into inline links and DELETES
 * the `[ref]: url` definitions before the ProseMirror transformer runs, so
 * reference-style documents were silently restructured. With it removed, the
 * `definition` / `linkReference` / `imageReference` mdast nodes reach the
 * transformer and are modeled by `referenceLinksPlugin`
 * (plugins/referenceLinks.ts), keeping the reference form intact. The plugin
 * is absent from the preset's .d.ts, so it is filtered by its withMeta
 * displayName rather than by identity.
 *
 * `fidelitySerializerPlugin` (plugins/fidelitySerializer.ts) swaps the stock
 * `SerializerState` for a vendored, patched copy that keeps a link
 * containing bold/italic/code children serialized as ONE link instead of
 * several adjacent same-URL links, and defers emphasis edge-space trimming
 * until after adjacent mark segments have merged.
 *
 * `mathPlugin` (plugins/math.ts) adds KaTeX inline/block math: `remark-math`
 * for parsing/serializing `$...$` and `$$...$$`, a visitor that routes block
 * math through the fenced-code-block machinery, and a `code_block` schema
 * extension that serializes LaTeX-language blocks back to `$$`. It is placed
 * after the base preset so the `code_block` extendSchema overrides the stock
 * commonmark definition.
 *
 * `wikiLinksPlugin` (plugins/wikiLinks.ts) adds `[[wikilink]]` support: a
 * custom micromark text construct (strict `[[…]]` grammar, so footnotes,
 * task markers, and normal links are untouched), a `wiki_link` inline atom,
 * and a stringify handler that re-emits the source bytes between the
 * brackets verbatim — byte-identical round-trip by construction. Registered
 * unconditionally: round-trip behavior must never depend on configuration
 * (the smartLinks setting gates navigation and autocomplete, not parsing).
 *
 * `sourceStylePlugin` (plugins/sourceStyle.ts) preserves cosmetic Markdown
 * style (MAR-16): the stock `hr` / `heading` schemas are filtered out and
 * replaced with extended copies that carry the original thematic-break marker
 * and setext form; paired with the custom stringify handlers in
 * `sourceStyleHandlers`, `***`/`___` rules and setext headings round-trip
 * instead of being canonicalized. (Emphasis/strong markers already survive as
 * PM attrs via the preset's `remarkMarker`; only the stringify handler is
 * new.)
 *
 * `tableBreaksPlugin` (plugins/tableBreaks.ts) preserves `<br>` line breaks
 * inside table cells (MAR-17): the stock `hardbreak` schema is filtered out and
 * replaced with an extended copy carrying a `variant` attr (the original `<br>`
 * byte spelling), and a remark visitor rewrites `<br>` html atoms inside cells
 * into real, editable break nodes. The serializer side lives in
 * `serializeTableNoAlign` below.
 *
 * `calloutsPlugin` (plugins/callouts.ts) adds GitHub/Obsidian callouts
 * (MAR-27): a parse-time tree transform rewrites blockquotes whose first line
 * is a `[!TYPE]` marker into `callout` nodes carrying the RAW marker-line
 * bytes, and a toMarkdown handler re-emits them through the stock blockquote
 * machinery — byte-identical round-trip by construction. Registered
 * unconditionally, like wikilinks: round-trip behavior never depends on
 * configuration.
 *
 * `directivesPlugin` (plugins/directives.ts) adds `:::name` container
 * directives (Docusaurus admonitions) the same way — a tree transform over
 * fence-line paragraphs with raw fence bytes preserved. Deliberately NOT
 * remark-directive: its text-directive syntax swallows `:word` in ordinary
 * prose, a fidelity hazard.
 *
 * `highlightPlugin` (plugins/highlight.ts) adds `==highlight==` (Obsidian):
 * a custom micromark text construct with a strict grammar (no `=` inside, no
 * edge spaces), a `highlight` PM mark, and a stringify handler that re-emits
 * the source bytes verbatim.
 *
 * `notionCalloutRemark` + `notionCalloutNodes` (plugins/notionCallouts.ts)
 * render Notion-export `<aside>` callouts as editable blocks. The remark
 * transform is spread FIRST because it sub-parses the aside's raw first
 * segment and injects the result into the tree — the preset's own
 * transforms (remarkLineBreak, remarkMarker, …), registered after, then
 * process those children exactly like normally parsed content. The SCHEMA
 * registers after the preset: createAndFill picks the first block-group
 * type to fill `block+`, which must stay `paragraph`.
 */
export const pureCommonmark = [
    ...notionCalloutRemark,
    ...commonmark.filter((plugin) => {
        if (
            plugin === remarkPreserveEmptyLinePlugin.plugin ||
            plugin === remarkPreserveEmptyLinePlugin.options
        ) {
            return false;
        }
        if (sourceStyleReplacedPlugins.has(plugin)) return false;
        if (tableBreakReplacedPlugins.has(plugin)) return false;
        if (listSpreadReplacedPlugins.has(plugin)) return false;
        // Stock `#` input rule ADDS hashes to an existing heading's level;
        // headingAbsoluteInputRule (plugins/headingInput.ts) replaces it.
        if (headingInputReplacedPlugins.has(plugin)) return false;
        const displayName = (plugin as { meta?: { displayName?: string } }).meta?.displayName;
        return !(displayName?.includes("remarkInlineLinkPlugin"));
    }),
    ...referenceLinksPlugin,
    ...wikiLinksPlugin,
    ...calloutsPlugin,
    ...notionCalloutNodes,
    ...directivesPlugin,
    ...highlightPlugin,
    ...mathPlugin,
    ...sourceStylePlugin,
    ...tableBreaksPlugin,
    // AFTER the preset: override the bullet_list / ordered_list / list_item
    // parseMarkdown runners so `spread` parses as a real boolean, not a string
    // (MAR-124). See plugins/list.ts.
    ...listSpreadBooleanPlugins,
    fidelitySerializerPlugin,
    // Registers this editor's serializer/parser for the save-survival move
    // check (MAR-120). Rides the base preset so no construction site —
    // production or test factory — can wire an editor without it (the
    // MAR-143 argument).
    reparseHazardPlugin,
];

/**
 * `gfm` plus the two overrides that MUST register after it, bundled so no
 * editor-construction site (production or test) can wire gfm without them and
 * silently diverge (MAR-143):
 *
 *   - `tableAlignDefaultPlugin` — null table-cell alignment default;
 *   - `listItemSpreadBoolPlugins` — boolean list `spread` over gfm's task-list
 *     schema (MAR-124).
 *
 * Order is preserved (gfm first, overrides after) so the overrides win. Use it
 * wherever `.use(gfm)` was: register it after `pureCommonmark`, exactly as gfm
 * was — production `editor.ts` and every test editor factory go through this
 * one bundle so the test harness matches production by construction.
 */
export const gfmFidelity = [gfm, tableAlignDefaultPlugin, listItemSpreadBoolPlugins].flat();

// Replace `break` nodes with `html` nodes carrying the recorded `<br>` bytes
// (MAR-17). mdast-util-to-markdown's `hardBreak` handler cannot emit an
// end-of-line inside a `tableCell` construct and falls back to a SPACE, so a
// hard break inside a cell was silently lost. The `html` handler emits its
// value verbatim, bypassing that fallback. Returns the SAME node reference when
// a cell contains no break, so cells without line breaks serialize
// byte-identically (no churn on untouched cells). Recurses through phrasing
// wrappers (strong/emphasis/link) so a break nested inside a mark is caught too.
function replaceBreaksWithHtml(node: any): any {
    if (!node.children) return node;
    let changed = false;
    const children = node.children.map((child: any) => {
        if (child.type === "break") {
            changed = true;
            return { type: "html", value: child.data?.htmlVariant || "<br>" };
        }
        const transformed = replaceBreaksWithHtml(child);
        if (transformed !== child) changed = true;
        return transformed;
    });
    return changed ? { ...node, children } : node;
}

// Custom table serializer: every column keeps its natural width, with no
// column-width alignment. Overrides the remark-gfm default table handler,
// which pads all columns to equal width and therefore reformats the whole
// table when a single cell is edited.
// state.enter/exit maintain the mdast-util-to-markdown context stack, which
// drives the escaping rules for special characters.
function serializeTableNoAlign(node: any, _parent: any, state: any): string {
    const tableExit = state.enter("table");
    const lines: string[] = [];

    for (let rowIdx = 0; rowIdx < node.children.length; rowIdx++) {
        const row = node.children[rowIdx];
        const rowExit = state.enter("tableRow");

        const cellValues: string[] = row.children.map((cell: any) => {
            const cellExit = state.enter("tableCell");
            const phrasingExit = state.enter("phrasing");
            const value = state.containerPhrasing(replaceBreaksWithHtml(cell), {
                before: "|",
                after: "|",
            });
            phrasingExit();
            cellExit();
            return value;
        });

        rowExit();
        lines.push("| " + cellValues.join(" | ") + " |");

        // After the header row, insert the separator row, keeping the original
        // alignment markers (:---:, ---:, :---, ---)
        if (rowIdx === 0) {
            const aligns: (string | null)[] = node.align ?? [];
            const seps = row.children.map((_: any, j: number) => {
                const a = aligns[j] ?? null;
                if (a === "center") return ":---:";
                if (a === "right") return "---:";
                if (a === "left") return ":---";
                return "---";
            });
            lines.push("|" + seps.join("|") + "|");
        }
    }

    tableExit();
    return lines.join("\n");
}

/**
 * Apply the stringify options that keep serializer output close to the
 * original file formatting: `-` bullets, `---` rules (instead of `***`), and
 * the natural-width table handler.
 */
export function configureSerialization(ctx: EditorCtx): void {
    ctx.update(remarkStringifyOptionsCtx, (prev) => ({
        ...prev,
        bullet: "-" as const,
        rule: "-" as const,
        handlers: {
            ...(prev.handlers ?? {}),
            ...sourceStyleHandlers,
            table: serializeTableNoAlign,
        },
    }));
}
