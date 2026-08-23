import { schemaCtx } from "@milkdown/core";
import {
    bulletListSchema,
    orderedListSchema,
} from "@milkdown/preset-commonmark";
import { extendListItemSchemaForTask } from "@milkdown/preset-gfm";
import type { Node as ProseNode } from "../pm";
import { canJoin, Fragment, keymap, Mapping } from "../pm";
import { Decoration, DecorationSet } from "../pm";
import { Plugin, PluginKey, Selection, TextSelection } from "../pm";
import { joinTextblockBackward, liftListItem, undoInputRule } from "../pm";
import { $prose } from "@milkdown/utils";
import { t } from "../i18n";
import {
    isListNode,
    isSameTypeListBoundary,
    joinListBoundary,
    listBoundaryMarkersConflict,
    listMarkerOf,
    listMarkersConflict,
} from "../editing/listMerge";

// ── Parse-time spread coercion (MAR-124) ────────────────────────────────────
//
// The mdast `spread` prop is a real boolean from remark, but Milkdown's stock
// list runners stringify it (`${node.spread}`) before storing it as the PM
// attr, leaving `"true"`/`"false"` on every freshly parsed list. That string
// fails the schema's own `validate: "boolean"` (so `doc.check()` throws on any
// parsed list before a single edit) and skips mdast-util-to-markdown's
// tight-list join on a raw round trip, loosening tight lists. The fidelity
// serializer re-coerces on the way out and `listSpreadNormalizePlugin` fixes
// it on the first edit, but the parsed doc itself was never valid. These
// extended schemas override the parse runner to store a real boolean.
//
// Because that makes the PM `spread` attr a genuine boolean, the ordered_list
// and list_item TOMARKDOWN runners — which hardcode `node.attrs.spread ===
// "true"` — must be overridden too, or they compute `false` for every list
// (`true === "true"` is false) and tighten loose lists on save. bullet_list's
// stock toMarkdown passes the attr through untouched, so it needs no override.
// Registered AFTER the preset so they override the stock definitions (the same
// override-by-registration-order pattern math.ts uses for `code_block`);
// list_item registers after gfm — see its schema doc below.

// ── Per-gap tightness (MAR-194) ─────────────────────────────────────────────
//
// mdast cannot represent a PARTLY loose list: `spread` is one boolean for the
// whole list, so `- a\n- b\n\n- c` and `- a\n\n- b\n- c` parse to identical
// trees (list.spread true, every item spread false) and both re-emit fully
// loose — a blank line between EVERY item. Until an edit, minimal-diff hides
// this by keeping untouched bytes; but an edit that adds or removes a line in
// the list marks the region dirty, and then the loosened canonical form wins
// and gaps the author never wrote appear on disk.
//
// The gap is not actually lost at parse time, though — only `spread` is. Each
// mdast listItem still carries its source `position`, so a blank line between
// two items is exactly `next.start.line - prev.end.line > 1`. We read that on
// the way in, store it per item as `blankBefore`, and emit it on the way out
// through the `join` extension in serialization.ts. `spread` keeps its existing
// meaning and ownership (see the block above); this rides alongside it and only
// decides the separator BETWEEN two items.
//
// Items with no recorded value (editor-created, or any path that doesn't set
// it) leave `blankBefore` undefined on the mdast node.
//
// THE FIRST ITEM IS ALWAYS ONE OF THEM (MAR-210) — the loop below starts at
// index 1, because nothing precedes the first item to measure against. That
// used to mean its gap fell through to mdast's default, and DEFERRING IS NOT
// NEUTRAL: the default is the LIST-level `spread`, the very whole-list boolean
// this annotation exists to stop trusting, and a single interior blank line
// makes it `true`. So a reorder that landed the first item mid-list drew its
// gap from the whole list and invented a blank line — `- a\n- b\n- c\n\n- d`
// with `a` moved down one emitted `- b\n\n- a\n- c\n\n- d`.
//
// There is still no correct value to RECORD for the first item at parse time —
// `false` would wrongly tighten a real gap in a fully loose list, and the honest
// answer depends on where the item ends up. So the answer is made observational
// instead, at the only point that knows where it ended up: `listItemGapJoin`
// (serialization.ts) reads the gap off the item's NEIGHBOURS when it has none
// of its own. That covers every path that can strand a gapless item mid-list —
// a block move, an item inserted above the first one, a paste, an undo — rather
// than only the block-move primitive. A recorded gap still travels with its
// item, so moving an item away and back restores the source bytes exactly
// (enumerated over every item and direction in listSpread.test.ts).

// ── Source marker style (MAR-218) ───────────────────────────────────────────
//
// remark-stringify canonicalizes every list's cosmetic marker choice: bullets
// become the global `bullet` option, ordered items the global `bulletOrdered`,
// and numbering always increments. So `+ a`, `* a`, `1) a` and a lazily
// numbered `1./1./1.` list all came back as `- a` / `1./2./3.`. Protection hid
// that until an edit landed anywhere in the list — protection is all-or-nothing
// per region, so one keystroke in item 2 rewrote the markers on items 1 and 3,
// lines the user never touched.
//
// The three facts (bullet character, ordered delimiter, numbering style) are
// READ from the source by the visitor in plugins/sourceStyle.ts — the only
// place with access to `file.value` — and land on the mdast list node as
// `marker` / `incrementMarker`. This file carries them through ProseMirror,
// because the list schemas are owned here and only one schema per node id wins.
// The serializer side is `serializeList` in plugins/sourceStyle.ts.
//
// Deliberately NOT carried: list INDENT width. Leading whitespace (tab-vs-space
// unit and width) is owned by the minimal-diff merge layer (MAR-213/214); two
// layers deciding indentation independently is how they end up fighting.
//
// A list with no recorded marker — created in the editor, or any path that
// doesn't set one — leaves the attrs null and falls back to the serializer
// defaults (`-`, `1.`, incrementing).

interface ListMdastNode {
    spread?: unknown;
    start?: number;
    label?: unknown;
    children?: unknown;
    position?: { start?: { line?: number }; end?: { line?: number } };
    /** Set by `annotateItemGaps` while parsing the parent list. */
    blankBefore?: boolean;
    /** Bullet character or ordered delimiter, recorded by sourceStyle. */
    marker?: unknown;
    /** `false` when the source repeated ONE number across every item. */
    incrementMarker?: unknown;
}

/** Bullet-list marker characters CommonMark allows. */
const BULLET_MARKERS = new Set(["-", "*", "+"]);

/** The recorded bullet character, or `null` for "no recorded source style". */
function bulletMarkerAttr(node: ListMdastNode): string | null {
    return typeof node.marker === "string" && BULLET_MARKERS.has(node.marker)
        ? node.marker
        : null;
}

/** The recorded ordered delimiter, or `null`. */
function orderedMarkerAttr(node: ListMdastNode): string | null {
    return node.marker === "." || node.marker === ")" ? node.marker : null;
}

/** The recorded numbering style, or `null` when the source didn't state one. */
function incrementMarkerAttr(node: ListMdastNode): boolean | null {
    return typeof node.incrementMarker === "boolean" ? node.incrementMarker : null;
}

/** The mdast boolean spread, or the schema's null-fallback, as a real boolean. */
function spreadBool(node: ListMdastNode, fallback: boolean): boolean {
    return node.spread != null ? Boolean(node.spread) : fallback;
}

