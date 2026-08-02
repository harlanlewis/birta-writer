/**
 * Markdown serialization configuration, shared by the editor and by the
 * round-trip tests so both exercise the exact same serializer behavior.
 */
import { remarkStringifyOptionsCtx, type Editor } from "@milkdown/core";
import { commonmark, remarkPreserveEmptyLinePlugin } from "@milkdown/preset-commonmark";
import { gfm, keepTableAlignPlugin as upstreamKeepTableAlignPlugin } from "@milkdown/preset-gfm";
import { calloutsPlugin } from "./plugins/callouts";
import { directivesPlugin } from "./plugins/directives";
import { createFidelitySerializerPlugin } from "./plugins/fidelitySerializer";
import { highlightPlugin } from "./plugins/highlight";
import { listItemSpreadBoolPlugins, listSpreadBooleanPlugins, listSpreadReplacedPlugins } from "./plugins/list";
import { imageStringAttrPlugins, imageStringAttrReplacedPlugins } from "./plugins/image";
import { strikethroughHtmlPlugins, strikethroughHtmlReplacedPlugins } from "./plugins/pasteHtml";
import { linkBoundaryPlugins } from "./plugins/linkBoundary";
import { notionCalloutNodes, notionCalloutRemark } from "./plugins/notionCallouts";
import { referenceLinksPlugin } from "./plugins/referenceLinks";
import { reparseHazardPlugin } from "./plugins/reparseHazard";
import { keepTableAlignPlugin } from "./plugins/keepTableAlign";
import { tableAlignDefaultPlugin } from "./plugins/tableAlignDefault";
import { wikiLinksPlugin } from "./plugins/wikiLinks";
import { mathPlugin } from "./plugins/math";
import { headingInputReplacedPlugins } from "./plugins/headingInput";
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
 * Markdown's fidelity serializer: the vendored, patched `SerializerState`
 * (plugins/fidelitySerializer.ts — a format-agnostic factory) instantiated
 * with markdown's whole-document post-pass (above). Bound here, inside the
 * preset, so every construction site — production editor.ts and every test
 * factory — serializes with the pass by construction (the MAR-143 argument).
 * This binding is the SINGLE source of truth for the pass: the FormatModule
 * deliberately declares no separate post-pass member (see the charter in
 * webview/format/types.ts).
 */
const fidelitySerializerPlugin = createFidelitySerializerPlugin(postSerialize);

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
 * `fidelitySerializerPlugin` (built above from plugins/fidelitySerializer.ts)
 * swaps the stock `SerializerState` for a vendored, patched copy that keeps a
 * link containing bold/italic/code children serialized as ONE link instead of
 * several adjacent same-URL links, and defers emphasis edge-space trimming
 * until after adjacent mark segments have merged. It carries markdown's
 * whole-document post-pass (org-cookie unescape) as an injected hook.
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
    fidelitySerializerPlugin,
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
 * One gfm plugin is REPLACED rather than overridden: `keepTableAlignPlugin`
 * has no override seam — a plugin's `appendTransaction` can only be dropped by
 * dropping the plugin — and ours carries its own `PluginKey`, so leaving
 * upstream's in place would not error, it would just run BOTH and keep paying
 * the per-keystroke whole-document walk this replaces (MAR-137 — the charter,
 * the measurement and the two corrections are in `plugins/keepTableAlign.ts`).
 * The filter matches by identity rather than by key name, so an upstream
 * rename surfaces as `keepTableAlign.test.ts` going red rather than as both
 * plugins silently running again.
 */
export const gfmFidelity = [
    gfm.filter((plugin) =>
        plugin !== upstreamKeepTableAlignPlugin
        && !strikethroughHtmlReplacedPlugins.has(plugin)),
    keepTableAlignPlugin,
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
 * `undefined` — for any item without a recorded boolean, i.e. anything the
 * editor created — defers to mdast's default, so this can only ever pin a gap
 * the author wrote and never invents tightness for new content.
 */
function listItemGapJoin(left: unknown, right: unknown, parent: unknown): number | undefined {
    const l = left as { type?: string } | null;
    const r = right as { type?: string; blankBefore?: unknown } | null;
    if ((parent as { type?: string } | null)?.type !== "list") {
        return undefined;
    }
    if (l?.type !== "listItem" || r?.type !== "listItem") {
        return undefined;
    }
    return typeof r.blankBefore === "boolean" ? (r.blankBefore ? 1 : 0) : undefined;
}

type FlowNode = {
    type?: string;
    marker?: unknown;
    setext?: unknown;
    depth?: number;
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
 * Must this gap between two of a list item's flow children carry a blank line —
 * i.e. would gluing the two change what the file reparses as?
 *
 * Three groups. The first two are the same fact asked from either side of the
 * gap — `left` leaves a construct open, and `right`'s first line carries no
 * marker that can begin a block from inside it — and the third restates the gaps
 * mdast's own default join already separates, which the whole-item question
 * above has to know about.
 */
function gapMustBeBlank(left: FlowNode, right: FlowNode, state: unknown): boolean {
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
    // 1. An open construct swallows a prose-shaped line; two `>` blocks fuse.
    if (ABSORBING_TYPES.has(left.type ?? "")) {
        if (beginsWithProseLine(right)) return true;
        if (QUOTE_TYPES.has(left.type ?? "") && QUOTE_TYPES.has(right.type ?? "")) return true;
    }
    // 2. A left whose LAST source line is an ordinary paragraph line, in the
    //    item's own container — prose, and a directive's closing `:::`. Both
    //    arms are ones `glueChangesConstruct` already names at the merge layer:
    //    a `:::` run cannot interrupt a paragraph, so glued under one it becomes
    //    lazy continuation text and the directive is lost; and a solid dash run
    //    glued under a paragraph is a SETEXT UNDERLINE rather than a thematic
    //    break, so `- alpha\n  ---` reopens as a heading. The dash arm is
    //    restricted to a dash-SPELLED rule (`***`/`___` underline nothing) and
    //    to a paragraph-line left for the same reason the merge's arm excludes
    //    quote, list and table lines: under those the run interrupts and parses
    //    as an hr either way.
    if ((left.type === "paragraph" && !isEmptyParagraph(left))
        || left.type === "containerDirective") {
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
 * DELIBERATELY NOT COVERED, and re-scoped rather than guessed at: a `paragraph`
 * whose TEXT opens an HTML block (`<div>…`, `<table>…`) swallows every following
 * line to the next blank, exactly as `notionCallout` does. That one cannot be
 * answered here, because it is a property of the paragraph's serialized content
 * rather than of its node type — and a first-child-is-html heuristic would fire
 * on ordinary inline HTML (`<span>x</span> then prose`, which opens no block)
 * against every right-hand type, turning `paragraph` into an absorbing tail for
 * the whole matrix. Filed as MAR-296. `notionCallout` is the same hazard with a
 * node type attached, which is why it IS fixed above.
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
    _left: unknown, _right: unknown, parent: unknown, state: unknown,
): number | undefined {
    const item = parent as { type?: string; children?: FlowNode[] } | null;
    if (item?.type !== "listItem" || !Array.isArray(item.children)) {
        return undefined;
    }
    for (let i = 1; i < item.children.length; i++) {
        if (gapMustBeBlank(item.children[i - 1], item.children[i], state)) return 1;
    }
    return undefined;
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
