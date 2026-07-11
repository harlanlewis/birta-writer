import type { EditorView } from "@milkdown/prose/view";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { Plugin, PluginKey, TextSelection } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";
import { IconChevronDown, IconChevronRight } from "../ui/icons";
import { applyTooltip, hideTooltip } from "../ui/tooltip";
import { t } from "../i18n";
// Runtime-only cycle (blockMenu imports this module's pure helpers back);
// both sides touch the other only inside event handlers / decoration passes,
// matching the slashMenu plugin ↔ component precedent.
import { closeBlockMenu, openBlockMenu } from "../components/blockMenu";
import { isTaskListNode, isTextBearingParagraph } from "../components/blockMenu/turnInto";
import { wireMarkerDrag } from "../components/blockMenu/drag";

export type HeadingFoldMeta =
    | { type: "toggle"; pos: number }
    /**
     * A block move (menu Move rows / drag-drop): content in [from, to) was
     * deleted and re-inserted with its start at `insertAt` (a FINAL-doc
     * position). Position mapping alone can't follow relocated content —
     * without this meta a collapsed heading's fold entry would land on
     * whatever block filled the old gap, collapsing the wrong section.
     */
    | { type: "move"; from: number; to: number; insertAt: number }
    /**
     * A block deletion (menu Delete): fold entries inside [from, to) die with
     * their heading instead of being position-mapped onto whatever heading
     * fills the gap. (Mapping flags can't express this: a deletion STARTING
     * at the heading maps its entry cleanly onto the next block.)
     */
    | { type: "delete"; from: number; to: number };
type HeadingFoldRange = { from: number; to: number };

/**
 * Plugin state: the folded heading positions PLUS the cached decoration set
 * and the structural fingerprint it was built for. Caching here (instead of
 * rebuilding in props.decorations on every state read) is what keeps typing
 * O(1)-ish: selection-only transactions return the identical state object,
 * and structure-preserving edits merely position-map the existing set — no
 * widget DOM is recreated.
 */
export interface HeadingFoldState {
    readonly folded: ReadonlySet<number>;
    readonly decorations: DecorationSet;
    readonly fingerprint: string;
}

export const headingFoldPluginKey = new PluginKey<HeadingFoldState>("heading-fold");

type ProseNodeLike = {
    type: { name: string };
    attrs?: Record<string, unknown>;
    nodeSize: number;
};

function isHeadingNode(node: ProseNodeLike | null | undefined): node is ProseNodeLike {
    return node?.type.name === "heading";
}

/** A heading NODE's level attr (the DOM-element twin lives in utils/headingUtils). */
export function getHeadingLevel(node: { attrs?: Record<string, unknown> }): number {
    const level = node.attrs?.["level"];
    return typeof level === "number" ? level : 1;
}

/**
 * The gutter label for a heading: its literal Markdown hashes (`#`..`######`).
 * A level cue that reads as source, iA-Writer-style. Exported for unit testing.
 */
export function headingMarker(level: number): string {
    return "#".repeat(Math.min(Math.max(level, 1), 6));
}

/**
 * Retype the block at `headingPos` to a heading of `level` (1–6), or to a
 * paragraph when `level` is 0. Accepts a heading OR a paragraph (the paragraph
 * gutter promotes P → Hn; the heading gutter goes both ways). Targets the node
 * BY POSITION, not the current selection, so the gutter menu can change a block
 * the caret isn't inside. Heading→heading preserves the node's other attrs
 * (e.g. the TOC-anchor id); →paragraph drops them. Returns false when the
 * position isn't a retypeable block or the change is a no-op (same level).
 * Exported for unit testing.
 */