/**
 * The last SOURCE line this node's own CONTENT occupies — the deepest last
 * descendant's end line, falling back to the node's own when it has no
 * positioned children (a fence, an html block, a thematic break).
 *
 * AN ITEM'S OWN `position.end.line` IS NOT THAT LINE inside a footnote
 * definition (MAR-211). There, micromark ends each item on the line the NEXT
 * item STARTS on, so consecutive items OVERLAP and the blank between them is
 * swallowed by the earlier one:
 *
 *     1  [^1]: n
 *     2
 *     3      - a      listItem "a"     position 3-5  ← ends on b's START line
 *     4               listItem "b"     position 5-7
 *     5      - b      listItem "c"     position 7-7
 *     6
 *     7      - c      paragraph in a   position 3-3  ← the line `a` really ends on
 *
 * `next.start.line - prev.end.line` is then 0 across a blank the author wrote,
 * so the measurement below read `blankBefore: false` for every gap and the
 * per-gap join pinned the list TIGHT — worse than deferring, because it agreed
 * with the wrong answer confidently.
 *
 * Descending to the last descendant reads the last line the author actually
 * WROTE in that item, which the container shift does not move. It is not a
 * footnote special case: for every other shape probed the two agree, because
 * outside that container an item already ends on its own last content line.
 *
 * The previous item's own `spread` is NOT a usable substitute, tempting as it
 * looks (both `a` and `b` above carry `spread: true`): an item is spread when
 * it holds a blank ANYWHERE, including between two of its own paragraphs with
 * no gap at all before the next item.
 *
 * The descent stops at the LAST child and does not step back over a sibling it
 * cannot place. Position is not guaranteed on every node the parse runner sees
 * — a remark transformer can rebuild children without it, as plugins/callouts.ts
 * records the preset's `remarkLineBreak` doing to a paragraph's inlines — and
 * skipping a positionless node to reach an earlier sibling would report a line
 * ABOVE the content that follows it, measuring a blank the author never wrote.
 * That is the one failure direction that costs bytes rather than spacing, so an
 * unplaceable last child falls back to the node's own end line, which is exactly
 * the behaviour this replaced.
 *
 * Cost is one walk down the last-child chain per gap — bounded by nesting depth,
 * at parse time, on a path that is already O(document size).
 */
function lastContentLine(node: unknown): number | undefined {
    const n = node as ListMdastNode | null;
    const children = n?.children;
    if (Array.isArray(children) && children.length > 0) {
        const line = lastContentLine(children[children.length - 1]);
        if (typeof line === "number") {
            return line;
        }
    }
    const own = n?.position?.end?.line;
    return typeof own === "number" ? own : undefined;
}

/**
 * Record, on each of a list's item children, whether a blank line separated it
 * from the previous item in the SOURCE (MAR-194). Only the parent sees the
 * sibling geometry, so the annotation is written here and read by the list_item
 * parse runner. The first item has no preceding gap inside the list, and an
 * item without usable position info is left undefined — the serializer's join
 * then reads a gap off that item's neighbours instead (MAR-210).
 *
 * The previous item's end comes from `lastContentLine`, not its `position`; see
 * there for the container shape where the two differ (MAR-211).
 */
function annotateItemGaps(children: unknown): void {
    if (!Array.isArray(children)) {
        return;
    }
    for (let i = 1; i < children.length; i++) {
        const prevEnd = lastContentLine(children[i - 1]);
        const start = (children[i] as ListMdastNode)?.position?.start?.line;
        if (typeof prevEnd === "number" && typeof start === "number") {
            (children[i] as ListMdastNode).blankBefore = start - prevEnd > 1;
        }
    }
}

/**
 * Whether a blank line sits between two of this item's OWN children — which is
 * what `spread` on an item is supposed to mean. `undefined` when the geometry
 * cannot be read (a child with no position; see `lastContentLine`).
 */
function hasInternalBlank(item: unknown): boolean | undefined {
    const children = (item as ListMdastNode | null)?.children;
    if (!Array.isArray(children)) {
        return undefined;
    }
    for (let i = 1; i < children.length; i++) {
        const prevEnd = lastContentLine(children[i - 1]);
        const start = (children[i] as ListMdastNode)?.position?.start?.line;
        if (typeof prevEnd !== "number" || typeof start !== "number") {
            return undefined;
        }
        if (start - prevEnd > 1) {
            return true;
        }
    }
    return false;
}

/**
 * Lower an item's `spread` when the source shows no blank line inside it
 * (MAR-302) — the second consumer of the same container shift MAR-211 fixed for
 * the gap BETWEEN items, and one its fix does not close: the raw output is
 * identical before and after it.
 *
 * Inside a footnote definition micromark cannot find the item's trailing line
 * endings (`prepareList`'s backwards walk stops at the definition's continuation
 * prefix), so the blank line that separates the item from the NEXT one falls
 * inside the item's own range and is recorded as an INTERNAL blank —
 * `listItem._spread = true`. mdast-util-to-markdown's default join then
 * blank-separates that item's CHILDREN, so
 *
 *     [^1]: n
 *
 *         - a
 *           - x
 *
 *         - b
 *
 * came back with a blank line between `a` and its own sublist that nobody wrote.
 * Only the item BEFORE a gap is affected, and only when it has a second child
 * for the join to sit between — so a tight footnote list is clean, and so is a
 * loose one whose items hold a single paragraph (enumerated in
 * listSpread.test.ts over container x marker x outer spacing x sublist).
 *
 * Only ever LOWERED, and only against a fully readable geometry. Raising would
 * invent a blank line, the failure direction that costs bytes; refusing to
 * answer leaves exactly the behaviour this replaced. Not a footnote special
 * case — everywhere else micromark and the geometry already agree, measured by
 * diffing the raw serializer output of every corpus fixture with this pass on
 * and off: nothing moved, which is also why footnotes-variants.md now carries
 * the shape.
 *
 * `spread` is also the Tighten/Loosen row's state probe (`listTreeIsLoose`), and
 * inside these containers the LIST-level `spread` is false for the same reason,
 * so this artifact was the only thing left there saying "loose". The probe
 * therefore reads the recorded gap (`blankBefore`) as looseness too — see there.
 */
function correctItemSpread(children: unknown): void {
    if (!Array.isArray(children)) {
        return;
    }
    for (const child of children) {
        const item = child as ListMdastNode;
        if (item?.spread === true && hasInternalBlank(item) === false) {
            item.spread = false;
        }
    }
}

export const bulletListSpreadBoolSchema = bulletListSchema.extendSchema((prev) => (ctx) => {
    const base = prev(ctx);
    return {
        ...base,
        attrs: {
            ...base.attrs,
            // The source bullet character (MAR-218); `null` = editor-created.
            marker: { default: null },
        },
        parseMarkdown: {
            match: base.parseMarkdown.match,
            runner: (state, node, type) => {
                const n = node as ListMdastNode;
                annotateItemGaps(node.children);
                correctItemSpread(node.children);
                state
                    .openNode(type, {
                        spread: spreadBool(n, false),
                        marker: bulletMarkerAttr(n),
                    })
                    .next(node.children)
                    .closeNode();
            },
        },
        // The stock runner passes `spread` through and knows nothing about
        // `marker`, so it needs replacing now that there is a second fact.
        toMarkdown: {
            match: base.toMarkdown.match,
            runner: (state, node) => {
                const marker = node.attrs["marker"];
                state
                    .openNode("list", undefined, {
                        ordered: false,
                        spread: node.attrs["spread"] === true,
                        // Absent, not null, when unrecorded — `serializeList`
                        // then falls back to the configured default.
                        ...(typeof marker === "string" ? { marker } : {}),
                    })
                    .next(node.content)
                    .closeNode();
            },
        },
    };
});

