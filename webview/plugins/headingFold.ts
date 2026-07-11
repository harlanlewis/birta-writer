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
import { openBlockMenu } from "../components/blockMenu";
import { isTextBearingParagraph } from "../components/blockMenu/turnInto";

export type HeadingFoldMeta = { type: "toggle"; pos: number };
type HeadingFoldRange = { from: number; to: number };

export const headingFoldPluginKey = new PluginKey<Set<number>>("heading-fold");

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
 * The content range a heading owns — from just after the heading to the next
 * heading of the same or higher level (the fold range, and the "section" the
 * block menu's move actions and the drag handle operate on). Null when the
 * heading owns nothing.
 */
export function findHeadingFoldRange(doc: any, headingPos: number, headingLevel: number): HeadingFoldRange | null {
    const headingNode = doc.nodeAt(headingPos);
    if (!isHeadingNode(headingNode)) {
        return null;
    }

    const from = headingPos + headingNode.nodeSize;
    let to = doc.content.size;
    doc.forEach((node: any, offset: number) => {
        if (offset <= headingPos || !isHeadingNode(node)) {
            return;
        }
        if (getHeadingLevel(node) <= headingLevel && to === doc.content.size) {
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

function createHeadingFoldGutter(
    view: EditorView,
    headingPos: number,
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
    const markerTip = t("Block options");
    marker.setAttribute("aria-label", markerTip);
    marker.setAttribute("aria-haspopup", "menu");
    applyTooltip(marker, markerTip, { placement: "above" });
    // mousedown: keep the editor selection/caret; click: open the menu.
    marker.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    marker.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // A keyboard-activated button click reports detail 0 (no mouse click
        // count) — use it to move focus into the menu only for keyboard opens.
        openBlockMenu(view, headingPos, marker, event.detail === 0);
    });

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

        const node = view.state.doc.nodeAt(headingPos);
        if (!isHeadingNode(node)) {
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
function createBlockGutter(view: EditorView, blockPos: number, glyph: string): HTMLElement {
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
    const markerTip = t("Block options");
    marker.setAttribute("aria-label", markerTip);
    marker.setAttribute("aria-haspopup", "menu");
    applyTooltip(marker, markerTip, { placement: "above" });
    marker.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    marker.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openBlockMenu(view, blockPos, marker, event.detail === 0);
    });

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
        case "bullet_list": {
            const first = node.firstChild;
            return first && first.attrs["checked"] != null ? "[ ]" : "-";
        }
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

function buildHeadingFoldDecorations(doc: any, folded: ReadonlySet<number>): DecorationSet {
    const decorations: Decoration[] = [];
    const hiddenRanges: HeadingFoldRange[] = [];

    doc.forEach((node: any, offset: number) => {
        if (!isHeadingNode(node)) {
            // Every non-heading top-level block with a glyph gets the
            // hover-revealed gutter marker opening the block menu. Only
            // direct children of the doc — blocks inside lists/quotes/tables
            // have their own semantics.
            const glyph = blockMarkerGlyph(node);
            if (glyph !== null) {
                decorations.push(
                    Decoration.widget(
                        offset + 1,
                        (view: EditorView) => createBlockGutter(view, offset, glyph),
                        { key: `block-gutter-${offset}-${glyph}`, side: -1 },
                    ),
                );
            }
            return;
        }

        const level = getHeadingLevel(node);
        const collapsed = folded.has(offset);
        const range = findHeadingFoldRange(doc, offset, level);
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
                (view) => createHeadingFoldGutter(view, offset, level, collapsed, foldable),
                {
                    key: `heading-fold-gutter-${offset}-${level}-${collapsed ? "closed" : "open"}-${foldable ? "foldable" : "leaf"}`,
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
    new Plugin<Set<number>>({
        key: headingFoldPluginKey,
        state: {
            init: () => new Set<number>(),
            apply(tr, value, _oldState, newState) {
                let next = value;

                if (tr.docChanged) {
                    next = new Set<number>();
                    for (const pos of value) {
                        const mapped = tr.mapping.map(pos, -1);
                        if (isHeadingNode(newState.doc.nodeAt(mapped))) {
                            next.add(mapped);
                        }
                    }
                    next = cleanFoldedHeadingPositions(newState.doc, next);
                }

                const meta = tr.getMeta(headingFoldPluginKey) as HeadingFoldMeta | undefined;
                if (meta?.type === "toggle") {
                    next = new Set<number>(next);
                    if (next.has(meta.pos)) {
                        next.delete(meta.pos);
                    } else if (isHeadingNode(newState.doc.nodeAt(meta.pos))) {
                        next.add(meta.pos);
                    }
                }

                return next;
            },
        },
        props: {
            decorations(state) {
                return buildHeadingFoldDecorations(state.doc, headingFoldPluginKey.getState(state) ?? new Set<number>());
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

            const handleMouseMove = (event: MouseEvent) => {
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

            return {
                update() {
                    if (hoveredGutter && !view.dom.contains(hoveredGutter)) {
                        hoveredGutter = null;
                    }
                },
                destroy() {
                    view.dom.removeEventListener("mousemove", handleMouseMove);
                    view.dom.removeEventListener("mouseleave", clearHoveredGutter);
                    clearHoveredGutter();
                },
            };
        },
    }),
);
