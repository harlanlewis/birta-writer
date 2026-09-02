/**
 * webview/plugins/headingFold/foldDecorations.ts
 *
 * The decoration pass: per-block gutter widgets and host classes (top-level
 * blocks, container children, list items — recursively), the hidden-range
 * node decorations for collapsed folds, the `…` ellipsis widgets, and the
 * structural fingerprint that lets the plugin position-MAP a cached
 * DecorationSet across edits instead of rebuilding it.
 */
import type { EditorView } from "../../pm";
import { Decoration, DecorationSet } from "../../pm";
import { isOrderedNumbering, orderedMarkerText } from "../../utils/orderedMarkers";
import {
    blockMarkerSpec,
    createBlockGutter,
    leafAnchorName,
    createHeadingFoldGutter,
    createStubEllipsis,
    foldKeyPart,
    headingGutterSpec,
    isLeafBlock,
    itemMarkerSpec,
    nestedChildSpec,
    type GutterFoldInfo,
} from "./foldGutter";
import {
    blockFoldExtent,
    cachedFoldRanges,
    getHeadingLevel,
    isContainerNode,
    isFirstLineContainerNode,
    isFoldableKindNode,
    isHeadingNode,
    isListNode,
    listItemHasDescendants,
    type HeadingFoldRange,
} from "./foldModel";
import { countWork } from "../../perf";

/**
 * Marker for ONE block nested inside a container or a list item, recursively
 * (a callout inside a callout is grabbable at every depth): a list gets its
 * per-item markers; any other block gets its nested-child marker and recurses
 * into its own container children. `depth` is the block's container-nesting
 * level (accent bars to its left) — it drives the marker's gutter column
 * (--nested-gutter-depth) and is part of the widget identity, so a block that
 * re-nests re-renders rather than reusing the old widget. Shared by
 * emitContainerChildGutters and emitItemGutters (MAR-88).
 */
function emitNestedChildGutter(
    child: any,
    childPos: number,
    decorations: Decoration[] | null,
    parts: string[] | null,
    foldCtx: { folded: ReadonlySet<number>; enabled: boolean },
    depth: number,
    // Whether this subtree sits inside a LIST ITEM, where nothing but the
    // items themselves carries fold chrome (foldModel's chrome-parity gate).
    // Structural, so the gate costs no doc.resolve here.
    inListItem: boolean,
): void {
    if (isListNode(child)) {
        // A list directly inside a container clears that container's bar(s):
        // its items inherit the container depth (MAR-89). List nesting itself
        // adds no bar, so deeper lists keep the same depth.
        parts?.push("L");
        emitItemGutters(child, childPos, decorations, parts, foldCtx, depth);
        return;
    }
    const fold = blockFoldInfo(child, childPos, foldCtx, inListItem);
    const spec = nestedChildSpec(child);
    if (spec !== null) {
        const foldKey = foldKeyPart(fold);
        const leaf = isLeafBlock(child) ? leafAnchorName(childPos) : undefined;
        parts?.push(`c${depth}${spec.key}${foldKey}`);
        decorations?.push(
            Decoration.node(childPos, childPos + child.nodeSize, {
                class: `block-gutter-host block-gutter-host--child block-gutter-host--d${Math.min(depth, 6)}${leaf ? " block-gutter-host--leaf" : ""}${fold?.collapsed ? " collapsed" : ""}`,
                ...(leaf ? { style: `anchor-name: ${leaf}` } : {}),
            }),
        );
        decorations?.push(
            Decoration.widget(
                childPos + 1,
                (view: EditorView) => createBlockGutter(view, spec, depth, fold ?? undefined, leaf),
                // A leaf widget's key carries its anchor name (position-
                // keyed), so a rebuild that renames the host never reuses a
                // gutter still pointing at the old name.
                { key: `g:${spec.key}:n${depth}${foldKey}${leaf ? `:${leaf}` : ""}`, side: -1 },
            ),
        );
    } else {
        parts?.push("·");
    }
    if (decorations && isCollapsedFirstLine(child, fold)) {
        emitFirstLineFold(child, childPos, decorations);
    }
    if (isContainerNode(child)) {
        emitContainerChildGutters(child, childPos, decorations, parts, foldCtx, depth + 1, inListItem);
    }
}