export const orderedListSpreadBoolSchema = orderedListSchema.extendSchema((prev) => (ctx) => {
    const base = prev(ctx);
    return {
        ...base,
        attrs: {
            ...base.attrs,
            // The source delimiter (`.` / `)`) and whether the source numbered
            // its items or repeated one number (MAR-218). `null` = unrecorded.
            marker: { default: null },
            incrementMarker: { default: null },
            // PRESENTATION ONLY, and deliberately absent from toMarkdown below:
            // how the browser draws this list's markers (`lower-alpha`,
            // `lower-roman`, …). CommonMark cannot spell an alpha or roman
            // marker, so writing one would produce a file other tools read as
            // prose; the bytes stay `1.` and only the drawing changes. `null` =
            // let the by-depth cascade decide (utils/orderedMarkers.ts holds
            // the argument; plugins/listNumbering.ts owns the lifecycle).
            numbering: { default: null },
        },
        // The style rides an INLINE `list-style-type`, which beats the
        // by-depth cascade in style.css without needing !important, and which
        // ProseMirror concatenates with the gutter's own `--ol-digits` stamp
        // when both land on the same <ol>.
        toDOM: (node) => {
            const style = node.attrs["numbering"];
            const dom = base.toDOM?.(node);
            if (typeof style !== "string") {
                return dom ?? ["ol", 0];
            }
            // Upstream's spec is `["ol", attrs, 0]`, but only the tag is
            // guaranteed by the DOMOutputSpec type — an attrs-less `["ol", 0]`
            // is equally legal, so read the shape rather than assuming it.
            const spec = Array.isArray(dom) ? [...dom] : ["ol", 0];
            const attrs = spec.length > 1 && typeof spec[1] === "object" && spec[1] !== null
                && !Array.isArray(spec[1])
                ? { ...(spec[1] as Record<string, unknown>) }
                : null;
            const declaration = `list-style-type:${style}`;
            if (attrs) {
                const existing = typeof attrs["style"] === "string" ? `${attrs["style"]};` : "";
                spec[1] = { ...attrs, style: `${existing}${declaration}` };
                return spec as [string, Record<string, unknown>, number];
            }
            return ["ol", { style: declaration }, 0];
        },
        parseMarkdown: {
            match: base.parseMarkdown.match,
            runner: (state, node, type) => {
                const n = node as ListMdastNode;
                annotateItemGaps(node.children);
                correctItemSpread(node.children);
                state
                    .openNode(type, {
                        spread: spreadBool(n, true),
                        order: n.start ?? 1,
                        marker: orderedMarkerAttr(n),
                        incrementMarker: incrementMarkerAttr(n),
                    })
                    .next(node.children)
                    .closeNode();
            },
        },
        toMarkdown: {
            match: base.toMarkdown.match,
            runner: (state, node) => {
                const marker = node.attrs["marker"];
                const increment = node.attrs["incrementMarker"];
                state
                    .openNode("list", undefined, {
                        ordered: true,
                        start: node.attrs["order"] ?? 1,
                        spread: node.attrs["spread"] === true,
                        ...(typeof marker === "string" ? { marker } : {}),
                        ...(typeof increment === "boolean"
                            ? { incrementMarker: increment }
                            : {}),
                    })
                    .next(node.content)
                    .closeNode();
            },
        },
    };
});

/**
 * Drop the empty paragraph that a list item is FORCED to open with when its
 * real content is not a paragraph (MAR-230).
 *
 * `list_item`'s content expression is `paragraph block*`, so an item whose
 * first block is a heading (or a fence, quote, table, nested list) cannot hold
 * that block first: the parser fills an empty paragraph in front of it. The
 * paragraph is a SCHEMA ARTIFACT — it holds nothing, no gesture creates it, and
 * `- # H` and `-\n  # H` parse to the very same node — but the serializer had no
 * way to know that and emitted it, producing a bare marker line with the real
 * content indented beneath:
 *
 *     - normal          - normal
 *       - # H     →       -
 *         body            # H
 *                         body
 *
 * That output does not survive its own reparse, in two independent ways:
 *
 *   - A bare `-` under a paragraph line is a SETEXT HEADING UNDERLINE. `normal`
 *     came back as a heading and the nesting was gone — and this needs no tabs
 *     and no unusual indent units; it is what the canonical all-spaces
 *     serialization does on its own.
 *   - CommonMark derives such an item's content indent from the marker's own
 *     position, so once the marker line carries the file's own indentation
 *     (`\t-`) the content no longer reaches it and the heading reparses as an
 *     indented CODE BLOCK, keeping `# H` only as literal text.
 *
 * Emitting the block on the marker line removes the construct rather than
 * spelling it more carefully, so neither failure has anything left to bite: the
 * output above is byte-identical to its input. Only the artifact is dropped —
 * an item that is genuinely just an empty paragraph (`childCount === 1`) still
 * serializes as the bare marker it is.
 *
 * THREE SHAPES ARE HELD BACK, and each was found by trying to break the rule
 * rather than by reasoning about it — the general form "hoist whatever is
 * there" is wrong in all three:
 *
 *   1. A FOLLOWING PARAGRAPH means the empty one is not an artifact at all. An
 *      item may legally begin with a paragraph, so nothing was filled in: the
 *      empty paragraph is a blank line the author wrote inside the item, and
 *      dropping it deletes a node the document really has (`-\n\n  world` came
 *      back as `- world`). This clause is the load-bearing one — it is what
 *      makes "artifact" a fact about the schema rather than a guess.
 *   2. A THEMATIC BREAK re-lexes when a marker joins it. The marker character
 *      runs into the rule's own characters and the whole line becomes ONE
 *      thematic break — `*` above `***` becomes `* ***` — so the list is gone.
 *      Held back UNCONDITIONALLY here, and released one level up by
 *      `hoistRulesOntoMarkerLine` (plugins/sourceStyle.ts) for the half of the
 *      case that is provably safe: the collision needs the bullet and the rule
 *      to be the same character, and neither the printed bullet nor the flip
 *      that can change it is decided until `serializeList` runs (MAR-240).
 *   3. A NESTED LIST THAT WOULD CONTRIBUTE ONLY MARKERS is the same collision
 *      reached through the markers themselves. Hoisting puts its marker on this
 *      line too, and three or more bullets alone ARE a thematic break: an
 *      outline branch whose three lines have all been emptied serialized to
 *      `- - -` and reopened as a horizontal rule, with the branch destroyed.
 *      A nested list that puts any other character on the line — text, an
 *      image, a heading, a fence — is safe; `ridesMarkerLineSafely` below is
 *      that question, and its own header explains why it is asked of the
 *      first-item chain rather than of the whole subtree.
 *
 * Cases 2 and 3 are one hazard (a line that re-lexes as a rule) and case 1 is a
 * different one (a node that isn't ours to drop); they are kept as separate
 * clauses because they answer separate questions and a reader checking one
 * should not have to reason about the other. All three are pinned in
 * `listMarkerFidelity.test.ts`.
 *
 * ONE CONSEQUENCE OF HOISTING, worth knowing before you touch this: a fence can
 * now OPEN on a marker line (`- ```js`). `classifyLines` in
 * `webview/utils/minimalDiff.ts` had to learn that shape — it was testing its
 * fence regex against the trimStart'd line, so it missed the opener, read the
 * fence's own closing line as an opener, and classified the rest of the document
 * as fence content.
 */
function itemContentForMarkdown(content: Fragment): Fragment {
    if (content.childCount < 2) return content;
    const first = content.firstChild;
    if (first?.type.name !== "paragraph" || first.content.size !== 0) return content;
    const next = content.child(1);
    if (next.type.name === "paragraph") return content;
    if (next.type.name === "hr") return content;
    if (isListNode(next) && !ridesMarkerLineSafely(next)) return content;
    return content.cut(first.nodeSize);
}