export function setHeadingLevelAt(view: EditorView, headingPos: number, level: number): boolean {
    const node = view.state.doc.nodeAt(headingPos);
    const isParagraph = node?.type.name === "paragraph";
    if (!isHeadingNode(node) && !isParagraph) {
        return false;
    }
    const schema = view.state.schema;
    if (level <= 0) {
        if (isParagraph) {
            return false; // already a paragraph — no-op
        }
        const paragraph = schema.nodes["paragraph"];
        if (!paragraph) {
            return false;
        }
        view.dispatch(view.state.tr.setNodeMarkup(headingPos, paragraph, null));
    } else {
        const heading = schema.nodes["heading"];
        if (!heading) {
            return false;
        }
        const clamped = Math.min(Math.max(Math.round(level), 1), 6);
        if (!isParagraph && getHeadingLevel(node) === clamped) {
            return false;
        }
        const attrs = isParagraph ? { level: clamped } : { ...node.attrs, level: clamped };
        view.dispatch(view.state.tr.setNodeMarkup(headingPos, heading, attrs));
    }
    view.focus();
    return true;
}

/**
 * Fold ranges for EVERY heading in one pass (a stack of open sections): a
 * heading's range runs from just after it to the next heading of the same or
 * higher rank. Null value = the heading owns nothing (not foldable).
 */
export function computeFoldRanges(doc: any): Map<number, HeadingFoldRange | null> {
    const ranges = new Map<number, HeadingFoldRange | null>();
    const open: { pos: number; level: number; from: number }[] = [];
    const closeThrough = (level: number, to: number): void => {
        while (open.length > 0 && open[open.length - 1]!.level >= level) {
            const section = open.pop()!;
            ranges.set(section.pos, section.from < to ? { from: section.from, to } : null);
        }
    };
    doc.forEach((node: any, offset: number) => {
        if (!isHeadingNode(node)) {
            return;
        }
        const level = getHeadingLevel(node);
        closeThrough(level, offset);
        open.push({ pos: offset, level, from: offset + node.nodeSize });
    });
    closeThrough(0, doc.content.size);
    return ranges;
}

/**
 * The content range ONE heading owns (see computeFoldRanges for the map the
 * decoration pass uses). A direct scan — the block menu / drag handle call
 * this per action, sometimes in loops, so it mustn't build the whole map.
 */
export function findHeadingFoldRange(doc: any, headingPos: number, headingLevel?: number): HeadingFoldRange | null {
    const headingNode = doc.nodeAt(headingPos);
    if (!isHeadingNode(headingNode)) {
        return null;
    }
    const level = headingLevel ?? getHeadingLevel(headingNode);
    const from = headingPos + headingNode.nodeSize;
    let to = doc.content.size;
    doc.forEach((node: any, offset: number) => {
        if (offset <= headingPos || !isHeadingNode(node)) {
            return;
        }
        if (getHeadingLevel(node) <= level && to === doc.content.size) {
            to = offset;
        }
    });
    return from < to ? { from, to } : null;
}

function cleanFoldedHeadingPositions(doc: any, folded: Iterable<number>): Set<number> {
    const next = new Set<number>();
    for (const pos of folded) {
        if (isHeadingNode(doc.nodeAt(pos))) {
            next.add(pos);
        }
    }
    return next;
}

/**
 * The document position of the block a gutter widget belongs to, derived at
 * INTERACTION time from the widget's own DOM position. The cached decoration
 * set is position-mapped through edits without rebuilding widget DOM, so a
 * position captured at build time would go stale — this never can. Null when
 * the widget is no longer in the view.
 */
function gutterBlockPos(view: EditorView, gutter: HTMLElement): number | null {
    if (!gutter.isConnected) {
        return null;
    }
    try {
        // The widget sits at blockPos + 1 (just inside the block).
        return view.posAtDOM(gutter, 0) - 1;
    } catch {
        return null;
    }
}

