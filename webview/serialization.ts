/**
 * Markdown serialization configuration, shared by the editor and by the
 * round-trip tests so both exercise the exact same serializer behavior.
 */
import { remarkStringifyOptionsCtx, type Editor } from "@milkdown/core";
import { commonmark, remarkPreserveEmptyLinePlugin } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { calloutsPlugin } from "./plugins/callouts";
import { directivesPlugin } from "./plugins/directives";
import { createSerializerPostPassPlugin } from "./plugins/serializerPostPass";
import { highlightPlugin } from "./plugins/highlight";
import { listItemSpreadBoolPlugins, listSpreadBooleanPlugins, listSpreadReplacedPlugins } from "./plugins/list";
import { imageStringAttrPlugins, imageStringAttrReplacedPlugins } from "./plugins/image";
import { strikethroughHtmlPlugins, strikethroughHtmlReplacedPlugins } from "./plugins/pasteHtml";
import { linkBoundaryPlugins } from "./plugins/linkBoundary";
import { notionCalloutNodes, notionCalloutRemark } from "./plugins/notionCallouts";
import { referenceLinksPlugin } from "./plugins/referenceLinks";
import { reparseHazardPlugin } from "./plugins/reparseHazard";
import { tableAlignDefaultPlugin } from "./plugins/tableAlignDefault";
import { wikiLinksPlugin } from "./plugins/wikiLinks";
import { mathPlugin } from "./plugins/math";
import { headingInputReplacedPlugins } from "./plugins/headingInput";
import { headingIdReplacedPlugins, headingIdSyncPlugin } from "./plugins/headingIdSync";
import { listOrderReplacedPlugins, listOrderSyncPlugin } from "./plugins/listOrderSync";
import { emphasisInputReplacedPlugins, mathAwareEmphasisStarInputRule } from "./plugins/emphasisInput";
import {
    sourceStyleHandlers,
    sourceStylePlugin,
    sourceStyleReplacedPlugins,
} from "./plugins/sourceStyle";
import { tableBreakReplacedPlugins, tableBreaksPlugin } from "./plugins/tableBreaks";
import { unescapeAutolinkBackslashes, unescapeOrgCookies } from "./utils/minimalDiff";

type EditorCtx = Parameters<Parameters<Editor["config"]>[0]>[0];

/**
 * Markdown's whole-document serializer post-pass: the org-cookie unescape
 * (MAR-131) followed by the autolink backslash unescape (MAR-218). Both need
 * the WHOLE serialized document — the first to see every `[label]:` definition
 * and fence, the second to skip fenced content — and both are line-oriented and
 * independent, so composing them is order-insensitive. The hook takes one pass,
 * so this is where markdown's passes compose.
 */
const postSerialize = (serialized: string): string =>
    unescapeAutolinkBackslashes(unescapeOrgCookies(serialized));

/**
 * Markdown's whole-document post-pass (above), wrapped around the stock
 * serializer by the format-agnostic factory in plugins/serializerPostPass.ts.
 * Bound here, inside the preset, so every construction site — production
 * editor.ts and every test factory — serializes with the pass by construction
 * (the MAR-143 argument). This binding is the SINGLE source of truth for the
 * pass: the FormatModule deliberately declares no separate post-pass member
 * (see the charter in webview/format/types.ts).
 */