/**
 * Can this item's content carry a task checkbox at all (MAR-306)?
 *
 * GFM has no spelling for a checked item with no text. The marker line has to
 * read `- [x] something`: the checkbox is only a checkbox when a paragraph's
 * own text follows it on that line. Measured, every empty spelling loses it —
 * `- [x] ` and `- [x]` both reopen as a PLAIN item whose text is the literal
 * `[x]`, and with a rule under them the `---` then underlines that text into a
 * setext heading.
 *
 * So when the content the serializer is about to write LEADS WITH AN EMPTY
 * PARAGRAPH there is nothing for the checkbox to sit in front of, and the
 * honest output is the plain-bullet form. Upstream's handler
 * (`mdast-util-gfm-task-list-item`) does not ask this. It tests only that the
 * first child is a paragraph — the artifact empty one answers that — and then
 * splices the checkbox in with `value.replace(/^(?:[*+-]|\d+\.)([\r\n]| {1,3})/,
 * …)`, a regex that matches the marker's own NEWLINE when the item has no first
 * line. The checkbox lands on the content's line, before its indent, and takes
 * the document with it:
 *
 *     list_item[checked] → paragraph(empty), hr     "-\n[x] \n  ---\n"
 *       reopens as a plain item plus a heading reading `[x]`; the rule is gone
 *     list_item[checked] → paragraph(empty), para   "-\n[x] \n  body\n"
 *       the PARSER THROWS — a file saved in this state does not reopen at all
 *
 * Both shapes are one keystroke away: emptying the text of a task item that
 * holds a second block reaches them with no command involved.
 *
 * Dropping the checkbox loses the checked bit, which is a real loss — but it is
 * the only one available, and it is already what this path does for every other
 * trailing block (a heading or a fence hoists onto the marker line, so upstream
 * sees a non-paragraph head and writes no checkbox). This makes the answer
 * uniform instead of leaving two shapes to corrupt the file. The editor keeps
 * showing the tick until the document is reopened; that divergence is recorded
 * in MAR-306 rather than papered over here, because normalizing the live
 * document on delete is a command-layer change with its own undo story.
 */
function canSpellCheckbox(content: Fragment): boolean {
    const first = content.firstChild;
    return !(first?.type.name === "paragraph" && first.content.size === 0);
}

/**
 * Would hoisting this nested list onto its parent's marker line put a character
 * on that line which a run of markers or rule characters cannot absorb?
 *
 * Clause 3 above used to ask `textContent === ""`, which is "holds no TEXT" —
 * and a sublist holding only an image, a rule, an empty fence or an empty quote
 * answers that too, so it was refused with the bare-marker hazard left intact
 * (`- normal` above `  - - ![](a.png)` lost the nesting on reopen — MAR-240).
 *
 * The hazard clause 3 exists for is narrower than "no text": a line becomes a
 * THEMATIC BREAK only when every character on it is the SAME marker/rule
 * character (`- - -`). One `!`, `#`, `>`, backtick or letter anywhere on it
 * settles the question for good, whatever the markers turn out to be — which
 * matters, because the bullet each level prints is not decided until
 * `serializeList` runs (plugins/sourceStyle.ts), long after this.
 *
 * So this walks the FIRST-item chain, which is the only part of the sublist that
 * can reach the marker line, and answers `true` only on reaching a block that is
 * certain to print such a character. The three ways down are all refusals:
 *
 *   - no first item, or a first block that is an empty paragraph — the sublist
 *     contributes a BARE MARKER, which is what makes `- - -` in the first place
 *     (an emptied three-deep branch reopened as an `<hr>`, pinned in
 *     `listMarkerFidelity.test.ts`);
 *   - a thematic break — its characters may be the markers' own (`- - ---` is
 *     five dashes). `serializeList` releases the safe half of that case one
 *     level up, where the two characters are finally both known; here they are
 *     not, so this refuses rather than guessing;
 *   - a deeper list — recurse, since the same question applies to it.
 *
 * `itemContentForMarkdown` is asked for the inner item's content rather than
 * reading its children directly, so this sees the same hoisting the serializer
 * will do. The mutual recursion terminates: each step descends one list level.
 */
function ridesMarkerLineSafely(list: ProseNode): boolean {
    const item = list.firstChild;
    if (!item) return false;
    const first = itemContentForMarkdown(item.content).firstChild;
    if (!first) return false;
    if (first.type.name === "hr") return false;
    if (isListNode(first)) return ridesMarkerLineSafely(first);
    if (first.type.name === "paragraph") return first.content.size > 0;
    return true;
}

/**
 * `list_item` is owned by preset-gfm, not commonmark: gfm's
 * `extendListItemSchemaForTask` re-registers it (adding the task-list `checked`
 * attr) AFTER commonmark, so this must layer on top of GFM's task schema —
 * preserving `checked` and the task parseDOM/toDOM — and register AFTER gfm to
 * win (schema registration is last-wins per node id).
 *
 * The runners below started as GFM's own with one change (a real boolean
 * `spread` on both sides, MAR-124) and have since grown three
 * (RE-DIFF ON EVERY MILKDOWN UPGRADE):
 *
 *   1. `blankBefore` — whether the SOURCE put a blank line before this item —
 *      is threaded through both directions (MAR-194/MAR-210). Upstream has no
 *      such attr; this is the bulk of the divergence now.
 *   2. A `<input type=checkbox>` parseDOM rule ahead of the stock ones, so
 *      task lists pasted from a rendered page keep their ticks (MAR-21).
 *   3. The `canSpellCheckbox` guard on serialize, so an item whose content
 *      cannot carry a checkbox does not get one.
 *
 * The `spread` coercion that named this schema is now belt-and-braces: as of
 * Milkdown 7.22.0 (#2419, #2423) upstream's own runners store a real boolean.
 */
export const listItemSpreadBoolSchema = extendListItemSchemaForTask.extendSchema(
    (prev) => (ctx) => {
        const base = prev(ctx);
        return {
            ...base,
            // The stock default is `spread: true`, so every item created via
            // default attrs (turn-into, the `- ` input rule's wrap) was born
            // LOOSE. Parse runners always set spread explicitly, so the
            // default only ever governs editor-created items — and a fresh
            // item should be TIGHT, the overwhelming convention (the old
            // aggressive normalizer masked this; force-only normalization
            // would preserve the wrong default forever).
            attrs: {
                ...base.attrs,
                spread: { default: false, validate: "boolean" },
                // Whether the SOURCE put a blank line before this item (MAR-194).
                // `null` = unknown — an editor-created item, and ALWAYS the
                // first item of a list; the serializer's join then reads the gap
                // off this item's neighbours (MAR-210) rather than pinning one
                // it never had recorded.
                blankBefore: { default: null },
            },
            // PASTE fidelity (MAR-21 item 2): GFM's own rule reads `checked`
            // only from `data-checked`, which is what OUR toDOM writes — but
            // rendered task lists in the wild (GitHub, Notion, any Markdown
            // renderer) mark an item with a real `<input type="checkbox">`
            // instead, so pasting one dropped every tick and the list arrived
            // as plain bullets. Tried FIRST and returns false for any `li`
            // without a checkbox, so ordinary list items fall through to the
            // stock rules untouched.
            parseDOM: [
                {
                    tag: "li",
                    getAttrs: (dom: HTMLElement | string) => {
                        if (typeof dom === "string") { return false; }
                        const box = dom.querySelector("input[type=checkbox]");
                        // Only THIS item's own checkbox — a nested sublist's
                        // must not re-mark the parent.
                        if (!box || box.closest("li") !== dom) { return false; }
                        return { checked: (box as HTMLInputElement).checked };
                    },
                },
                ...(base.parseDOM ?? []),
            ],
            parseMarkdown: {
                match: base.parseMarkdown.match,
                runner: (state, node, type) => {
                    const n = node as ListMdastNode & { checked?: unknown };
                    const label = n.label != null ? `${n.label}.` : "•";
                    const listType = n.label != null ? "ordered" : "bullet";
                    const spread = spreadBool(n, true);
                    // Written by the parent list's runner (annotateItemGaps).
                    const blankBefore = typeof n.blankBefore === "boolean" ? n.blankBefore : null;
                    const attrs =
                        n.checked == null
                            ? { label, listType, spread, blankBefore }
                            : { label, listType, spread, blankBefore, checked: Boolean(n.checked) };
                    state.openNode(type, attrs).next(node.children).closeNode();
                },
            },
            toMarkdown: {
                match: base.toMarkdown.match,
                runner: (state, node) => {
                    const spread = node.attrs["spread"] === true;
                    const blankBefore = node.attrs["blankBefore"];
                    // Only pass a real boolean through; anything else leaves the
                    // prop absent, which is what tells `listItemGapJoin` to read
                    // the gap off this item's neighbours (MAR-194/MAR-210).
                    const gap =
                        typeof blankBefore === "boolean" ? { blankBefore } : undefined;
                    const content = itemContentForMarkdown(node.content);
                    if (node.attrs["checked"] == null || !canSpellCheckbox(content)) {
                        state.openNode("listItem", undefined, { spread, ...gap })
                            .next(content)
                            .closeNode();
                    } else {
                        state
                            .openNode("listItem", undefined, {
                                label: node.attrs["label"],
                                listType: node.attrs["listType"],
                                spread,
                                ...gap,
                                checked: node.attrs["checked"],
                            })
                            .next(content)
                            .closeNode();
                    }
                },
            },
        };
    },
);