function createHeadingFoldGutter(
    view: EditorView,
    level: number,
    collapsed: boolean,
    foldable: boolean,
): HTMLElement {
    const gutter = document.createElement("span");
    gutter.className = `heading-fold-gutter${foldable ? " heading-fold-gutter--foldable" : ""}`;
    gutter.contentEditable = "false";

    // The marker is a button: clicking its literal Markdown hashes (`#`..
    // `######`) opens a menu to retype the heading (P / H1–H6) — a level cue
    // that doubles as a level control, iA-Writer-style. The widget key encodes
    // `level`, so the hashes repaint live as the heading level changes (via the
    // heading commands, this menu, or a typed `#`-space). Setext headings carry
    // no hashes in their source but still show `#`/`##` here — the gutter is a
    // level cue in this WYSIWYG view, not a byte mirror, and their source
    // round-trips as setext untouched. It sits to the RIGHT of the fold chevron
    // (distinct click targets), so the two never overlap.
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "heading-fold-marker";
    marker.textContent = headingMarker(level);
    marker.setAttribute("aria-label", t("Block options"));
    marker.setAttribute("aria-haspopup", "menu");
    marker.setAttribute("aria-expanded", "false");
    applyTooltip(marker, t("Click for options · Drag to move"), { placement: "above" });
    // mousedown: keep the editor selection/caret; click: open the menu.
    marker.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    marker.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // A drag that started on this marker must not also open the menu.
        if (marker.dataset["dragged"]) {
            delete marker.dataset["dragged"];
            return;
        }
        const pos = gutterBlockPos(view, gutter);
        if (pos === null) {
            return;
        }
        // A keyboard-activated button click reports detail 0 (no mouse click
        // count) — use it to move focus into the menu only for keyboard opens.
        openBlockMenu(view, pos, marker, event.detail === 0);
    });
    wireMarkerDrag(view, marker, () => gutterBlockPos(view, gutter));

    if (!foldable) {
        gutter.appendChild(marker);
        return gutter;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "heading-fold-toggle";
    button.innerHTML = collapsed ? IconChevronRight : IconChevronDown;
    const tipText = collapsed ? t("Expand content") : t("Collapse content");
    button.setAttribute("aria-label", tipText);
    button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    applyTooltip(button, tipText, { placement: "above" });

    button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        const headingPos = gutterBlockPos(view, gutter);
        const node = headingPos === null ? null : view.state.doc.nodeAt(headingPos);
        if (headingPos === null || !isHeadingNode(node)) {
            return;
        }

        const tr = view.state.tr
            .setMeta(headingFoldPluginKey, { type: "toggle", pos: headingPos } satisfies HeadingFoldMeta)
            .setMeta("addToHistory", false);

        if (!collapsed) {
            const range = findHeadingFoldRange(view.state.doc, headingPos, getHeadingLevel(node));
            if (
                range &&
                view.state.selection.from < range.to &&
                view.state.selection.to > range.from
            ) {
                tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(headingPos + 1, tr.doc.content.size))));
            }
        }

        view.dispatch(tr);
        view.focus();
        hideTooltip();
    });

    gutter.appendChild(button);
    gutter.appendChild(marker);
    return gutter;
}

/**
 * The non-heading twin of the heading gutter: a source-mirroring glyph (`P`,
 * `-`, `>`, ``` …) that is invisible until its block is hovered (CSS), and
 * opens the block menu at full contrast when interacted with — so every
 * top-level block's conversions and actions are as reachable as a heading's.
 * No fold chevron: only headings own sections.
 */