const serializerPostPassPlugin = createSerializerPostPassPlugin(postSerialize);

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
 * `serializerPostPassPlugin` (built above from plugins/serializerPostPass.ts)
 * wraps the stock serializer with markdown's whole-document post-pass — the
 * org-cookie unescape (MAR-131) and the autolink backslash unescape (MAR-218),
 * both of which need the WHOLE serialized document rather than one node.
 *
 * Until Milkdown 7.22.0 this slot held a whole vendored copy of upstream's
 * `SerializerState`, patched so a link containing bold/italic/code children
 * serialized as ONE link rather than several adjacent same-URL ones (MAR-33).
 * Upstream now keeps marks open across adjacent nodes (#2405), so all that
 * survives of the patch is `priority: 25` on the two link marks — see
 * plugins/linkBoundary.ts.
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
        if (imageStringAttrReplacedPlugins.has(plugin)) return false;
        // Stock `#` input rule ADDS hashes to an existing heading's level;
        // headingAbsoluteInputRule (plugins/headingInput.ts) replaces it.
        if (headingInputReplacedPlugins.has(plugin)) return false;
        // Stock heading-id / list-order sync plugins walk the WHOLE document
        // (inline content included) on every doc-changing transaction; the
        // replacements below skip edits that provably cannot change an id or
        // label, and prune the walk when they can (MAR-137).
        if (headingIdReplacedPlugins.has(plugin)) return false;
        if (listOrderReplacedPlugins.has(plugin)) return false;
        // Stock `*emphasis*` rule italicizes intraword stars, eating the `*`s
        // of typed arithmetic (`60*60*1000`); the math-aware replacement
        // (plugins/emphasisInput.ts) registers below.
        if (emphasisInputReplacedPlugins.has(plugin)) return false;
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
    // Replaces the stock star-emphasis input rule filtered out above.
    mathAwareEmphasisStarInputRule,
    // Replace the stock heading-id / list-order sync plugins filtered out
    // above (MAR-137 — see each module's header for the economy).
    headingIdSyncPlugin,
    listOrderSyncPlugin,
    // AFTER the preset: override the bullet_list / ordered_list / list_item
    // parseMarkdown runners so `spread` parses as a real boolean, not a string
    // (MAR-124). See plugins/list.ts.
    ...listSpreadBooleanPlugins,
    // AFTER the preset: override the image parseMarkdown runner so a
    // title-less image parses with "" (valid) instead of mdast's null, which
    // fails the node's own attr validation. See plugins/image.ts.
    ...imageStringAttrPlugins,
    // AFTER the preset: the link mark becomes inclusive:false, so typing at
    // a link's end boundary stays plain text instead of silently extending
    // the link. See plugins/linkBoundary.ts.
    ...linkBoundaryPlugins,
    serializerPostPassPlugin,
    // Registers this editor's serializer/parser for the save-survival move
    // check (MAR-120). Rides the base preset so no construction site —
    // production or test factory — can wire an editor without it (the
    // MAR-143 argument).
    reparseHazardPlugin,
];

/**
 * `gfm` plus the overrides that MUST register after it, bundled so no
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
 *
 * gfm's own `keepTableAlignPlugin` used to be filtered out here and replaced
 * by ours, because it walked the WHOLE document on every doc-changing
 * transaction and appended an empty transaction every time — 16.1 ms of a
 * 23.7 ms keystroke on the 300 KB fixture, which contains no tables at all
 * (MAR-137). That fix went upstream and shipped in 7.22.0 (Milkdown #2436),
 * so the replacement is gone and gfm's own plugin runs again.
 */
export const gfmFidelity = [
    gfm.filter((plugin) => !strikethroughHtmlReplacedPlugins.has(plugin)),
    tableAlignDefaultPlugin,
    listItemSpreadBoolPlugins,
    // Recognise <s>/<strike> on paste; parse-only, serialization unchanged.
    strikethroughHtmlPlugins,
].flat();

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
 * Emit the blank line between two list items that the SOURCE actually had
 * (MAR-194), rather than the one `spread` implies for the whole list.
 *
 * mdast has a single `spread` boolean per list, so a list with one errant blank
 * line in the middle parses as fully loose and mdast-util-to-markdown's default
 * join puts a blank between EVERY pair of items. The source gap survives parsing
 * as each item's `position`, though, and plugins/list.ts records it per item as
 * `blankBefore`; this reads it back.
 *
 * Returning `0`/`1` overrides the separator for that ONE gap. Returning
 * `undefined` defers to mdast's default.
 *
 * AN ITEM WITH NO RECORDED GAP READS ONE OFF ITS NEIGHBOURS (MAR-210). Deferring
 * is not neutral: mdast's default is the LIST-level `spread`, which a single
 * interior blank line makes `true` for the whole list — the very conflation
 * MAR-194 exists to undo. The first item of every list has nothing before it, so
 * its `blankBefore` is never recorded (`annotateItemGaps` starts at index 1), and
 * a reorder that lands it mid-list therefore drew its gap from that whole-list
 * default and INVENTED a blank line: `- a\n- b\n- c\n\n- d` with `a` moved down
 * one emitted `- b\n\n- a\n- c\n\n- d`.
 *
 * An item is inserted INTO a gap, so it should keep that gap's spacing on both
 * sides: the gap between its new neighbours is exactly the FOLLOWER's own
 * `blankBefore`, which is why the follower is asked first. At the end of a list
 * there is no follower and no gap to land in, so the nearest evidence is the last
 * recorded gap of the run it joined — the predecessor's own `blankBefore`, but
 * only when the predecessor is not itself the list's FIRST item, whose recorded
 * gap this list never emits (see `observedGap`). Neither neighbour offering one
 * means the list has no observed spacing at all (a list built entirely in the
 * editor, or one the Loosen/Tighten command just cleared), and the default is
 * then the honest answer.
 *
 * This only ever reads gaps the list itself emits, so it cannot invent one. In a
 * UNIFORM list the neighbour and the list-level default agree by construction,
 * so nothing changes for a list that was tight or loose throughout — only the
 * partly-loose list, where the default was never a fact about this gap.
 */