// ── The task checkbox, for assistive tech (MAR-403) ─────────────────────────
//
// A task item's tick is drawn entirely in CSS: `li[data-item-type="task"]`
// carries `data-checked` and its box and glyph are `::before`/`::after` with
// `content: ""`. None of that reaches the accessibility tree, and neither does
// the `text-decoration: line-through` on a done item's paragraph, so a done
// task and an open one are byte-identical to anything reading the tree.
//
// The control below is what a screen reader reads instead: one real element
// per task item, carrying `role="checkbox"` and `aria-checked`, sitting inside
// the item beside the paragraph. It has no ink of its own; the drawn design is
// untouched.
//
// It is a WIDGET DECORATION rather than markup from the schema's `toDOM`, and
// that is forced rather than chosen. ProseMirror's `renderSpec` refuses a spec
// whose content hole has a sibling ("Content hole must be the only child of its
// parent node"), so `toDOM` can only reach the `li`'s own attributes; giving
// the content its own wrapper element to make room would move every `li > …`
// selector in the tree (the gutter, the fold chrome, the done-item strike) off
// its target.
//
// Putting the role on the `li` itself, which is the obvious cheaper move, was
// measured in both engines and is worse than the gap it closes. `role=checkbox`
// is name-from-contents and children-presentational, so the item stops being a
// listitem, its accessible name absorbs everything inside it (the block-options
// button's own label included), and a parent task's nested sub-list is folded
// into that name instead of being a list. `aria-checked` on the `li` with no
// role is simply dropped, by Chromium and WebKit alike.
//
// FOCUS is deliberately left alone: no `tabindex`, and the control is inert to
// the pointer. The chord (`toggleTaskChecked`) and the click on the drawn box
// already operate the checkbox from both surfaces, and a focusable control
// inside `contenteditable` fights the caret for a gesture nobody is missing.
// The consequence is that a toggle is not announced on the spot; the state is
// there to be read, not spoken as it changes.

/** Class on the offscreen control; `webview/style.css` positions it. */
const TASK_CHECKBOX_A11Y_CLASS = "task-check-a11y";

/** The offscreen control for one task item. Exported for tests. */
export function taskCheckboxA11yDom(checked: boolean): HTMLElement {
    const box = document.createElement("span");
    box.className = TASK_CHECKBOX_A11Y_CLASS;
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", checked ? "true" : "false");
    // Named, so it is not an anonymous checkbox. The state is `aria-checked`'s
    // job, never the name's: a name that said "done" would go stale the moment
    // the widget's DOM was reused.
    box.setAttribute("aria-label", t("Task"));
    box.contentEditable = "false";
    return box;
}

/** One task item: where it starts, and whether it is ticked. */
interface TaskItemMark {
    pos: number;
    checked: boolean;
}

/**
 * Every task item in `doc`, in document order.
 *
 * The walk prunes at textblocks, which hold every text and inline node in a
 * document and can contain no list item, so it visits the block skeleton
 * rather than the document. It runs once per doc-changing transaction, which
 * is why it is worth the prune: gfm's own `keepTableAlignPlugin` used to walk
 * the whole document unpruned on the same schedule, and that is the cost
 * MAR-137 removed.
 */
function taskItemMarks(doc: ProseNode): TaskItemMark[] {
    const marks: TaskItemMark[] = [];
    doc.descendants((node, pos) => {
        if (node.isTextblock) { return false; }
        const checked = node.attrs["checked"];
        if (node.type.name === "list_item" && typeof checked === "boolean") {
            marks.push({ pos, checked });
        }
        return true;
    });
    return marks;
}

/**
 * Where the control for a task item goes: just inside the item, the position
 * the item's own block-handle gutter is a widget at.
 */
function taskCheckboxPos(mark: TaskItemMark): number {
    return mark.pos + 1;
}

/**
 * Whether the controls built for `previous`, carried through this
 * transaction's mapping, land on exactly `marks`.
 *
 * When they do, mapping the old set forward is not an optimistic shortcut: it
 * is the same answer a rebuild would give, for a fraction of the work.
 * Rebuilding means a `Decoration` per task item plus a `DecorationSet.create`,
 * which walks the whole document again to build its tree, and the typing
 * fixture this runs against on every keystroke holds hundreds of task items.
 *
 * The mapping is asked the same question ProseMirror asks of a widget it is
 * mapping itself: `mapResult` with the widget's own `side` as the association,
 * and a deleted result means the control is gone. Reproducing that rule here
 * is what makes "the mapped set is right" a fact rather than a hope, and it is
 * what catches the case a comparison of ticks alone would miss — one item
 * deleted and another with the same tick inserted in the same transaction,
 * which leaves the sequence of ticks identical and the new item with no
 * control at all.
 *
 * The landing position is compared rather than derived. A deleted control is
 * the only way this is known to come apart, and an argument that nothing else
 * can shuffle the items without deleting one is an argument that has to hold
 * for every future edit primitive; asking where the controls actually landed
 * costs one comparison and needs no such argument.
 */
function taskCheckboxesSurvive(
    mapping: Mapping,
    previous: readonly TaskItemMark[],
    marks: readonly TaskItemMark[],
): boolean {
    if (previous.length !== marks.length) { return false; }
    for (let i = 0; i < marks.length; i++) {
        const was = previous[i]!;
        const now = marks[i]!;
        if (was.checked !== now.checked) { return false; }
        const mapped = mapping.mapResult(taskCheckboxPos(was), -1);
        if (mapped.deleted || mapped.pos !== taskCheckboxPos(now)) { return false; }
    }
    return true;
}

function taskCheckboxDecorations(doc: ProseNode, marks: readonly TaskItemMark[]): DecorationSet {
    if (marks.length === 0) { return DecorationSet.empty; }
    return DecorationSet.create(
        doc,
        marks.map((mark) =>
            Decoration.widget(taskCheckboxPos(mark), () => taskCheckboxA11yDom(mark.checked), {
                // Negative, matching the item's block-handle gutter at this
                // same position: a widget must sort before the caret rather
                // than after it, or WebKit re-anchors an insertion point that
                // has nothing but widgets in front of it.
                side: -1,
                // The state is IN the key, so a tick re-renders the control
                // instead of reusing DOM that still says `aria-checked`
                // whatever it said before.
                key: `task-a11y:${mark.checked ? "x" : "o"}`,
                ignoreSelection: true,
            })
        ),
    );
}

interface TaskCheckboxA11yState {
    /** The items the current set was built for, in document order. */
    marks: readonly TaskItemMark[];
    decorations: DecorationSet;
}

function buildTaskCheckboxA11y(doc: ProseNode): TaskCheckboxA11yState {
    const marks = taskItemMarks(doc);
    return { marks, decorations: taskCheckboxDecorations(doc, marks) };
}

const taskCheckboxA11yKey = new PluginKey<TaskCheckboxA11yState>("MD_TASK_CHECKBOX_A11Y");