/**
 * Markers for a container's direct block children, recursively (a callout
 * inside a callout is grabbable at every depth) — lists inside containers
 * get their per-item markers too. Appends into `decorations` and `parts`
 * (fingerprint), mirroring emitItemGutters.
 */
function emitContainerChildGutters(
    container: any,
    containerPos: number,
    decorations: Decoration[] | null,
    parts: string[] | null,
    foldCtx: { folded: ReadonlySet<number>; enabled: boolean },
    depth = 1,
    inListItem = false,
): void {
    container.forEach((child: any, offset: number) => {
        emitNestedChildGutter(
            child,
            containerPos + 1 + offset,
            decorations,
            parts,
            foldCtx,
            depth,
            inListItem,
        );
    });
}

/**
 * Fold info for a foldable non-heading block's gutter (callout, table, code
 * block, container directive, footnote definition, blockquote, Notion aside
 * — MAR-110/125/116), or null for everything else, for everything inside a
 * LIST ITEM (the chrome-parity gate: no fold chrome there, so no chevron),
 * and for everything while `editor.folding` is off — zero fold chrome.
 *
 * Foldability is blockFoldExtent's answer, not a second list of per-kind
 * body probes: a chevron the model refuses is a control that does nothing
 * when clicked, which is what a nested callout's used to be.
 */
function blockFoldInfo(
    node: any,
    pos: number,
    foldCtx: { folded: ReadonlySet<number>; enabled: boolean },
    inListItem: boolean,
): GutterFoldInfo | null {
    if (!foldCtx.enabled || inListItem || !isFoldableKindNode(node) || isHeadingNode(node)) {
        return null;
    }
    return { foldable: blockFoldExtent(node, pos) !== null, collapsed: foldCtx.folded.has(pos) };
}

/** Whether a block is a COLLAPSED chrome-less container, the state whose
 * content decorations emitFirstLineFold draws. (A list item is the same
 * grammar but reaches the helper through emitItemGutters, which already
 * holds its own fold info.) */
function isCollapsedFirstLine(node: any, fold: GutterFoldInfo | null): boolean {
    return Boolean(fold?.collapsed && fold.foldable && isFirstLineContainerNode(node));
}

/**
 * A first-line fold's content decorations: every child after the block's own
 * first line hidden, and that line trailed by the shared `…` chip (clicking
 * it expands). The hidden children keep their own decorations; display:none
 * on the blocks suppresses them wholesale. Shared by list items and the
 * chrome-less containers (blockquote, Notion aside), which fold identically.
 */
function emitFirstLineFold(node: any, pos: number, decorations: Decoration[]): void {
    const hiddenCount = node.childCount - 1;
    node.forEach((child: any, offset: number, index: number) => {
        if (index === 0) {
            return;
        }
        const childPos = pos + 1 + offset;
        decorations.push(
            Decoration.node(childPos, childPos + child.nodeSize, {
                class: "heading-fold-hidden",
            }),
        );
    });
    decorations.push(
        Decoration.widget(
            pos + 1 + node.firstChild.nodeSize - 1,
            (view: EditorView) => createStubEllipsis(view, hiddenCount),
            { key: `e:i:${hiddenCount}`, side: 1 },
        ),
    );
}

/**
 * Per-item block handles (MAR-86): every list item — at any nesting depth —
 * is its own grabbable unit with its own glyph. The list node itself carries
 * no marker (whole-list operations are reachable by selecting all items).
 * `listPos` is the list node's document position; items' positions are
 * derived from it. Appends into `decorations` and `parts` (fingerprint).
 *
 * MAR-125: items with descendants (anything beyond their first child block)
 * carry the fold chevron; a collapsed item hides those descendant blocks
 * and trails its first line with the shared `…` chip — heading-section
 * semantics applied to list nesting, siblings never affected.
 */