function listItemGapJoin(left: unknown, right: unknown, parent: unknown): number | undefined {
    const l = left as ({ type?: string; blankBefore?: unknown }) | null;
    const r = right as { type?: string; blankBefore?: unknown } | null;
    const list = parent as { type?: string; children?: unknown[] } | null;
    if (list?.type !== "list") {
        return undefined;
    }
    if (l?.type !== "listItem" || r?.type !== "listItem") {
        return undefined;
    }
    const gap = recordedGap(r) ?? observedGap(l, r, list);
    return gap === undefined ? undefined : (gap ? 1 : 0);
}

/** An item's own source-recorded gap, or `undefined` when it has none. */
function recordedGap(item: { blankBefore?: unknown } | null): boolean | undefined {
    return typeof item?.blankBefore === "boolean" ? item.blankBefore : undefined;
}

/**
 * The gap `right` landed in, read off its neighbours (see `listItemGapJoin`):
 * the follower's recorded gap — the one the insertion split in two — else the
 * predecessor's, the last recorded gap of the run it joined at the end.
 *
 * The `indexOf` is O(k) in the list's items, but it is reached only for an item
 * with NO recorded gap of its own, which for a parsed list is just the first
 * one; the caller's `??` short-circuits every other gap. A list built entirely
 * in the editor has no recorded gaps anywhere and does pay O(k²) — the same
 * deliberate trade `itemContentGapJoin` documents below, and for the same
 * reason: serialization runs on the sync scheduler, never per keystroke, and is
 * already O(document size) when it runs.
 */
function observedGap(
    left: { blankBefore?: unknown },
    right: unknown,
    list: { children?: unknown[] },
): boolean | undefined {
    const children = list.children;
    if (!Array.isArray(children)) {
        return recordedGap(left);
    }
    const index = children.indexOf(right);
    const follower = index < 0 ? null : (children[index + 1] as { blankBefore?: unknown } | null);
    // A FIRST item's recorded gap is not this list's spacing. `blankBefore` on
    // index 0 is never emitted — there is no pair for it to separate — so when
    // an item arrives from somewhere else carrying one, that gap describes a
    // position in the list it LEFT. Reading it as the predecessor's evidence
    // resurrects it one slot to the right: promoting the loose `two` out of
    // `- root\n\t- one\n\n\t- two\n` to the top of the document wrote
    // `- two\n\n- root`, a blank line at a level the author never spaced. The
    // follower is exempt by construction — it always has a predecessor, so its
    // gap is always one this list emits.
    const predecessor = children[0] === (left as unknown) ? null : left;
    return recordedGap(follower) ?? recordedGap(predecessor);
}

type FlowNode = {
    type?: string;
    marker?: unknown;
    setext?: unknown;
    depth?: number;
    ordered?: unknown;
    start?: unknown;
    children?: unknown[];
};

/**
 * An EMPTY paragraph — the schema artifact `list_item` (`paragraph block*`)
 * fills in when an item's real first block is not a paragraph.
 *
 * It matters twice, and both times for the same reason: it is not a paragraph
 * LINE. `itemContentForMarkdown` (plugins/list.ts) normally drops it so the real
 * content rides the marker (`* ## Head`), but it deliberately keeps it before an
 * `hr`, because `* ---` would be a thematic break. The item is then written as a
 * BARE MARKER line, and CommonMark gives an item that begins with a blank line
 * at most that one blank — so forcing such an item loose orphans everything
 * after it out of the list entirely. There is no hazard to trade against: an
 * empty paragraph has no text for a dash run to underline.
 *
 * `leavesParagraphOpen` in webview/utils/minimalDiff.ts carries the same rule at
 * the line level ("bare marker: an empty item"). Dropping it here was a real
 * regression, caught by the `a thematic break` rows of tightItemSpacing.test.ts.
 */
const isEmptyParagraph = (node: FlowNode): boolean =>
    node.type === "paragraph" && (node.children?.length ?? 0) === 0;

