/**
 * webview/plugins/headingFold/foldDecorations.ts
 *
 * The decoration pass: per-block gutter widgets and host classes (top-level
 * blocks, container children, list items — recursively), the hidden-range
 * node decorations for collapsed folds, the `…` ellipsis widgets, and the
 * structural fingerprint that lets the plugin position-MAP a cached
 * DecorationSet across edits instead of rebuilding it.
 */
import type { EditorView } from "@milkdown/prose/view";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import {
    blockMarkerSpec,
    createBlockGutter,
    createHeadingEllipsis,
    createHeadingFoldGutter,
    createItemEllipsis,
    itemMarkerSpec,
    nestedChildSpec,
    type GutterFoldInfo,
} from "./foldGutter";
import {
    calloutHasBody,
    computeFoldRanges,
    getHeadingLevel,
    isCalloutNode,
    isCodeBlockNode,
    isContainerNode,
    isHeadingNode,
    isListNode,
    isTableNode,
    listItemHasDescendants,
    tableHasBody,
    type HeadingFoldRange,
} from "./foldModel";

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
): void {
    if (isListNode(child)) {
        // A list directly inside a container clears that container's bar(s):
        // its items inherit the container depth (MAR-89). List nesting itself
        // adds no bar, so deeper lists keep the same depth.
        parts?.push("L");
        emitItemGutters(child, childPos, decorations, parts, foldCtx, depth);
        return;
    }
    const spec = nestedChildSpec(child);
    if (spec !== null) {
        const fold = blockFoldInfo(child, childPos, foldCtx);
        const foldKey = foldKeyPart(fold);
        parts?.push(`c${depth}${spec.key}${foldKey}`);
        decorations?.push(
            Decoration.node(childPos, childPos + child.nodeSize, {
                class: `block-gutter-host block-gutter-host--child block-gutter-host--d${Math.min(depth, 6)}${fold?.collapsed ? " collapsed" : ""}`,
            }),
        );
        decorations?.push(
            Decoration.widget(
                childPos + 1,
                (view: EditorView) => createBlockGutter(view, spec, depth, fold ?? undefined),
                { key: `g:${spec.key}:n${depth}${foldKey}`, side: -1 },
            ),
        );
    } else {
        parts?.push("·");
    }
    if (isContainerNode(child)) {
        emitContainerChildGutters(child, childPos, decorations, parts, foldCtx, depth + 1);
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
): void {
    container.forEach((child: any, offset: number) => {
        emitNestedChildGutter(child, containerPos + 1 + offset, decorations, parts, foldCtx, depth);
    });
}

/** Fold info for a foldable non-heading block's gutter (callout, table,
 * code block — MAR-110/125), or null for everything else (and for
 * everything while `editor.folding` is off — zero fold chrome). Only
 * invoked from the top-level and container-children passes, which never
 * run inside list items, so the chrome-parity gate holds by construction. */
function blockFoldInfo(
    node: any,
    pos: number,
    foldCtx: { folded: ReadonlySet<number>; enabled: boolean },
): GutterFoldInfo | null {
    if (!foldCtx.enabled) {
        return null;
    }
    if (isCalloutNode(node)) {
        return { foldable: calloutHasBody(node), collapsed: foldCtx.folded.has(pos) };
    }
    if (isTableNode(node)) {
        return { foldable: tableHasBody(node), collapsed: foldCtx.folded.has(pos) };
    }
    if (isCodeBlockNode(node)) {
        return { foldable: node.content.size > 0, collapsed: foldCtx.folded.has(pos) };
    }
    return null;
}

/** The widget-key / fingerprint suffix a fold state contributes. */
function foldKeyPart(fold: GutterFoldInfo | null): string {
    if (!fold) {
        return "";
    }
    return `${fold.collapsed ? "c" : "o"}${fold.foldable ? "f" : "l"}`;
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
        const digits = String(Math.max(maxNum, 1)).length;
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
            // Hide every child block after the item's first line, and trail
            // that line with the `…` chip (the heading idiom — clicking
            // expands). The hidden children keep their own decorations;
            // display:none on the blocks suppresses them wholesale.
            const hiddenCount = item.childCount - 1;
            item.forEach((child: any, childOffset: number) => {
                if (childOffset === 0) {
                    return;
                }
                const childPos = itemPos + 1 + childOffset;
                decorations.push(
                    Decoration.node(childPos, childPos + child.nodeSize, {
                        class: "heading-fold-hidden",
                    }),
                );
            });
            decorations.push(
                Decoration.widget(
                    itemPos + 1 + item.firstChild!.nodeSize - 1,
                    (view: EditorView) => createItemEllipsis(view, hiddenCount),
                    { key: `e:i:${hiddenCount}`, side: 1 },
                ),
            );
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
                emitNestedChildGutter(child, childPos, decorations, parts, foldCtx, containerDepth + 1);
            }
        });
    });
}