function emitItemGutters(
    listNode: any,
    listPos: number,
    decorations: Decoration[] | null,
    parts: string[] | null,
    foldCtx: { folded: ReadonlySet<number>; enabled: boolean },
    // Number of accent-bar containers (callout/blockquote/directive) enclosing
    // this list (0 = top-level list). Threaded so item markers step clear of
    // every ancestor's colored bar instead of straddling it (MAR-89).
    containerDepth = 0,
): void {
    // MAR-90: an ordered list's right-aligned ::marker ink widens leftward with
    // its widest number, so stamp that number's digit count on the <ol> for the
    // grabber-offset calc(). Only for multi-digit lists — single-digit lists (the
    // common case) keep the default and add no decoration or fingerprint churn.
    if (listNode.type.name === "ordered_list") {
        const start = (listNode.attrs["order"] ?? 1) as number;
        const maxNum = start + Math.max(listNode.childCount - 1, 0);
        // The stamp is a WIDTH in characters, not a digit count, and a styled
        // list's widest marker is not its widest number: eight items of
        // lower-roman end at `viii`, four characters where `8` is one. Reading
        // the marker the browser will actually draw keeps the grabber clear of
        // it (utils/orderedMarkers.ts).
        const numbering = listNode.attrs["numbering"];
        const digits = isOrderedNumbering(numbering)
            ? orderedMarkerText(Math.max(maxNum, 1), numbering).length
            : String(Math.max(maxNum, 1)).length;
        if (digits > 1) {
            parts?.push(`old${digits}`);
            decorations?.push(
                Decoration.node(listPos, listPos + listNode.nodeSize, {
                    style: `--ol-digits:${digits}`,
                }),
            );
        }
    }
    listNode.forEach((item: any, offset: number) => {
        const itemPos = listPos + 1 + offset;
        const spec = itemMarkerSpec(listNode, item);
        const fold: GutterFoldInfo | null = foldCtx.enabled
            ? { foldable: listItemHasDescendants(item), collapsed: foldCtx.folded.has(itemPos) }
            : null;
        const foldKey = foldKeyPart(fold);
        // Depth is part of the marker's identity (it moves the gutter column),
        // so a list re-nesting into/out of a container re-renders its items'
        // widgets rather than reusing the mispositioned old ones.
        const depthKey = containerDepth > 0 ? `c${containerDepth}` : "";
        parts?.push(`i${spec.key}${foldKey}${depthKey}`);
        const collapsed = Boolean(fold?.collapsed && fold.foldable);
        decorations?.push(
            Decoration.node(itemPos, itemPos + item.nodeSize, {
                class: `block-gutter-host block-gutter-host--item${collapsed ? " collapsed" : ""}`,
            }),
        );
        decorations?.push(
            Decoration.widget(
                itemPos + 1,
                (view: EditorView) => {
                    const gutter = createBlockGutter(view, spec, undefined, fold ?? undefined);
                    // MAR-89: a list nested inside a container steps its item
                    // markers one inset per container level clear of every
                    // ancestor's accent bar — the same margin-column convention
                    // container children use, keeping the marker off the bar.
                    if (containerDepth > 0) {
                        gutter.style.setProperty("--item-container-depth", String(containerDepth));
                    }
                    return gutter;
                },
                { key: `g:${spec.key}${foldKey}${depthKey}`, side: -1 },
            ),
        );
        if (collapsed && decorations) {
            emitFirstLineFold(item, itemPos, decorations);
        }
        // The item's continuation content (everything after its first line).
        // Nested lists are unit-bearing lists of their own at the SAME
        // container depth (list nesting adds no accent bar). Every other block
        // child (blockquote, callout, code block, table, nested heading —
        // list_item content is `paragraph block*`) is a grabbable unit too
        // (MAR-88), one nesting level deeper than the list's container context,
        // so its marker clears into the item's margin column like a
        // container's children. childOffset 0 is the item's own first line —
        // the item marker is its handle, so it gets no separate marker.
        item.forEach((child: any, childOffset: number) => {
            const childPos = itemPos + 1 + childOffset;
            if (isListNode(child)) {
                emitItemGutters(child, childPos, decorations, parts, foldCtx, containerDepth);
            } else if (childOffset > 0) {
                emitNestedChildGutter(
                    child,
                    childPos,
                    decorations,
                    parts,
                    foldCtx,
                    containerDepth + 1,
                    true,
                );
            }
        });
    });
}