/**
 * mdast types whose LAST source line leaves a construct open, so a line written
 * directly beneath them — with no blank between — is read as more of that
 * construct instead of as a new block.
 *
 *   - `table` — a GFM table runs to the first blank line or interrupting block,
 *     so any line that cannot interrupt it becomes another ROW.
 *   - `blockquote` / `callout` / `list` — their last paragraph is still open and
 *     sits in a DEEPER container than the item, so a line at the item's own
 *     indent reaches it only as lazy continuation, and laziness cannot start a
 *     block. (A second `>` line under a quote is worse: the two quotes fuse.)
 *   - `containerDirective` — its closing `:::` is an ordinary paragraph line to
 *     the parser (plugins/directives.ts models directives as fence-shaped
 *     paragraphs), so it leaves a paragraph open exactly like prose does.
 *   - `footnoteDefinition` — `[^1]: text` is a container whose content is an
 *     open paragraph, so it absorbs exactly like the others here.
 *
 * `paragraph` is deliberately absent: mdast's own join already blank-separates
 * a paragraph from another paragraph, a definition, and a setext heading, and
 * every other construct genuinely interrupts a paragraph — including a GFM
 * table, whose delimiter row promotes only its own header line. The two cases
 * that are left are named in `gapMustBeBlank`'s second group.
 *
 * `notionCallout` is NOT here, and its absence is the easy thing to get wrong —
 * it needs the STRONGER rule at the top of `gapMustBeBlank`, not this one.
 */
const ABSORBING_TYPES = new Set([
    "table", "blockquote", "callout", "list", "containerDirective", "footnoteDefinition",
]);

/** The two mdast types this editor uses for a `>` quote block. Two of them
 * glued with no blank between parse back as ONE quote. */
const QUOTE_TYPES = new Set(["blockquote", "callout"]);

// ── Does a paragraph's own TEXT open an HTML block? (MAR-296) ────────────────
//
// A raw HTML block round-trips through this editor as a PARAGRAPH holding an
// `html` phrasing child (`<div>raw</div>` parses to `paragraph > html`), so the
// join hook — which is handed node TYPES — sees `paragraph` and lets the
// serializer glue the next block under it. But an HTML block ends only at a
// blank line, so the glued block is swallowed as raw HTML content and the item
// reopens holding one paragraph where the editor held two blocks. That is
// exactly the `notionCallout` hazard above without a node type to read it off.
//
// The heuristic that suggests itself — "the paragraph's first child is an `html`
// node" — is only a NECESSARY condition, and firing on it alone over-fires
// badly. Measured against the real parser: `<span>x</span> then text`,
// `<b>bold</b> lead-in`, `<pre>x</pre>`, `<!-- c -->` and `<!DOCTYPE html>` all
// have an `html` first child and all open NO block that survives the line, so a
// blank there would make ordinary items with inline HTML go loose against every
// right-hand type. It is a necessary condition, though, and a cheap one: an
// `html` node's bytes are emitted verbatim while a text node's leading `<` is
// escaped (`\<div>`), so no other phrasing child can put a raw `<` at the start
// of the line. That is what gates the byte-level test below.
//
// Conditions 1–5 can be MET on their own start line (`<pre>x</pre>`,
// `<!-- c -->`), which is why each is asked for its end condition rather than
// treated as opening unconditionally. Condition 7 does not interrupt a
// paragraph — but a paragraph's FIRST line is a block start, not an
// interruption, so it applies here and is reachable: a lone `<span>` swallows
// the block after it just like `<div>` does (verified against the parser).

/** Condition 6's block-level tag names, verbatim from the CommonMark spec. */
const HTML_BLOCK_TAGS = new Set([
    "address", "article", "aside", "base", "basefont", "blockquote", "body",
    "caption", "center", "col", "colgroup", "dd", "details", "dialog", "dir",
    "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
    "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header",
    "hr", "html", "iframe", "legend", "li", "link", "main", "menu", "menuitem",
    "nav", "noframes", "ol", "optgroup", "option", "p", "param", "search",
    "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead",
    "title", "tr", "track", "ul",
]);

/** Condition 1: raw-text elements, which end at their own closing tag. */
const RAW_TEXT_START = /^ {0,3}<(?:script|pre|style|textarea)(?:[ \t>]|$)/i;
const RAW_TEXT_END = /<\/(?:script|pre|style|textarea)>/i;
/** Conditions 2–5: comment, processing instruction, declaration, CDATA. */
const COMMENT_START = /^ {0,3}<!--/;
const INSTRUCTION_START = /^ {0,3}<\?/;
const DECLARATION_START = /^ {0,3}<![A-Za-z]/;
const CDATA_START = /^ {0,3}<!\[CDATA\[/;
/** Condition 6: any tag, open or closing, from the list above. */
const BLOCK_TAG_START = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]|\/?>|$)/;
/** Condition 7: a complete open or closing tag, alone on the line. */
const TAG_ATTRIBUTE =
    "(?:\\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\\s*=\\s*(?:[^\"'=<>`\\s]+|'[^']*'|\"[^\"]*\"))?)";