/**
 * Publishes the offscreen checkbox for every task item. Registered with the
 * `list_item` schema override (listItemSpreadBoolPlugins), because it is about
 * the same node and must see gfm's `checked` attr.
 */
export const taskCheckboxA11yPlugin = $prose(
    () =>
        new Plugin<TaskCheckboxA11yState>({
            key: taskCheckboxA11yKey,
            state: {
                init: (_config, state) => buildTaskCheckboxA11y(state.doc),
                apply: (tr, previous) => {
                    if (!tr.docChanged) { return previous; }
                    const marks = taskItemMarks(tr.doc);
                    if (!taskCheckboxesSurvive(tr.mapping, previous.marks, marks)) {
                        return { marks, decorations: taskCheckboxDecorations(tr.doc, marks) };
                    }
                    // The same controls, carried to where the edit put them.
                    // The map is not optional: a DecorationSet is a tree shaped
                    // to the document it was built from, and one kept across an
                    // edit describes a document that no longer exists, so its
                    // controls stop resolving onto the items they belong to. An
                    // EMPTY set maps to itself, which is what makes this free
                    // for a document with no task list in it.
                    return { marks, decorations: previous.decorations.map(tr.mapping, tr.doc) };
                },
            },
            props: {
                decorations(state) {
                    return taskCheckboxA11yKey.getState(state)?.decorations ?? DecorationSet.empty;
                },
            },
        }),
);

/**
 * bullet_list / ordered_list overrides, flattened for pureCommonmark (they
 * replace the stock commonmark schemas — see listSpreadReplacedPlugins). The
 * list_item override ships separately (listItemSpreadBoolPlugins) because it
 * must register after gfm.
 */
export const listSpreadBooleanPlugins = [
    bulletListSpreadBoolSchema,
    orderedListSpreadBoolSchema,
].flat();

/**
 * The `list_item` layer that must register AFTER gfm (see the schema doc
 * above): the schema override itself, plus the task item's accessibility
 * control, which reads the `checked` attr that override carries.
 */
export const listItemSpreadBoolPlugins = [
    listItemSpreadBoolSchema,
    taskCheckboxA11yPlugin,
].flat();

/**
 * The stock commonmark list schemas the bullet/ordered overrides replace.
 * `pureCommonmark` filters these out before adding `listSpreadBooleanPlugins`
 * so only the overriding schemas register — the ProseMirror parser reads one
 * parseMarkdown runner per node id from the winning schema, so a stock schema
 * left in place would drop the source `marker` and the item gaps our runners
 * record. (list_item is not here:
 * gfm re-registers it after commonmark, so the list_item override wins by
 * registering after gfm instead of by filtering.) Same pattern as
 * sourceStyle/tableBreaks.
 */
export const listSpreadReplacedPlugins = new Set<unknown>([
    bulletListSchema.ctx,
    bulletListSchema.node,
    orderedListSchema.ctx,
    orderedListSchema.node,
]);

/**
 * After joinTextblockBackward merges a nested item's first paragraph into the
 * previous line, the joined item can survive as a paragraph-less SHELL
 * holding only its old sublist — one level deeper than the user's mental
 * model of "the children follow the line up":
 *
 *   item[ p("bazjuj"), ul[ item[ ul[rex…] ] ] ]   ←  `- bazjuj / - / - rex`
 *
 * Unwrap it in the same transaction (one undo step): the shell's inner list
 * items replace the shell, so the subtree sits directly under the merged
 * line. A no-op whenever the join left no shell.
 */
function spliceJoinShell(tr: any, listItemType: any): void {
    const { $from } = tr.selection;
    const itemDepth = $from.depth - 1;
    if (itemDepth < 1 || $from.node(itemDepth).type !== listItemType) {
        return;
    }
    const item = $from.node(itemDepth);
    if (item.childCount < 2) {
        return;
    }
    const sublist = item.child(1);
    if (!isListNode(sublist)) {
        return;
    }
    const shell = sublist.firstChild;
    if (!shell || shell.type !== listItemType) {
        return;
    }
    // The shell survives in one of two forms: only its old sublist, or an
    // EMPTY leftover paragraph followed by the sublist.
    let inner = null;
    if (shell.childCount === 1 && isListNode(shell.firstChild)) {
        inner = shell.firstChild;
    } else if (
        shell.childCount === 2 &&
        shell.firstChild?.isTextblock &&
        shell.firstChild.content.size === 0 &&
        isListNode(shell.child(1))
    ) {
        inner = shell.child(1);
    }
    if (!inner) {
        return;
    }
    const shellPos = $from.start(itemDepth) + item.child(0).nodeSize + 1;
    tr.replaceWith(shellPos, shellPos + shell.nodeSize, inner.content);
}

function isEmptyListItem(item: any): boolean {
    return (
        item.childCount === 1 &&
        item.firstChild?.type.name === "paragraph" &&
        item.firstChild.content.size === 0
    );
}

// List Backspace: a NESTED item's start joins onto the previous visible line
// — the item break is deleted like a text editor joining lines, and the
// item's own sublist re-parents one level up (maintainer ruling 2026-07-23:
// outdent-per-press dragged whole subtrees through every level and read as
// unpredictable). A TOP-LEVEL item keeps the classic behavior: an empty item
// is deleted, a non-empty one lifts out of the list as a paragraph
// (Backspace "removes the bullet"). Cmd+Backspace shares the handler, so
// delete-to-line-start on an already-empty item falls through to the same
// join/delete instead of doing nothing.
export const listLiftPlugin = $prose((ctx) => {
    const schema = ctx.get(schemaCtx);
    const listItemType = schema.nodes["list_item"];
    if (!listItemType) {
        return new Plugin({});
    }
    const doLift = liftListItem(listItemType);
    const deleteEmptyListItem = (state: any, dispatch: any): boolean => {
        const { selection } = state;
        if (!selection.empty) {
            return false;
        }
        const { $from } = selection;
        if ($from.parentOffset !== 0) {
            return false;
        }

        let listItemDepth = -1;
        for (let d = $from.depth; d >= 0; d--) {
            if ($from.node(d).type === listItemType) {
                listItemDepth = d;
                break;
            }
        }
        if (listItemDepth < 0) {
            return false;
        }
        const item = $from.node(listItemDepth);
        const list = $from.node(listItemDepth - 1);
        if (!isEmptyListItem(item) || list.childCount <= 1) {
            return false;
        }

        if (dispatch) {
            const from = $from.before(listItemDepth);
            const to = $from.after(listItemDepth);
            const itemIndex = $from.index(listItemDepth - 1);
            const tr = state.tr.delete(from, to);
            const targetPos = itemIndex > 0 ? Math.max(0, from - 1) : Math.min(from, tr.doc.content.size);
            tr.setSelection(TextSelection.near(tr.doc.resolve(targetPos), itemIndex > 0 ? -1 : 1));
            dispatch(tr);
        }
        return true;
    };

    const backspaceAtItemStart = (state: any, dispatch: any): boolean => {
        const { selection } = state;
        if (!selection.empty) {
            return false;
        }
        const { $from } = selection;
        if ($from.parentOffset !== 0) {
            return false;
        }

        let listItemDepth = -1;
        for (let d = $from.depth; d >= 0; d--) {
            if ($from.node(d).type === listItemType) {
                listItemDepth = d;
                break;
            }
        }
        if (listItemDepth < 0) {
            return false;
        }

        // A nested item (its list's parent is itself a list item) joins onto
        // the previous visible line: the item break is deleted, like a text
        // editor joining lines, and the item's own subtree moves one level up
        // with it. Top-level items skip this (a join would fuse two sibling
        // bullets' text; lifting to a paragraph is the established "remove
        // the bullet" gesture there).
        const nested =
            listItemDepth >= 2 && $from.node(listItemDepth - 2).type === listItemType;
        if (nested) {
            // The join target is the deepest textblock ending before this
            // item. Joining is only predictable into a PARAGRAPH: into a
            // code block it would pour the item's prose verbatim INTO the
            // code (one keystroke silently converting content — a fidelity
            // hazard), so any other target falls through to the lift below.
            const $beforeItem = state.doc.resolve($from.before(listItemDepth));
            const target = Selection.near($beforeItem, -1).$from.parent;
            if (
                target !== $from.parent &&
                target.type.name === "paragraph" &&
                joinTextblockBackward(state, dispatch && ((tr: any) => {
                    spliceJoinShell(tr, listItemType);
                    dispatch(tr);
                }))
            ) {
                return true;
            }
        }

        if (deleteEmptyListItem(state, dispatch)) {
            return true;
        }

        return doLift(state, dispatch);
    };

    return keymap({
        // A list marker the user JUST typed is undone first, restoring the
        // characters rather than acting on the item the rule created. Milkdown's
        // base keymap chains undoInputRule ahead of its own Backspace commands
        // for exactly this, but every list input rule leaves the caret at
        // parentOffset 0 — where this handler answers first and would lift the
        // brand-new item instead, leaving no way to say "I meant text". It
        // declines unless the LAST transaction was an input rule, so nothing
        // else about Backspace changes.
        //
        // Deliberately NOT on Mod-Backspace below: delete-to-line-start is a
        // deletion the user asked for by name, and answering it with an undo
        // would be a different action than the one they pressed.
        Backspace: (state, dispatch) =>
            undoInputRule(state, dispatch) || backspaceAtItemStart(state, dispatch),
        // Delete-to-line-start with nothing left to delete: same join/delete
        // as Backspace (the handler only ever acts at parentOffset 0, so a
        // mid-line Cmd+Backspace still reaches the DOM's own deletion).
        "Mod-Backspace": backspaceAtItemStart,
        Delete: deleteEmptyListItem,
    });
});