/**
 * The slice(s) of the document whose gutter chrome is materialized (MAR-215):
 * the scroll window, plus the caret's own block when the caret has wandered
 * outside it. `null` means "the whole document" — the answer with no layout
 * engine (jsdom) and the behavior every consumer had before windowing.
 *
 * Positions are document coordinates and are position-MAPPED by the plugin
 * across edits, so a window stays anchored to the content it was measured
 * against. Order and disjointness are irrelevant: the test below is
 * "overlaps ANY range", and there are at most two.
 */
export type ChromeWindows = readonly HeadingFoldRange[] | null;

/**
 * A cursor over the folded set that answers "does any fold entry live inside
 * this top-level block?" in amortized O(1) while walking blocks in ascending
 * order. A block containing a fold entry is ALWAYS materialized, in or out of
 * window: the `collapsed` class it carries is what hides a callout's or list
 * item's body (and drives the callout NodeView), so dropping it off-screen
 * would silently expand the block and change the document's scroll height.
 */
function foldCursor(folded: ReadonlySet<number>, enabled: boolean): (from: number, to: number) => boolean {
    if (!enabled || folded.size === 0) {
        return () => false;
    }
    const sorted = [...folded].sort((a, b) => a - b);
    let index = 0;
    return (from, to) => {
        while (index < sorted.length && sorted[index]! < from) {
            index++;
        }
        return index < sorted.length && sorted[index]! < to;
    };
}

/** Whether a top-level block overlaps any materialized window. */
function inWindows(windows: ChromeWindows, from: number, to: number): boolean {
    if (windows === null) {
        return true;
    }
    for (const w of windows) {
        if (to > w.from && from < w.to) {
            return true;
        }
    }
    return false;
}

/**
 * A cheap structural summary of everything the decorations depend on: per
 * top-level block its rendered identity (glyph, or heading level + collapsed
 * + foldable). While this string is unchanged across an edit, the cached
 * decoration set is merely position-MAPPED — widget DOM survives, nothing is
 * rebuilt. (Positions are deliberately absent: gutterBlockPos derives them at
 * interaction time, so shifted widgets never go stale.)
 *
 * Summarizes exactly the blocks `buildHeadingFoldDecorations` materializes for
 * the same window, so the two can never disagree about what is rendered. That
 * makes an edit OUTSIDE the window structurally invisible — correct, because
 * such an edit changes no decoration; the window's own moves force a rebuild
 * through the plugin's window meta instead.
 */
export function structureFingerprint(
    doc: any,
    folded: ReadonlySet<number>,
    ranges: Map<number, HeadingFoldRange | null>,
    enabled: boolean,
    windows: ChromeWindows = null,
): string {
    const foldCtx = { folded, enabled };
    const parts: string[] = [enabled ? "E" : "D"];
    const hasFold = foldCursor(folded, enabled);
    // Every top-level block is visited, window or not: the window decides
    // what is EMITTED, not what is walked. Counted so the per-keystroke and
    // nightly gates see this pass whenever a transaction reaches it.
    countWork("fold-structure", { blocks: doc.childCount });
    doc.forEach((node: any, offset: number) => {
        const end = offset + node.nodeSize;
        const folds = hasFold(offset, end);
        if (!folds && !inWindows(windows, offset, end)) {
            return;
        }
        parts.push(blockFingerprintPart(node, offset, folded, enabled, enabled && Boolean(ranges.get(offset))));
    });
    return parts.join("|");
}