const COMPLETE_TAG_ALONE = new RegExp(
    `^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*${TAG_ATTRIBUTE}*\\s*/?>|</[A-Za-z][A-Za-z0-9-]*\\s*>)[ \\t]*$`,
);

/**
 * Does this line open a CommonMark HTML block that is STILL OPEN at the line's
 * end — so the next line, whatever it is, is absorbed as HTML content?
 *
 * Conditions in the spec's order, first match winning. 1–5 answer their own end
 * condition on the same line; 6 and 7 end only at a blank line, so they always
 * answer yes.
 */
function opensHtmlBlock(line: string): boolean {
    if (RAW_TEXT_START.test(line)) return !RAW_TEXT_END.test(line);
    if (COMMENT_START.test(line)) return !line.includes("-->");
    if (INSTRUCTION_START.test(line)) return !line.includes("?>");
    if (DECLARATION_START.test(line)) return !line.includes(">");
    if (CDATA_START.test(line)) return !line.includes("]]>");
    const tag = BLOCK_TAG_START.exec(line);
    if (tag && HTML_BLOCK_TAGS.has(tag[1].toLowerCase())) return true;
    return COMPLETE_TAG_ALONE.test(line);
}

type SerializerState = {
    handle?: (node: unknown, parent: unknown, state: unknown, info: unknown) => string;
};

/**
 * Memoised per paragraph NODE. `gapMustBeBlank` is asked once per gap and
 * `itemContentGapJoin` re-scans the whole item each time, so a k-child item asks
 * about the same left node O(k) times; the mdast tree is rebuilt on every
 * serialization, so nothing is retained across saves.
 */
const paragraphOpensBlock = new WeakMap<object, boolean>();

/**
 * Does this node serialize to a first line that leaves an HTML block open?
 *
 * The cheap type gate above rules out everything but a paragraph whose bytes
 * genuinely start with a raw `<`; only then is the paragraph serialized (by the
 * serializer's own handler, so the bytes are the ones that will be written) and
 * its first line put to `opensHtmlBlock`. The gap this answers is the only place
 * the decision can be made: `postSerialize` sees the finished document, by which
 * point the item is already glued and telling one item's gap from a fenced-code
 * line would mean re-parsing Markdown in a post-pass.
 *
 * The handler is given the SAME `(parent, state)` the real serialization gives
 * it — `containerFlow` calls it with the list item as parent — so no handler can
 * see a context here it would not see there. `info` carries the tracker's
 * start-of-line position rather than the paragraph's real one, which is why only
 * the FIRST line of the result is read: the item's own indent is applied later,
 * by the list-item handler, and does not change what the line opens.
 */
function opensRawHtmlBlock(node: FlowNode, item: unknown, state: unknown): boolean {
    if (node.type !== "paragraph") return false;
    const first = node.children?.[0] as { type?: string } | undefined;
    if (first?.type !== "html") return false;
    const cached = paragraphOpensBlock.get(node as object);
    if (cached !== undefined) return cached;
    const handle = (state as SerializerState | null)?.handle;
    // Unreachable — mdast-util-to-markdown's `State` always carries `handle` —
    // but the two answers are not equally safe, so the fallback takes the side
    // that cannot lose bytes. Answering false here would silently restore
    // MAR-296 itself: the following block gets absorbed as HTML content and is
    // gone on reopen. Answering true costs at most one item's tightness, and
    // only for a paragraph that already begins with a raw `<` (the gate above).
    // Spacing is recoverable; a swallowed block is not.
    if (typeof handle !== "function") return true;
    const bytes = handle(node, item, state, {
        before: "\n", after: "\n", now: { line: 1, column: 1 }, lineShift: 0,
    });
    const answer = opensHtmlBlock(String(bytes ?? "").split("\n", 1)[0] ?? "");
    paragraphOpensBlock.set(node as object, answer);
    return answer;
}