function createBlockGutter(view: EditorView, glyph: string): HTMLElement {
    const gutter = document.createElement("span");
    gutter.className = "heading-fold-gutter heading-fold-gutter--block";
    gutter.contentEditable = "false";

    const marker = document.createElement("button");
    marker.type = "button";
    // --paragraph kept as the P marker's stable test/back-compat hook; every
    // hover-revealed marker (including P) carries --block for shared styling.
    marker.className = `heading-fold-marker heading-fold-marker--block${glyph === "P" ? " heading-fold-marker--paragraph" : ""}`;
    marker.textContent = glyph;
    // Same label as the heading markers: it's the same block menu.
    marker.setAttribute("aria-label", t("Block options"));
    marker.setAttribute("aria-haspopup", "menu");
    marker.setAttribute("aria-expanded", "false");
    applyTooltip(marker, t("Click for options · Drag to move"), { placement: "above" });
    marker.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    marker.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (marker.dataset["dragged"]) {
            delete marker.dataset["dragged"];
            return;
        }
        const pos = gutterBlockPos(view, gutter);
        if (pos === null) {
            return;
        }
        openBlockMenu(view, pos, marker, event.detail === 0);
    });
    wireMarkerDrag(view, marker, () => gutterBlockPos(view, gutter));

    gutter.appendChild(marker);
    return gutter;
}

/**
 * The gutter glyph for a non-heading top-level block, or null for blocks that
 * get no marker. Glyphs mirror the markdown source, dimmed (the design
 * principle the heading hashes established): `-`/`1.`/`[ ]` lists, `>` quote,
 * `[!]` callout, ``` code, `![]` standalone image, `<>` raw HTML.
 *
 * Deliberately absent for now: tables (rich chrome of their own — grips,
 * insert bars; a second control would double up) and leaf atoms like `---`
 * (an hr can't host the in-block widget this gutter rides on; both join in
 * MAR-19's overlay-based drag handle).
 */
function blockMarkerGlyph(node: any): string | null {
    switch (node.type.name) {
        case "paragraph": {
            if (isTextBearingParagraph(node)) {
                return "P";
            }
            let sawImage = false;
            node.forEach((child: any) => {
                if (child.type.name === "image") {
                    sawImage = true;
                }
            });
            return sawImage ? "![]" : "<>";
        }
        case "bullet_list":
            return isTaskListNode(node) ? "[ ]" : "-";
        case "ordered_list":
            return "1.";
        case "blockquote":
            return ">";
        case "callout":
            return "[!]";
        case "code_block":
            return "```";
        default:
            return null;
    }
}

/**
 * A cheap structural summary of everything the decorations depend on: per
 * top-level block its rendered identity (glyph, or heading level + collapsed
 * + foldable). While this string is unchanged across an edit, the cached
 * decoration set is merely position-MAPPED — widget DOM survives, nothing is
 * rebuilt. (Positions are deliberately absent: gutterBlockPos derives them at
 * interaction time, so shifted widgets never go stale.)
 */
function structureFingerprint(
    doc: any,
    folded: ReadonlySet<number>,
    ranges: Map<number, HeadingFoldRange | null>,
): string {
    const parts: string[] = [];
    doc.forEach((node: any, offset: number) => {
        if (isHeadingNode(node)) {
            const collapsed = folded.has(offset);
            const foldable = Boolean(ranges.get(offset));
            parts.push(`h${getHeadingLevel(node)}${collapsed ? "c" : ""}${foldable ? "f" : ""}`);
        } else {
            parts.push(blockMarkerGlyph(node) ?? "·");
        }
    });
    return parts.join("|");
}

function buildHeadingFoldDecorations(doc: any, folded: ReadonlySet<number>): DecorationSet {
    const decorations: Decoration[] = [];
    const hiddenRanges: HeadingFoldRange[] = [];
    const ranges = computeFoldRanges(doc);

    doc.forEach((node: any, offset: number) => {
        if (!isHeadingNode(node)) {
            // Every non-heading top-level block with a glyph gets the
            // hover-revealed gutter marker opening the block menu, plus the
            // host class that carries the shared positioning/hover CSS. Only
            // direct children of the doc — blocks inside lists/quotes/tables
            // have their own semantics.
            const glyph = blockMarkerGlyph(node);
            if (glyph !== null) {
                decorations.push(
                    Decoration.node(offset, offset + node.nodeSize, {
                        class: "block-gutter-host",
                    }),
                );
                decorations.push(
                    Decoration.widget(
                        offset + 1,
                        (view: EditorView) => createBlockGutter(view, glyph),
                        // Stable, position-free key: same-glyph widgets reuse
                        // their DOM across rebuilds (matching is ordinal).
                        { key: `g:${glyph}`, side: -1 },
                    ),
                );
            }
            return;
        }

        const level = getHeadingLevel(node);
        const collapsed = folded.has(offset);
        const range = ranges.get(offset) ?? null;
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
            hiddenRanges.push(range);
        }
    });

    if (hiddenRanges.length > 0) {
        doc.forEach((node: any, offset: number) => {
            if (hiddenRanges.some((range) => offset >= range.from && offset < range.to)) {
                decorations.push(
                    Decoration.node(offset, offset + node.nodeSize, {
                        class: "heading-fold-hidden",
                    }),
                );
            }
        });
    }

    return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