/**
 * ONE top-level block's contribution to the structure fingerprint: what its
 * gutter chrome depends on, and nothing about its neighbours except, for a
 * heading, whether it owns a section (`foldable`, which the caller reads off
 * the fold ranges or computes for that heading alone). The fold plugin's
 * leaf-edit path compares this for the edited block before and after, which
 * is what lets it skip the whole-document pass without ever returning stale
 * chrome: a code block gaining its first character becomes foldable, a
 * paragraph gaining a caption beside its image changes glyph, and both show
 * up here. Cost is proportional to the block (a list's items), never the
 * document.
 */
export function blockFingerprintPart(
    node: any,
    offset: number,
    folded: ReadonlySet<number>,
    enabled: boolean,
    foldable: boolean,
): string {
    const foldCtx = { folded, enabled };
    if (isHeadingNode(node)) {
        const collapsed = enabled && folded.has(offset);
        return headingGutterSpec(getHeadingLevel(node), collapsed, foldable).key;
    }
    if (isListNode(node)) {
        const parts: string[] = ["L"];
        emitItemGutters(node, offset, null, parts, foldCtx);
        return parts.join("|");
    }
    const fold = blockFoldInfo(node, offset, foldCtx, false);
    const parts = [`${blockMarkerSpec(node)?.key ?? "·"}${foldKeyPart(fold)}`];
    if (isContainerNode(node)) {
        emitContainerChildGutters(node, offset, null, parts, foldCtx);
    }
    return parts.join("|");
}