/**
 * Does this node's FIRST source line begin with prose — carrying no marker that
 * could start a block from an absorbed position?
 *
 * The complement of "can interrupt a paragraph": an ATX heading, a code fence,
 * a `$$` math fence, a `>` quote and a list marker all can, so they are safe
 * glued; a paragraph, a table row, a `[ref]:` definition, a `:::` directive run
 * and a setext underline all cannot, so glued they are swallowed. This is the
 * same fact `glueChangesConstruct` reads at the line level in
 * webview/utils/minimalDiff.ts, asked here of an mdast node instead of bytes.
 *
 * A `thematicBreak` belongs on the safe side of that list with one exception,
 * which is why it is not answered here at all: a DASH-spelled break interrupts
 * everything except a paragraph line, where it is read as a setext underline
 * instead. `gapMustBeBlank`'s second group carries that case.
 */
function beginsWithProseLine(node: FlowNode): boolean {
    switch (node.type) {
        case "paragraph":
        case "table":
        case "definition":
        case "containerDirective":
            return true;
        // A setext heading's first line is its TEXT; only the underline beneath
        // identifies it, and an absorbed underline is not read as one.
        case "heading":
            return node.setext === true && (node.depth ?? 1) < 3;
        default:
            return false;
    }
}

/**
 * Would this list be written with a first number that is NOT 1 (MAR-327)?
 *
 * CommonMark lets an ordered list interrupt a paragraph only when it starts at
 * 1, so `5.` glued beneath an open paragraph line is not a list at all — it is
 * that paragraph's lazy continuation, and the whole list becomes hardbreak-
 * joined text on reopen. `1.` in the same position starts a list normally,
 * which is why this is a property of the START NUMBER and of nothing else.
 * Measured against the parser, at the item's content column and past it:
 * `5.`, `0.` and `10.` are all absorbed, `1.` and `1)` are not, and `5)` is —
 * so the delimiter and the indentation are both irrelevant.
 *
 * `start` is what the PM `order` attr serializes to (plugins/list.ts), and it
 * defaults the same way, so a list with no recorded start is a `1.` list.
 */
function startsAwayFromOne(node: FlowNode): boolean {
    return node.type === "list" && node.ordered === true && (node.start ?? 1) !== 1;
}

/**
 * Must this gap between two of a list item's flow children carry a blank line —
 * i.e. would gluing the two change what the file reparses as?
 *
 * Three groups. The first two are the same fact asked from either side of the
 * gap — `left` leaves a construct open, and `right`'s first line carries no
 * marker that can begin a block from inside it — and the third restates the gaps
 * mdast's own default join already separates, which the whole-item question
 * above has to know about.
 */
function gapMustBeBlank(
    left: FlowNode, right: FlowNode, item: unknown, state: unknown,
): boolean {
    // 0. A Notion `<aside>` is a raw HTML BLOCK, and an HTML block ends only at
    //    a blank line — not at a heading, a fence, a list marker, or anything
    //    else that would interrupt an open paragraph. So it absorbs whatever
    //    follows it REGARDLESS of that block's own first line, and it is the one
    //    left type here that needs an unconditional answer.
    //
    //    Both halves of this were measured, and the asymmetry is the part worth
    //    keeping: putting `notionCallout` in `ABSORBING_TYPES` instead fixes
    //    only its `+ paragraph` and `+ table` gaps and leaves `+ heading`,
    //    `+ list`, `+ fence` and `+ <aside>` corrupt, because those heads are
    //    not prose-shaped; and answering `footnoteDefinition` unconditionally
    //    here would fire on gaps that were never broken. Neither rule covers
    //    both types. Do not "simplify" them into one.
    if (left.type === "notionCallout") return true;
    // 0b. The same hazard with no node type to read it off (MAR-296): a
    //     PARAGRAPH whose own first line opens an HTML block. Unconditional for
    //     the same reason — an HTML block ends only at a blank line — and asked
    //     of the paragraph's BYTES, since `<div>raw</div>` and
    //     `<span>x</span> then text` are the same node shape and only the first
    //     opens anything. See the block above `opensHtmlBlock`.
    if (opensRawHtmlBlock(left, item, state)) return true;
    // 1. An open construct swallows a prose-shaped line; two `>` blocks fuse.
    if (ABSORBING_TYPES.has(left.type ?? "")) {
        if (beginsWithProseLine(right)) return true;
        if (QUOTE_TYPES.has(left.type ?? "") && QUOTE_TYPES.has(right.type ?? "")) return true;
    }
    // 2. A left whose LAST source line is an ordinary paragraph line, in the
    //    item's own container — prose, and a directive's closing `:::`. The
    //    first two arms are ones `glueChangesConstruct` already names at the
    //    merge layer: a `:::` run cannot interrupt a paragraph, so glued under
    //    one it becomes lazy continuation text and the directive is lost; and a
    //    solid dash run glued under a paragraph is a SETEXT UNDERLINE rather
    //    than a thematic break, so `- alpha\n  ---` reopens as a heading. The
    //    dash arm is restricted to a dash-SPELLED rule (`***`/`___` underline
    //    nothing) and to a paragraph-line left for the same reason the merge's
    //    arm excludes quote, list and table lines: under those the run
    //    interrupts and parses as an hr either way. The third arm (2a) is an
    //    ordered list that does not start at 1, which is the same laziness with
    //    a wider left set.
    const proseLeft = (left.type === "paragraph" && !isEmptyParagraph(left))
        || left.type === "containerDirective";
    // 2a. An ordered list that does not start at 1 (MAR-327). It is the only
    //     right-hand type here that a link DEFINITION also absorbs, so the
    //     left set is one wider than the arms below: `[ref]: url` is lifted out
    //     of a content run that the following line joins, so it leaves that run
    //     open exactly as prose does. Measured — a definition glued to a `:::`
    //     directive, a dash rule, a setext heading, a paragraph or a second
    //     definition all reopen intact, so widening the arms below to match
    //     would only loosen items that were never broken.
    if ((proseLeft || left.type === "definition") && startsAwayFromOne(right)) return true;
    if (proseLeft) {
        if (right.type === "containerDirective") return true;
        if (right.type === "thematicBreak" && emitsDashRule(right, state)) return true;
        // 3. Gaps mdast's own default join blank-separates. Restated here
        //    rather than inferred, because the question below is about the
        //    WHOLE item and a gap this one cannot see would make the answer
        //    wrong in the direction that costs bytes.
        if (left.type === "paragraph" && (
            right.type === "paragraph" ||
            right.type === "definition" ||
            (right.type === "heading" && right.setext === true && (right.depth ?? 1) < 3)
        )) return true;
    }
    // NOT an arm: two sibling lists of the same orderedness. They look like the
    // obvious fourth case — glued, they would be one list — but upstream already
    // keeps them apart by ALTERNATING the bullet marker (`- one` then `* two`),
    // and that round-trips. Probed directly, because two sibling lists cannot be
    // authored in Markdown and so no parse-then-tighten fixture can reach the
    // case: a rule here would be one no test could fail.
    return false;
}