// Enter on an EMPTY list item: never leave the empty item behind (Slack /
// Google Docs behavior). A nested empty item outdents exactly one level per
// press; a top-level empty item exits the list and becomes an empty paragraph
// after it (liftListItem splits the list when the item sits in the middle).
// Non-empty items fall through to the default split behavior. Task-list items
// are the same list_item node type (with a `checked` attr in preset-gfm), so
// they are covered too. "Empty" = a single empty paragraph and nothing else;
// an empty paragraph with a nested sublist below is NOT empty.
export const listEnterPlugin = $prose((ctx) => {
    const schema = ctx.get(schemaCtx);
    const listItemType = schema.nodes["list_item"];
    if (!listItemType) {
        return new Plugin({});
    }
    const doLift = liftListItem(listItemType);

    return keymap({
        Enter: (state, dispatch, view) => {
            // Never intercept while an IME composition is in progress.
            if (view?.composing) {
                return false;
            }
            const { selection } = state;
            if (!selection.empty) {
                return false;
            }
            const { $from } = selection;
            if ($from.parent.type.name !== "paragraph") {
                return false;
            }

            let listItemDepth = -1;
            for (let d = $from.depth; d >= 0; d--) {
                if ($from.node(d).type === listItemType) {
                    listItemDepth = d;
                    break;
                }
            }
            if (listItemDepth < 0) {
                return false;
            }
            if (!isEmptyListItem($from.node(listItemDepth))) {
                return false;
            }

            return doLift(state, dispatch);
        },
    });
});

// ── Auto-join of edit-created adjacent lists ────────────────────────────────
//
// Two sibling lists of the same type only exist when the SOURCE split them
// deliberately (a `-`→`*` marker change — markdown merges blank-line-separated
// same-marker lists at parse time) or when an EDIT made them adjacent:
// deleting the paragraph between two lists, moving a list next to another,
// converting the block between them. Left split, the pair reads as two blocks
// (double flow gap, two gutter handles) and the serializer makes the split
// PERMANENT by alternating the second list's bullet marker (`bulletOther`).
//
// Policy: adjacency the user's own edit created is merged automatically — the
// user deleted the separator, so one list is the natural reading — while a
// split the author can SPELL is theirs and is NEVER auto-merged (the block
// menu's Merge rows and the caret advisory offer that merge explicitly
// instead). Two tests tell those apart, and both must pass before a boundary
// is touched: the old-doc probe below, which asks whether the edit created
// this adjacency at all, and `listMarkersConflict`, which asks whether the two
// lists disagree about their marker. The second is what bounds the mandate to
// the artifact that motivates it — a pair spelling the SAME marker is the pair
// the serializer would alternate apart, and a pair already spelling different
// ones round-trips as the two lists it is. Undo/redo and external file syncs
// are exempt: both restore document states and must not be "corrected".
export const listAutoJoinPlugin = $prose(() => {
    return new Plugin({
        key: new PluginKey("MD_LIST_AUTO_JOIN"),
        appendTransaction(transactions, oldState, newState) {
            if (!transactions.some((tr) => tr.docChanged)) return null;
            for (const tr of transactions) {
                // Undo/redo must restore the split it recorded; addToHistory:
                // false marks state restoration too (external sync rewrites,
                // unfurl swaps) — none of it is a user edit to interpret.
                if (tr.getMeta("history$") || tr.getMeta("addToHistory") === false) {
                    return null;
                }
            }

            // The changed range in final-doc coordinates (the
            // listSpreadNormalizePlugin pattern, including its clamp note).
            let minFrom = newState.doc.content.size;
            let maxTo = 0;
            for (const tr of transactions) {
                if (!tr.docChanged) continue;
                for (const step of tr.steps) {
                    step.getMap().forEach((_os, _oe, newStart, newEnd) => {
                        if (newStart < minFrom) minFrom = newStart;
                        if (newEnd > maxTo) maxTo = newEnd;
                    });
                }
            }
            const docSize = newState.doc.content.size;
            minFrom = Math.max(0, Math.min(minFrom, docSize));
            maxTo = Math.min(maxTo, docSize);
            if (minFrom > maxTo) return null;

            // Candidate boundaries: a list in (or straddling) the changed
            // range whose NEXT sibling is a list of the same type. The ±1
            // widening matters for the pure-deletion case, where the changed
            // range collapses to a point exactly on the boundary — an
            // edge-exclusive nodesBetween would visit neither list.
            const boundaries: number[] = [];
            newState.doc.nodesBetween(
                Math.max(0, minFrom - 1),
                Math.min(docSize, maxTo + 1),
                (node, pos, parent, index) => {
                    if (node.isTextblock) return false; // lists never nest in textblocks
                    if (!isListNode(node)) return true;
                    const next = parent?.maybeChild(index + 1);
                    if (
                        next?.type === node.type &&
                        !listMarkersConflict(listMarkerOf(node), listMarkerOf(next))
                    ) {
                        boundaries.push(pos + node.nodeSize);
                    }
                    return true; // descend: nested sublists can be adjacent too
                },
            );
            if (boundaries.length === 0) return null;

            // Fidelity gate: keep only adjacency the edit CREATED. A boundary
            // that maps back onto a same-type list boundary in the old doc was
            // already split there — the file's own structure.
            //
            // Unless that old split was a MARKER split and this edit made the
            // two markers agree. The adjacency is then as new as a deleted
            // separator's: `- a`/`+ b` is two lists a file can spell, `+ a`/`+ b`
            // is not, and leaving it split makes the serializer alternate the
            // second list's bullet — rewriting a line the user never touched,
            // and losing the character they did type (MAR-337). Both facts are
            // about the OLD doc, because both describe what the edit changed.
            const mapping = new Mapping();
            for (const tr of transactions) mapping.appendMapping(tr.mapping);
            const inverted = mapping.invert();
            const fresh = [...new Set(boundaries)].filter((b) => {
                const was = inverted.map(b);
                return (
                    !isSameTypeListBoundary(oldState.doc, was) ||
                    listBoundaryMarkersConflict(oldState.doc, was)
                );
            });
            if (fresh.length === 0) return null;

            // Ascending order, each boundary mapped through the joins above
            // it and its marker pair re-read as it stands THEN. A join keeps
            // the upper list's marker, so once `- a` has absorbed a marker-
            // less list, the boundary below is `-` against whatever follows;
            // read pairwise on the original doc, a marker-less list in the
            // middle bridges a `-` list to a `*` list and the split the
            // author spelled is gone.
            const tr = newState.tr;
            let joined = false;
            for (const b of fresh.sort((x, y) => x - y)) {
                const pos = tr.mapping.map(b);
                if (canJoin(tr.doc, pos) && !listBoundaryMarkersConflict(tr.doc, pos)) {
                    joinListBoundary(tr, pos);
                    joined = true;
                }
            }
            return joined ? tr : null;
        },
    });
});