export function buildHeadingFoldDecorations(
    doc: any,
    folded: ReadonlySet<number>,
    enabled: boolean,
    windows: ChromeWindows = null,
): DecorationSet {
    const decorations: Decoration[] = [];
    const collapsedSections: { pos: number; node: any; range: HeadingFoldRange }[] = [];
    const ranges = cachedFoldRanges(doc);
    const foldCtx = { folded, enabled };
    const hasFold = foldCursor(folded, enabled);

    // Every top-level block is visited, window or not; the window decides
    // what is emitted. Counted beside the fingerprint's pass so a transaction
    // that reaches a rebuild is visible to the gates as growth.
    countWork("fold-build", { blocks: doc.childCount });
    doc.forEach((node: any, offset: number) => {
        const end = offset + node.nodeSize;
        // Out-of-window blocks get no gutter chrome (MAR-215). Blocks that own
        // a fold entry are never skipped — see foldCursor — and the
        // content-hiding pass below stays document-wide regardless, so a
        // collapsed section off screen keeps hiding its body.
        if (!hasFold(offset, end) && !inWindows(windows, offset, end)) {
            return;
        }
        const section = blockChrome(node, offset, decorations, folded, enabled, ranges);
        if (section) {
            collapsedSections.push(section);
        }
    });

    if (collapsedSections.length > 0) {
        // A collapsed heading hides its section's blocks and says so with its
        // gutter chevron alone. It used to also trail the shared `…` chip; the
        // chip was removed because beside heading type it read as content
        // rather than as chrome, and the chevron it sat next to was already
        // saying the same thing more quietly. The chevron takes a resident,
        // filled treatment while collapsed (style.css) so it carries the state
        // on its own.
        //
        // Scope, deliberately: this is the HEADING chip only. createStubEllipsis
        // still serves list items, blockquotes and asides, and the code block,
        // table, callout and directive NodeViews mount their own - for several
        // of those the chip is the only collapsed affordance there is, since
        // they have no gutter chevron to promote.
        doc.forEach((node: any, offset: number) => {
            for (const section of collapsedSections) {
                if (offset >= section.range.from && offset < section.range.to) {
                    decorations.push(
                        Decoration.node(offset, offset + node.nodeSize, {
                            class: "heading-fold-hidden",
                        }),
                    );
                    return;
                }
            }
        });
    }

    return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/**
 * The gutter chrome of ONE top-level block, pushed onto `decorations`: a
 * heading's fold gutter, a list's per-item markers, or the block marker plus
 * a container's child gutters. Returns the section a COLLAPSED heading owns,
 * which the whole-document builder above turns into content-hiding
 * decorations; a single-block rebuild (the fold plugin's leaf-edit path) never
 * needs that, because it runs only for a block that is not folded. Exported
 * for that rebuild, so the two can never emit different chrome for a block.
 */
export function blockChrome(
    node: any,
    offset: number,
    decorations: Decoration[],
    folded: ReadonlySet<number>,
    enabled: boolean,
    ranges: Map<number, HeadingFoldRange | null>,
): { pos: number; node: any; range: HeadingFoldRange } | null {
    const foldCtx = { folded, enabled };
    {
        if (!isHeadingNode(node)) {
            // Lists get per-item markers (each item is the grabbable unit,
            // MAR-86); every other non-heading block with a glyph gets the
            // hover-revealed gutter marker opening the block menu, plus the
            // host class that carries the shared positioning/hover CSS.
            if (isListNode(node)) {
                emitItemGutters(node, offset, decorations, null, foldCtx);
                return null;
            }
            const spec = blockMarkerSpec(node);
            const fold = blockFoldInfo(node, offset, foldCtx, false);
            if (spec !== null) {
                // A leaf atom (hr, mdx block) has no content position: its
                // widget at offset + 1 lands AFTER the node, as the block's
                // next sibling, and the --leaf classes plus a per-pair
                // anchor name let the CSS anchor it back onto the host
                // (createBlockGutter's `leafAnchor`).
                const leaf = isLeafBlock(node) ? leafAnchorName(offset) : undefined;
                decorations.push(
                    Decoration.node(offset, offset + node.nodeSize, {
                        // "collapsed" drives the callout NodeView's hidden
                        // body (components/callout/callout.css) — fold state
                        // reaches the NodeView as a decoration class, never
                        // as node state (the doc stays untouched).
                        class: `block-gutter-host${leaf ? " block-gutter-host--leaf" : ""}${fold?.collapsed ? " collapsed" : ""}`,
                        ...(leaf ? { style: `anchor-name: ${leaf}` } : {}),
                    }),
                );
                decorations.push(
                    Decoration.widget(
                        offset + 1,
                        (view: EditorView) => createBlockGutter(view, spec, undefined, fold ?? undefined, leaf),
                        // Stable, position-free key: same-glyph widgets reuse
                        // their DOM across rebuilds (matching is ordinal). A
                        // leaf widget is the exception: its key carries the
                        // pair's anchor name, so it is rebuilt with its host.
                        { key: `g:${spec.key}${foldKeyPart(fold)}${leaf ? `:${leaf}` : ""}`, side: -1 },
                    ),
                );
            }
            if (isCollapsedFirstLine(node, fold)) {
                emitFirstLineFold(node, offset, decorations);
            }
            if (isContainerNode(node)) {
                emitContainerChildGutters(node, offset, decorations, null, foldCtx);
            }
            return null;
        }

        const level = getHeadingLevel(node);
        const collapsed = enabled && folded.has(offset);
        const range = enabled ? ranges.get(offset) ?? null : null;
        const foldable = Boolean(range);

        decorations.push(
            Decoration.node(offset, offset + node.nodeSize, {
                class: `heading-fold-heading${foldable ? " heading-fold-heading--foldable" : ""}${collapsed ? " heading-fold-heading--collapsed" : ""}`,
                "data-heading-level": String(level),
            }),
        );
        decorations.push(
            Decoration.widget(
                offset + 1,
                (view) => createHeadingFoldGutter(view, level, collapsed, foldable),
                // The same identity the fingerprint carries for this heading.
                { key: headingGutterSpec(level, collapsed, foldable).key, side: -1 },
            ),
        );

        return collapsed && range ? { pos: offset, node, range } : null;
    }
}