/**
 * Space a LIST ITEM's flow children so the file reparses as the document the
 * editor holds (MAR-279).
 *
 * `spread: false` on an item is a claim about RENDERING — "my content needs no
 * `<p>` wrappers" — and mdast-util-to-markdown's default join takes it as a
 * licence to glue arbitrary flow children together. For the shape tightness is
 * actually defined for, a paragraph plus sublists, that is correct and must
 * stay: `- item\n  - sub` is the ordinary outline, and gaining a blank there
 * would turn every nested list in every file loose.
 *
 * Everywhere else the licence is false, because the blank is not spacing — it is
 * the only thing making the second block a block. Pasting a table into the
 * middle of a tight item's text is the easy way to reach it: the item then holds
 * `[paragraph, table, paragraph]` with nothing between them, and reopening
 * absorbs the trailing paragraph as another table ROW. Content changes shape on
 * a save/reopen cycle — a phase-0 fidelity break.
 *
 * The question is asked of the ITEM, not of the gap, and that is the whole
 * design. Markdown has no per-gap spacing inside an item: one blank anywhere in
 * it makes the ITEM loose, so a reopen gives every gap a blank and the next save
 * writes lines the user never touched. Answering per gap produced exactly that —
 * `- it\n  <table>\n\n  em one` on the first save and a blank after `- it` on the
 * second. So if any gap must be blank, they all are; if none must, the item
 * keeps whatever spacing `spread` and mdast's defaults give it, which is what
 * leaves ordinary outlines untouched.
 *
 * A `paragraph` whose TEXT opens an HTML block (`<div>…`, a lone `<span>`) is
 * the one gap here that node types cannot judge, and it is answered from the
 * paragraph's BYTES instead (MAR-296 — `opensRawHtmlBlock` above). It stays a
 * gap question like every other one: the item-wide rule below then decides the
 * item, so an item containing such a paragraph goes loose as a whole rather than
 * gaining one stray blank.
 *
 * Returning `1` forces the blank; returning `undefined` defers to mdast's
 * default, so an item this cannot judge keeps exactly the behaviour it had.
 *
 * The whole-item scan makes this O(k²) in one item's flow children, since the
 * hook is called once per gap. That is deliberate and not on any hot path:
 * serialization runs on the sync scheduler — typing pause, max-wait, or save —
 * never per keystroke (see AGENTS.md, "View→document sync invariant"), and it is
 * already O(document size) when it does run.
 */