function isHeadingElement(element: Element | null): element is HTMLElement {
    return element instanceof HTMLElement && element.matches("h1,h2,h3,h4,h5,h6");
}

function findSectionHeadingPosAt(view: EditorView, pos: number): number | null {
    let headingPos: number | null = null;
    const searchTo = Math.min(Math.max(pos, 0), view.state.doc.content.size);

    view.state.doc.nodesBetween(0, searchTo, (node, nodePos) => {
        if (!isHeadingNode(node)) {
            return;
        }

        const range = findHeadingFoldRange(view.state.doc, nodePos, getHeadingLevel(node));
        if (range && nodePos <= pos && pos < range.to) {
            headingPos = nodePos;
        }
    });

    return headingPos;
}

function getHeadingGutter(heading: HTMLElement | null): HTMLElement | null {
    return heading?.querySelector<HTMLElement>(".heading-fold-gutter--foldable") ?? null;
}

function getHeadingElementAtPos(view: EditorView, pos: number): HTMLElement | null {
    const dom = view.nodeDOM(pos);
    return isHeadingElement(dom as Element | null) ? dom as HTMLElement : null;
}

export const headingFoldPlugin = $prose(() =>
    new Plugin<HeadingFoldState>({
        key: headingFoldPluginKey,
        state: {
            init: (_config, state) => {
                const folded = new Set<number>();
                return {
                    folded,
                    decorations: buildHeadingFoldDecorations(state.doc, folded),
                    fingerprint: structureFingerprint(state.doc, folded, computeFoldRanges(state.doc)),
                };
            },
            apply(tr, value, _oldState, newState) {
                const meta = tr.getMeta(headingFoldPluginKey) as HeadingFoldMeta | undefined;
                let folded: ReadonlySet<number> = value.folded;

                if (tr.docChanged) {
                    const move = meta?.type === "move" ? meta : null;
                    const del = meta?.type === "delete" ? meta : null;
                    const next = new Set<number>();
                    for (const pos of value.folded) {
                        // Entries inside a moved range travel with the
                        // content to its new location.
                        if (move && pos >= move.from && pos < move.to) {
                            const relocated = move.insertAt + (pos - move.from);
                            if (isHeadingNode(newState.doc.nodeAt(relocated))) {
                                next.add(relocated);
                            }
                            continue;
                        }
                        // Entries inside a deleted block die with it.
                        if (del && pos >= del.from && pos < del.to) {
                            continue;
                        }
                        const mapped = tr.mapping.map(pos, -1);
                        if (isHeadingNode(newState.doc.nodeAt(mapped))) {
                            next.add(mapped);
                        }
                    }
                    folded = cleanFoldedHeadingPositions(newState.doc, next);
                }

                if (meta?.type === "toggle") {
                    const next = new Set<number>(folded);
                    if (next.has(meta.pos)) {
                        next.delete(meta.pos);
                    } else if (isHeadingNode(newState.doc.nodeAt(meta.pos))) {
                        next.add(meta.pos);
                    }
                    folded = next;
                }

                // Selection-only transaction, nothing folded/unfolded: the
                // state is untouched — zero decoration work per caret move.
                if (!tr.docChanged && folded === value.folded) {
                    return value;
                }

                const fingerprint = structureFingerprint(
                    newState.doc,
                    folded,
                    computeFoldRanges(newState.doc),
                );
                if (fingerprint === value.fingerprint) {
                    if (!tr.docChanged) {
                        return { folded, fingerprint, decorations: value.decorations };
                    }
                    // Structure (and therefore every rendered gutter) is
                    // unchanged — just map positions; widget DOM survives.
                    // CAVEAT: mapping DESTROYS decorations on a replaced node
                    // even when the replacement is structure-neutral (e.g.
                    // headingIds stamping an id attr via setNodeMarkup), so
                    // fall back to a rebuild whenever the map lost any —
                    // identical structure implies an identical count.
                    const mapped = value.decorations.map(tr.mapping, newState.doc);
                    if (mapped.find().length === value.decorations.find().length) {
                        return { folded, fingerprint, decorations: mapped };
                    }
                }
                return {
                    folded,
                    fingerprint,
                    decorations: buildHeadingFoldDecorations(newState.doc, folded),
                };
            },
        },
        props: {
            decorations(state) {
                return headingFoldPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
            },
        },
        view(view) {
            let hoveredGutter: HTMLElement | null = null;

            const clearHoveredGutter = () => {
                hoveredGutter?.classList.remove("heading-fold-gutter--section-hover");
                hoveredGutter = null;
            };

            const setHoveredGutter = (gutter: HTMLElement | null) => {
                if (gutter === hoveredGutter) {
                    return;
                }
                clearHoveredGutter();
                hoveredGutter = gutter;
                hoveredGutter?.classList.add("heading-fold-gutter--section-hover");
            };

            // Quiet-while-typing (the BlockNote/Tiptap/Crepe convention): any
            // keydown in the editor suppresses the hover-revealed markers so
            // the gutter never flickers alongside the caret; the next mouse
            // motion brings them back.
            const handleKeyDown = () => {
                document.body.classList.add("gutter-quiet");
            };

            const handleMouseMove = (event: MouseEvent) => {
                document.body.classList.remove("gutter-quiet");
                const target = event.target as Element | null;
                const directHeading = target?.closest("h1,h2,h3,h4,h5,h6") ?? null;
                if (directHeading && view.dom.contains(directHeading)) {
                    setHoveredGutter(getHeadingGutter(isHeadingElement(directHeading) ? directHeading : null));
                    return;
                }

                const coords = view.posAtCoords({
                    left: event.clientX,
                    top: event.clientY,
                });
                const headingPos = coords ? findSectionHeadingPosAt(view, coords.pos) : null;
                setHoveredGutter(headingPos === null ? null : getHeadingGutter(getHeadingElementAtPos(view, headingPos)));
            };

            view.dom.addEventListener("mousemove", handleMouseMove);
            view.dom.addEventListener("mouseleave", clearHoveredGutter);
            view.dom.addEventListener("keydown", handleKeyDown);

            return {
                update(updatedView, prevState) {
                    // Any document change invalidates an open block menu's
                    // captured position (and may destroy its anchor marker) —
                    // close it. Selection-only transactions keep the same doc
                    // node, so this never fires for caret movement.
                    if (updatedView.state.doc !== prevState.doc) {
                        closeBlockMenu();
                    }
                    if (hoveredGutter && !view.dom.contains(hoveredGutter)) {
                        hoveredGutter = null;
                    }
                },
                destroy() {
                    view.dom.removeEventListener("mousemove", handleMouseMove);
                    view.dom.removeEventListener("mouseleave", clearHoveredGutter);
                    view.dom.removeEventListener("keydown", handleKeyDown);
                    document.body.classList.remove("gutter-quiet");
                    clearHoveredGutter();
                },
            };
        },
    }),
);