/**
 * Whether Markdown REQUIRES this item loose: a paragraph following another
 * block inside the item would lazy-merge into it if serialized tight (byte
 * loss on reparse). A trailing nested list — or any non-paragraph block —
 * is legal tight markdown. The one spread rule every surface shares: the
 * normalizer's force floor and the Tighten command's keep-list.
 */
function itemRequiresSpread(item: any): boolean {
    let needs = false;
    item.forEach((child: any, _offset: number, index: number) => {
        if (index >= 1 && child.type.name === "paragraph") {
            needs = true;
        }
    });
    return needs;
}

/** Whether the list tree at `listPos` serializes loose anywhere — any list
 * or item in it carrying spread, or any recorded source gap. The Tighten/Loosen
 * row's state probe. */
export function listTreeIsLoose(doc: any, listPos: number): boolean {
    const list = doc.nodeAt(listPos);
    if (!list || !isListNode(list)) {
        return false;
    }
    let loose = list.attrs.spread === true;
    list.descendants((n: any, _pos: number, _parent: any, index: number) => {
        if (
            (isListNode(n) || n.type.name === "list_item") &&
            n.attrs.spread === true
        ) {
            loose = true;
        }
        // A RECORDED SOURCE GAP IS LOOSENESS TOO (MAR-302). `spread` alone is
        // not the whole answer inside a container the list-spread inference
        // cannot see through: both a footnote definition and a blockquote leave
        // the LIST-level `spread` false for a list the author spaced with blank
        // lines between its items, so the row offered "Loosen List" on an
        // already-loose blockquote list — and for a footnote one the only thing
        // answering "loose" was the very item-`spread` artifact
        // `correctItemSpread` now clears.
        //
        // The FIRST item's gap is skipped, exactly as `listItemGapJoin`
        // (serialization.ts) skips it: nothing precedes it, so a `blankBefore`
        // it still carries describes a position in the list it LEFT, and this
        // list never emits it.
        if (n.type.name === "list_item" && index >= 1 && n.attrs.blankBefore === true) {
            loose = true;
        }
        return !loose;
    });
    return loose;
}

/**
 * Sets the tight/loose CHARACTER of the whole list tree at `listPos` — the
 * one sanctioned way the editor changes it (the normalizer below is
 * force-only, so it never will). Tightening keeps any item Markdown
 * requires loose (see itemRequiresSpread); loosening marks every list and
 * item spread. Nested sublists follow the same setting; attr-only steps, so
 * original-doc positions stay valid and it's one undo step. Returns false
 * when `listPos` is not a list or nothing needed changing.
 */
export function setListTreeSpread(view: any, listPos: number, loose: boolean): boolean {
    const { state } = view;
    const list = state.doc.nodeAt(listPos);
    if (!list || !isListNode(list)) {
        return false;
    }
    const tr = state.tr;
    const apply = (node: any, pos: number): void => {
        let anyItemLoose = false;
        let offset = pos + 1;
        node.forEach((item: any) => {
            const itemLoose = loose || itemRequiresSpread(item);
            // Drop a source-recorded gap that CONTRADICTS the requested spacing
            // (MAR-194): the user has explicitly overridden the file, so a
            // parsed `blankBefore` must not outvote this action. A gap that
            // already agrees is left alone, so a no-op call stays a no-op.
            const gapContradicts =
                typeof item.attrs.blankBefore === "boolean" &&
                item.attrs.blankBefore !== itemLoose;
            if (item.attrs.spread !== itemLoose || gapContradicts) {
                tr.setNodeMarkup(offset, undefined, {
                    ...item.attrs,
                    spread: itemLoose,
                    blankBefore: gapContradicts ? null : item.attrs.blankBefore,
                });
            }
            if (itemLoose) {
                anyItemLoose = true;
            }
            let childOffset = offset + 1;
            item.forEach((child: any) => {
                if (isListNode(child)) {
                    apply(child, childOffset);
                }
                childOffset += child.nodeSize;
            });
            offset += item.nodeSize;
        });
        const listLoose = loose || anyItemLoose;
        if (node.attrs.spread !== listLoose) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, spread: listLoose });
        }
    };
    apply(list, listPos);
    if (tr.steps.length === 0) {
        return false;
    }
    view.dispatch(tr);
    return true;
}

// List spread normalization — FORCE-ONLY, by maintainer ruling (2026-07-24,
// "the editor never changes a list's tight/loose character"): spread is
// raised to true where Markdown REQUIRES a blank line (a paragraph following
// another block inside an item would lazy-merge on reparse — byte loss), and
// never lowered. Tight/loose is the author's call — it changes the RENDERED
// output (loose items get <p> wrapping downstream), so auto-"cleanup" both
// rewrote diffs and silently altered published pages. Deliberate cleanup is
// the explicit Tighten/Loosen List command (setListSpread below).
// Only list nodes inside the actually-changed range are examined, so editing
// a table doesn't touch list spacing across the whole document.
export const listSpreadNormalizePlugin = $prose((ctx) => {
    const schema = ctx.get(schemaCtx);
    return new Plugin({
        appendTransaction(transactions, _oldState, newState) {
            if (!transactions.some((tr) => tr.docChanged)) return null;

            let minFrom = newState.doc.content.size;
            let maxTo = 0;
            for (const tr of transactions) {
                if (!tr.docChanged) continue;
                for (const step of tr.steps) {
                    step.getMap().forEach((_os, _oe, newStart, newEnd) => {
                        if (newStart < minFrom) minFrom = newStart;
                        if (newEnd > maxTo) maxTo = newEnd;
                    });
                }
            }
            // Per-step coordinates are NOT mapped through later steps, so a
            // multi-step transaction that shrinks the doc (a mark input rule
            // deleting its `**`/`==` markers near the end) can leave maxTo
            // past the final doc — clamp before nodesBetween or it throws.
            const docSize = newState.doc.content.size;
            minFrom = Math.max(0, Math.min(minFrom, docSize));
            maxTo = Math.min(maxTo, docSize);
            if (minFrom > maxTo) return null;

            const tr = newState.tr;
            let changed = false;

            newState.doc.nodesBetween(minFrom, maxTo, (node, pos) => {
                if (
                    node.type !== schema.nodes.bullet_list &&
                    node.type !== schema.nodes.ordered_list
                ) {
                    return;
                }
                let listNeedsSpread = false;
                let offset = 1;
                node.forEach((item) => {
                    // Force-only: raise to true when required, otherwise
                    // keep the author's character.
                    const target = itemRequiresSpread(item) || item.attrs.spread === true;
                    if (item.attrs.spread !== target) {
                        tr.setNodeMarkup(pos + offset, undefined, {
                            ...item.attrs,
                            spread: target,
                        });
                        changed = true;
                    }
                    if (target) listNeedsSpread = true;
                    offset += item.nodeSize;
                });
                const listTarget = listNeedsSpread || node.attrs.spread === true;
                if (node.attrs.spread !== listTarget) {
                    tr.setNodeMarkup(pos, undefined, {
                        ...node.attrs,
                        spread: listTarget,
                    });
                    changed = true;
                }
            });
            return changed ? tr : null;
        },
    });
});