/**
 * A cheap structural summary of everything the decorations depend on: per
 * top-level block its rendered identity (glyph, or heading level + collapsed
 * + foldable). While this string is unchanged across an edit, the cached
 * decoration set is merely position-MAPPED — widget DOM survives, nothing is
 * rebuilt. (Positions are deliberately absent: gutterBlockPos derives them at
 * interaction time, so shifted widgets never go stale.)
 */
export function structureFingerprint(
    doc: any,
    folded: ReadonlySet<number>,
    ranges: Map<number, HeadingFoldRange | null>,
    enabled: boolean,
): string {
    const foldCtx = { folded, enabled };
    const parts: string[] = [enabled ? "E" : "D"];
    doc.forEach((node: any, offset: number) => {
        if (isHeadingNode(node)) {
            const collapsed = enabled && folded.has(offset);
            const foldable = enabled && Boolean(ranges.get(offset));
            parts.push(`h${getHeadingLevel(node)}${collapsed ? "c" : ""}${foldable ? "f" : ""}`);
        } else if (isListNode(node)) {
            parts.push("L");
            emitItemGutters(node, offset, null, parts, foldCtx);
        } else {
            const fold = blockFoldInfo(node, offset, foldCtx);
            parts.push(`${blockMarkerSpec(node)?.key ?? "·"}${foldKeyPart(fold)}`);
            if (isContainerNode(node)) {
                emitContainerChildGutters(node, offset, null, parts, foldCtx);
            }
        }
    });
    return parts.join("|");
}

export function buildHeadingFoldDecorations(
    doc: any,
    folded: ReadonlySet<number>,
    enabled: boolean,
): DecorationSet {
    const decorations: Decoration[] = [];
    const collapsedSections: { pos: number; node: any; range: HeadingFoldRange }[] = [];
    const ranges = computeFoldRanges(doc);
    const foldCtx = { folded, enabled };

    doc.forEach((node: any, offset: number) => {
        if (!isHeadingNode(node)) {
            // Lists get per-item markers (each item is the grabbable unit,
            // MAR-86); every other non-heading block with a glyph gets the
            // hover-revealed gutter marker opening the block menu, plus the
            // host class that carries the shared positioning/hover CSS.
            if (isListNode(node)) {
                emitItemGutters(node, offset, decorations, null, foldCtx);
                return;
            }
            const spec = blockMarkerSpec(node);
            const fold = blockFoldInfo(node, offset, foldCtx);
            if (spec !== null) {
                decorations.push(
                    Decoration.node(offset, offset + node.nodeSize, {
                        // "collapsed" drives the callout NodeView's hidden
                        // body (components/callout/callout.css) — fold state
                        // reaches the NodeView as a decoration class, never
                        // as node state (the doc stays untouched).
                        class: `block-gutter-host${fold?.collapsed ? " collapsed" : ""}`,
                    }),
                );
                decorations.push(
                    Decoration.widget(
                        offset + 1,
                        (view: EditorView) => createBlockGutter(view, spec, undefined, fold ?? undefined),
                        // Stable, position-free key: same-glyph widgets reuse
                        // their DOM across rebuilds (matching is ordinal).
                        { key: `g:${spec.key}${foldKeyPart(fold)}`, side: -1 },
                    ),
                );
            }
            if (isContainerNode(node)) {
                emitContainerChildGutters(node, offset, decorations, null, foldCtx);
            }
            return;
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
                {
                    key: `h:${level}:${collapsed ? "c" : "o"}:${foldable ? "f" : "l"}`,
                    side: -1,
                },
            ),
        );

        if (collapsed && range) {
            collapsedSections.push({ pos: offset, node, range });
        }
    });

    if (collapsedSections.length > 0) {
        // Hidden-block classes, plus the per-section counts the `…` tooltips
        // report — one extra pass, only while something is collapsed.
        const hiddenCounts = new Map<number, number>();
        doc.forEach((node: any, offset: number) => {
            let hidden = false;
            for (const section of collapsedSections) {
                if (offset >= section.range.from && offset < section.range.to) {
                    hiddenCounts.set(section.pos, (hiddenCounts.get(section.pos) ?? 0) + 1);
                    hidden = true;
                }
            }
            if (hidden) {
                decorations.push(
                    Decoration.node(offset, offset + node.nodeSize, {
                        class: "heading-fold-hidden",
                    }),
                );
            }
        });
        for (const section of collapsedSections) {
            const count = hiddenCounts.get(section.pos) ?? 0;
            decorations.push(
                Decoration.widget(
                    section.pos + section.node.nodeSize - 1,
                    (view: EditorView) => createHeadingEllipsis(view, count),
                    { key: `e:${count}`, side: 1 },
                ),
            );
        }
    }

    return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}