function itemContentGapJoin(
    left: unknown, _right: unknown, parent: unknown, state: unknown,
): number | undefined {
    const item = parent as { type?: string; children?: FlowNode[] } | null;
    if (item?.type !== "listItem" || !Array.isArray(item.children)) {
        return undefined;
    }
    // The FIRST gap of an item that opens with an empty paragraph is decided
    // here, never by the whole-item scan below.
    //
    // That scan answers for the item as a unit: if any gap must be blank it
    // returns `1` for every gap. Right for the gaps it reasons about, fatal for
    // this one — a blank here does not merely loosen the item, it orphans the
    // item's ENTIRE content, since CommonMark gives an item beginning with a
    // blank at most that one blank. A raw HTML block anywhere in the item is
    // enough to force it: `- hello` / `<div>raw</div>` / `body` with `hello`
    // deleted reopens as an empty item with both blocks at the top level.
    //
    // The two rules are not in competition — the scan protects a gap BETWEEN
    // two real blocks, this protects the item's grip on all of them — and
    // gluing here costs the scan nothing, because the empty paragraph being
    // glued away contributes no source line for a later block to be absorbed
    // into.
    if (isEmptyParagraph(item.children[0]) && left === item.children[0]) {
        return 0;
    }
    for (let i = 1; i < item.children.length; i++) {
        if (gapMustBeBlank(item.children[i - 1], item.children[i], item, state)) return 1;
    }
    // An item written as a BARE MARKER has to be GLUED, not merely left alone
    // (MAR-306). This hook can force a blank, but the default it defers to can
    // also ADD one — `spread: true` blank-separates every gap — and CommonMark
    // gives an item beginning with a blank line at most that one blank, so
    // everything after it is orphaned OUT of the list. Measured both ways: the
    // editor's `list_item[checked] → paragraph(empty), hr` wrote `-\n\n  ---\n`
    // and reopened with the rule as a TOP-LEVEL sibling, while the glued
    // `-\n  ---\n` reopens as the item that was serialized. `-\n  ---\n` is in
    // fact the only spelling that parses back to this shape at all: authored
    // loose, `-\n\n  ---\n` already parses with the rule outside the list.
    //
    // Applies to ANY item whose first child is an empty paragraph, including
    // one whose second child is a real paragraph (MAR-309). Markdown has no
    // spelling for an empty paragraph, so both options lose something:
    //
    //   `-\n\n  world\n`  the empty paragraph survives as a node, but
    //                     CommonMark orphans `world` OUT of the list and the
    //                     item reopens EMPTY.
    //   `-\n  world\n`    `world` stays the item's own paragraph; the empty
    //                     one is gone.  ← chosen
    //
    // A policy call (maintainer, 2026-08-04), on least-surprise grounds: no
    // editor relocates content out of the container the user put it in as a
    // side effect of deleting adjacent text. Losing an invisible empty
    // paragraph reads as tidying; losing a visible block's list membership
    // reads as a bug, and only surfaces on reopen.
    //
    // Reachable only by EDITING — authored `-\n\n  world\n` already parses with
    // `world` outside the list — so no existing file is re-spelled by this.
    //
    // Reached only after the loop has cleared every gap, so an item that
    // genuinely needs a blank still gets one.
    return isEmptyParagraph(item.children[0]) ? 0 : undefined;
}

/** Would this thematic break be written with `-`? Mirrors the marker choice in
 * `serializeThematicBreak` (plugins/sourceStyle.ts): the node's preserved source
 * marker, or the configured `rule` for one the editor created. */
function emitsDashRule(node: FlowNode, state: unknown): boolean {
    const marker = node.marker;
    if (marker === "*" || marker === "_" || marker === "-") return marker === "-";
    return (state as { options?: { rule?: unknown } } | null)?.options?.rule === "-";
}

/**
 * Apply the stringify options that keep serializer output close to the
 * original file formatting: `-` bullets, `---` rules (instead of `***`), the
 * natural-width table handler, and the per-gap list join.
 */
export function configureSerialization(ctx: EditorCtx): void {
    ctx.update(remarkStringifyOptionsCtx, (prev) => ({
        ...prev,
        bullet: "-" as const,
        rule: "-" as const,
        join: [...(prev.join ?? []), listItemGapJoin, itemContentGapJoin],
        handlers: {
            ...(prev.handlers ?? {}),
            ...sourceStyleHandlers,
            table: serializeTableNoAlign,
        },
    }));
}
