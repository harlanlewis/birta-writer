import type { EditorView } from "@milkdown/prose/view";
import type { Node as ProseMirrorNode } from "@milkdown/prose/model";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";
import {
    IconAlertCircle,
    IconCheckSquare,
    IconChevronDown,
    IconChevronRight,
    IconCode,
    IconFootnote,
    IconImage,
    IconList,
    IconListOrdered,
    IconMath,
    IconNetwork,
    IconPilcrow,
    IconQuote,
    IconTable,
    IconTerminal,
} from "../ui/icons";
import { applyTooltip, hideTooltip } from "../ui/tooltip";
import { t } from "../i18n";
// Runtime-only cycle (blockMenu imports this module's pure helpers back);
// both sides touch the other only inside event handlers / decoration passes,
// matching the slashMenu plugin ↔ component precedent.
import { closeBlockMenu, openBlockMenu } from "../components/blockMenu";
import { isTaskListNode, isTextBearingParagraph } from "../components/blockMenu/turnInto";
import { selectionCoverRange, wireMarkerDrag } from "../components/blockMenu/drag";
import { hideRangeVeil, showRangeVeil } from "../components/blockMenu/rangeIndicator";
import { wireMarquee } from "../components/blockMenu/marquee";

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
    | { type: "delete"; from: number; to: number }
    /**
     * Replace the folded set wholesale (fold-all / unfold-all commands).
     * Positions are FINAL-doc heading positions; any that no longer resolve
     * to a heading are dropped. Same addToHistory:false semantics as
     * "toggle" — fold state is a view concern, never an undo step.
     */
    | { type: "setAll"; folded: number[] };
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
 * computeFoldRanges memoized on the doc (ProseMirror docs are immutable, so
 * the doc reference is a perfect cache key). Per-mousemove and per-keystroke
 * callers share one walk per document version instead of each paying their
 * own.
 */
const foldRangesByDoc = new WeakMap<object, Map<number, HeadingFoldRange | null>>();

export function cachedFoldRanges(doc: any): Map<number, HeadingFoldRange | null> {
    let ranges = foldRangesByDoc.get(doc);
    if (!ranges) {
        ranges = computeFoldRanges(doc);
        foldRangesByDoc.set(doc, ranges);
    }
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

/**
 * If the block at `blockPos` is a COLLAPSED foldable heading, the end of its
 * hidden section — else null. The block keyboard layer and the selection
 * cover use it so an explicit block selection over a folded heading always
 * carries the invisible body (orphaning it would let a move/delete act on
 * content the user can't see).
 */
/**
 * Every collapsed heading's section end in ONE doc pass (computeFoldRanges
 * is a single stack walk) — callers that consult many positions (unit maps,
 * cover expansion) use this instead of per-position foldedSectionEnd, which
 * would re-walk the doc for each collapsed heading.
 */
export function foldedSectionEnds(state: EditorState): ReadonlyMap<number, number> {
    const pluginState = headingFoldPluginKey.getState(state);
    if (!pluginState || pluginState.folded.size === 0) {
        return EMPTY_FOLD_MAP;
    }
    const ranges = cachedFoldRanges(state.doc);
    const ends = new Map<number, number>();
    for (const pos of pluginState.folded) {
        const range = ranges.get(pos);
        if (range) {
            ends.set(pos, range.to);
        }
    }
    return ends;
}

const EMPTY_FOLD_MAP: ReadonlyMap<number, number> = new Map();

export function foldedSectionEnd(state: EditorState, blockPos: number): number | null {
    const node = state.doc.nodeAt(blockPos);
    if (!isHeadingNode(node)) {
        return null;
    }
    if (!headingFoldPluginKey.getState(state)?.folded.has(blockPos)) {
        return null;
    }
    return findHeadingFoldRange(state.doc, blockPos)?.to ?? null;
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

/**
 * The one marker-button protocol, shared by heading badges and block icons
 * so the click/drag/menu/aria wiring can never diverge between them (it has
 * churned across four critique-round commits; a one-sided fix would make
 * headings and paragraphs respond differently).
 *
 * `name` is the block's identity for assistive tech ("H2 — Block options",
 * "Table — Block options"): with the action alone, a screen-reader scan
 * heard an undifferentiated stream of identical buttons.
 */
function createMarkerButton(
    view: EditorView,
    gutter: HTMLElement,
    name: string,
    className: string,
    render: (el: HTMLButtonElement) => void,
): HTMLButtonElement {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = className;
    render(marker);
    marker.setAttribute("aria-label", `${name} — ${t("Block options")}`);
    marker.setAttribute("aria-haspopup", "menu");
    marker.setAttribute("aria-expanded", "false");
    applyTooltip(marker, t("Click for options · Drag to move"), { placement: "above" });
    // mousedown: keep the editor selection/caret; click: open the menu.
    marker.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    // The widget lives inside the contentEditable root, so activation keys
    // on a FOCUSED marker would bubble to ProseMirror and type into the
    // document; handle them here as button activation instead.
    marker.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            marker.click();
        }
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
    return marker;
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

    // The marker is a button: clicking the level badge opens a menu to
    // retype the heading (P / H1–H6) — a level cue that doubles as a level
    // control, iA-Writer-style. The widget key encodes `level`, so the badge
    // repaints live as the heading level changes (via the heading commands,
    // this menu, or a typed `#`-space). Setext headings carry no hashes in
    // their source but still show the badge — the gutter is a level cue in
    // this WYSIWYG view, not a byte mirror, and their source round-trips as
    // setext untouched. It sits to the RIGHT of the fold chevron (distinct
    // click targets), so the two never overlap. "H2" is the same identity
    // the slash menu's heading rows show in their icon slot.
    const badge = `H${Math.min(Math.max(level, 1), 6)}`;
    const marker = createMarkerButton(view, gutter, badge, "heading-fold-marker", (el) => {
        el.textContent = badge;
        el.dataset["pill"] = badge;
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
    // Same contentEditable leak as the markers: Enter/Space on the focused
    // chevron must toggle the fold, not type into the document.
    button.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            button.click();
        }
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
 * The non-heading twin of the heading gutter: the block's slash-menu icon
 * (pilcrow, list flavor, quote, code, image, …), invisible until its block
 * is hovered (CSS), opening the block menu at full contrast when interacted
 * with — so every top-level block's conversions and actions are as reachable
 * as a heading's. No fold chevron: only headings own sections.
 */
function createBlockGutter(view: EditorView, spec: MarkerSpec, nestedDepth?: number): HTMLElement {
    const gutter = document.createElement("span");
    gutter.className = "heading-fold-gutter heading-fold-gutter--block";
    gutter.contentEditable = "false";
    if (nestedDepth !== undefined) {
        // Container children: the CSS positions the marker clear of every
        // ancestor container's border bar, one inset step per nesting level.
        // The capped depth CLASS pairs with the same class on the host so
        // hover-reveal can address "this host's own gutter" even when the
        // wrapper's NodeView buries it under chrome (see the reveal rules
        // in style.css — a plain descendant selector would pop deeper
        // children's markers along with the hovered host's own).
        gutter.classList.add("heading-fold-gutter--nested");
        gutter.classList.add(`heading-fold-gutter--d${Math.min(nestedDepth, 6)}`);
        gutter.style.setProperty("--nested-gutter-depth", String(nestedDepth));
    }

    // --paragraph kept as the P marker's stable test/back-compat hook; every
    // hover-revealed marker (including P) carries --block for shared styling.
    const marker = createMarkerButton(
        view,
        gutter,
        spec.label,
        `heading-fold-marker heading-fold-marker--block${spec.key === "P" ? " heading-fold-marker--paragraph" : ""}`,
        (el) => {
            if (spec.text !== undefined) {
                el.textContent = spec.text;
            } else {
                el.innerHTML = spec.icon;
            }
            el.dataset["pill"] = spec.label;
        },
    );

    gutter.appendChild(marker);
    return gutter;
}

/**
 * The gutter glyph for a non-heading top-level block, or null for blocks that
 * get no marker. Glyphs mirror the markdown source, dimmed (the design
 * principle the heading hashes established): `-`/`1.`/`[ ]` lists, `>` quote,
 * `[!]` callout, ``` code, `![]` standalone image, `<>` raw HTML.
 *
 * Deliberately absent: leaf atoms — `---` (hr) and orphaned
 * link_definitions — which have no content position for the in-block widget
 * to ride on (nodeSize 1); they'd need an overlay-based handle. Tables DO
 * get a marker (grab/menu/drag) alongside their own grips/insert bars —
 * the two serve different jobs (block-level vs cell-level).
 */
/** A gutter marker's rendering: the same icon its slash-menu row uses (or
 * a text badge — nested headings show H1-H6 like the slash menu's heading
 * rows), a stable fingerprint/widget key, and the drag pill's name. */
export interface MarkerSpec {
    key: string;
    icon: string;
    label: string;
    /** Text badge instead of an SVG (heading "H2"). */
    text?: string;
}

export function blockMarkerSpec(node: any): MarkerSpec | null {
    switch (node.type.name) {
        case "paragraph": {
            if (isTextBearingParagraph(node)) {
                return { key: "P", icon: IconPilcrow, label: t("Paragraph") };
            }
            let sawImage = false;
            node.forEach((child: any) => {
                if (child.type.name === "image") {
                    sawImage = true;
                }
            });
            return sawImage
                ? { key: "img", icon: IconImage, label: t("Image") }
                : { key: "html", icon: IconCode, label: t("HTML") };
        }
        // Lists get PER-ITEM markers (emitItemGutters), not a list-level one.
        case "blockquote":
            return { key: "quote", icon: IconQuote, label: t("Blockquote") };
        case "callout":
        case "notion_callout":
            return { key: "callout", icon: IconAlertCircle, label: t("Callout") };
        case "container_directive":
            return { key: "directive", icon: IconAlertCircle, label: t("Directive") };
        case "code_block": {
            const language = String(node.attrs?.["language"] ?? "").toLowerCase();
            if (language === "mermaid") {
                return { key: "mermaid", icon: IconNetwork, label: t("Mermaid Diagram") };
            }
            if (language === "latex" || language === "tex" || language === "katex") {
                return { key: "math", icon: IconMath, label: t("Math Block") };
            }
            return { key: "code", icon: IconTerminal, label: t("Code Block") };
        }
        case "footnote_definition":
            return { key: "fn", icon: IconFootnote, label: t("Footnote") };
        case "table":
            // The menu gives kind-less blocks an actions-only menu (no Turn
            // into that would mangle a table); grab/menu/drag all apply.
            return { key: "table", icon: IconTable, label: t("Table") };
        default:
            return null;
    }
}

/** True for the two list container types (items are the draggable units).
 * Exported: the single source of the grabbable-structure taxonomy (the drag
 * boundary walker consumes it too). */
export function isListNode(node: any): boolean {
    return node.type.name === "bullet_list" || node.type.name === "ordered_list";
}

/** Containers whose direct block children are grabbable units of their own
 * (all are `content: "block+"`, so drops between their children are legal).
 * Exported alongside isListNode as the taxonomy's single source. */
export function isContainerNode(node: any): boolean {
    switch (node.type.name) {
        case "blockquote":
        case "callout":
        case "notion_callout":
        case "container_directive":
            return true;
        default:
            return false;
    }
}

/** The marker for a block NESTED inside a container: its normal spec, with
 * two exceptions — text paragraphs are the container's own prose (the
 * container's marker is their handle; a P on every quoted line is noise),
 * and headings get a badge marker (nested headings don't own fold
 * sections, so no chevron machinery). */
function nestedChildSpec(node: any): MarkerSpec | null {
    if (isHeadingNode(node)) {
        const level = Math.min(Math.max(getHeadingLevel(node), 1), 6);
        return { key: `h${level}`, icon: "", label: t("Heading"), text: `H${level}` };
    }
    const spec = blockMarkerSpec(node);
    return spec?.key === "P" ? null : spec;
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
    depth = 1,
): void {
    container.forEach((child: any, offset: number) => {
        const childPos = containerPos + 1 + offset;
        if (isListNode(child)) {
            parts?.push("L");
            emitItemGutters(child, childPos, decorations, parts);
            return;
        }
        const spec = nestedChildSpec(child);
        if (spec !== null) {
            // Depth is part of the identity: it drives the marker's gutter
            // column (--nested-gutter-depth), so a block that re-nests must
            // re-render its widget, not reuse the old one.
            parts?.push(`c${depth}${spec.key}`);
            decorations?.push(
                Decoration.node(childPos, childPos + child.nodeSize, {
                    class: `block-gutter-host block-gutter-host--child block-gutter-host--d${Math.min(depth, 6)}`,
                }),
            );
            decorations?.push(
                Decoration.widget(
                    childPos + 1,
                    (view: EditorView) => createBlockGutter(view, spec, depth),
                    { key: `g:${spec.key}:n${depth}`, side: -1 },
                ),
            );
        } else {
            parts?.push("·");
        }
        if (isContainerNode(child)) {
            emitContainerChildGutters(child, childPos, decorations, parts, depth + 1);
        }
    });
}

/** The marker for ONE list item: the icon of its list flavor (matching the
 * slash menu's Bullet/Ordered/Task rows), uniform across items. */
function itemMarkerSpec(listNode: any, item: any): MarkerSpec {
    if (item.attrs["checked"] != null) {
        return { key: "task", icon: IconCheckSquare, label: t("Task") };
    }
    if (listNode.type.name === "ordered_list") {
        return { key: "ol", icon: IconListOrdered, label: t("Numbered item") };
    }
    return { key: "ul", icon: IconList, label: t("List item") };
}

/**
 * Per-item gutter markers (MAR-86): every list item — at any nesting depth —
 * is its own grabbable unit with its own glyph. The list node itself carries
 * no marker (whole-list operations are reachable by selecting all items).
 * `listPos` is the list node's document position; items' positions are
 * derived from it. Appends into `decorations` and `parts` (fingerprint).
 */
function emitItemGutters(
    listNode: any,
    listPos: number,
    decorations: Decoration[] | null,
    parts: string[] | null,
): void {
    listNode.forEach((item: any, offset: number) => {
        const itemPos = listPos + 1 + offset;
        const spec = itemMarkerSpec(listNode, item);
        parts?.push(`i${spec.key}`);
        decorations?.push(
            Decoration.node(itemPos, itemPos + item.nodeSize, {
                class: "block-gutter-host block-gutter-host--item",
            }),
        );
        decorations?.push(
            Decoration.widget(
                itemPos + 1,
                (view: EditorView) => createBlockGutter(view, spec),
                { key: `g:${spec.key}`, side: -1 },
            ),
        );
        // Nested lists inside the item: their items are units too.
        item.forEach((child: any, childOffset: number) => {
            if (isListNode(child)) {
                emitItemGutters(child, itemPos + 1 + childOffset, decorations, parts);
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
        } else if (isListNode(node)) {
            parts.push("L");
            emitItemGutters(node, offset, null, parts);
        } else {
            parts.push(blockMarkerSpec(node)?.key ?? "·");
            if (isContainerNode(node)) {
                emitContainerChildGutters(node, offset, null, parts);
            }
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
            // Lists get per-item markers (each item is the grabbable unit,
            // MAR-86); every other non-heading block with a glyph gets the
            // hover-revealed gutter marker opening the block menu, plus the
            // host class that carries the shared positioning/hover CSS.
            if (isListNode(node)) {
                emitItemGutters(node, offset, decorations, null);
                return;
            }
            const spec = blockMarkerSpec(node);
            if (spec !== null) {
                decorations.push(
                    Decoration.node(offset, offset + node.nodeSize, {
                        class: "block-gutter-host",
                    }),
                );
                decorations.push(
                    Decoration.widget(
                        offset + 1,
                        (view: EditorView) => createBlockGutter(view, spec),
                        // Stable, position-free key: same-glyph widgets reuse
                        // their DOM across rebuilds (matching is ordinal).
                        { key: `g:${spec.key}`, side: -1 },
                    ),
                );
            }
            if (isContainerNode(node)) {
                emitContainerChildGutters(node, offset, decorations, null);
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

export function findSectionHeadingPosAt(view: EditorView, pos: number): number | null {
    return sectionHeadingPosAt(view.state.doc, pos);
}

/**
 * Doc-based body of findSectionHeadingPosAt — the fold keymap commands
 * (plugins/foldCommands.ts) run on (state, dispatch) with no view in hand.
 */
export function sectionHeadingPosAt(doc: ProseMirrorNode, pos: number): number | null {
    // Innermost heading whose section contains pos — the innermost is the
    // one starting latest. One cached stack walk instead of the old
    // per-heading full-doc scan: this runs on EVERY mousemove over
    // non-heading content, where the old shape was O(headings × doc) and
    // measured 2.6ms/event on a 500-heading document.
    let headingPos: number | null = null;
    for (const [candidate, range] of cachedFoldRanges(doc)) {
        if (
            range && candidate <= pos && pos < range.to &&
            (headingPos === null || candidate > headingPos)
        ) {
            headingPos = candidate;
        }
    }
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
                        // Forward assoc: an entry must FOLLOW its heading when
                        // content is inserted exactly at the heading's start
                        // (duplicating the block above, dropping a section
                        // there). Backward assoc left the entry at the old
                        // offset — the newly inserted block inherited the
                        // collapse while the real heading expanded.
                        const mapped = tr.mapping.map(pos);
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

                if (meta?.type === "setAll") {
                    const next = new Set<number>();
                    for (const pos of meta.folded) {
                        if (isHeadingNode(newState.doc.nodeAt(pos))) {
                            next.add(pos);
                        }
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

            // Multi-block selection discoverability: while the selection
            // spans several top-level blocks, their markers surface at
            // resting contrast — "drag any of these and they all move".
            // Classes go on the MARKER (widget DOM — invisible to PM's
            // observer); mutating the block elements would redraw them.
            let coveredMarkers: HTMLElement[] = [];
            let coverKey = "";
            const syncSelectionCover = (): void => {
                // A drag in flight owns the singleton indicator (drag-mode
                // veil); an external-sync transaction mid-drag must not
                // repaint it as the selection tint — stop() reconciles.
                if (document.body.classList.contains("block-dragging")) {
                    return;
                }
                const cover = selectionCoverRange(view);
                const key = cover ? `${cover.from}:${cover.to}` : "";
                if (key === coverKey && coveredMarkers.every((m) => m.isConnected)) {
                    return;
                }
                coverKey = key;
                coveredMarkers.forEach((m) => m.classList.remove("heading-fold-marker--covered"));
                coveredMarkers = [];
                // One visual language for "these blocks are included": the
                // same veil the drag uses dims the covered range live while
                // the multi-block selection exists (MAR-85).
                if (cover) {
                    showRangeVeil(view, cover, "select");
                } else {
                    hideRangeVeil();
                }
                if (!cover) {
                    return;
                }
                view.state.doc.forEach((node: any, offset: number) => {
                    if (offset < cover.from || offset >= cover.to) {
                        return;
                    }
                    const dom = view.nodeDOM(offset);
                    if (dom instanceof HTMLElement) {
                        // querySelectorAll: a covered LIST carries one marker
                        // per item — every one must surface, not just the
                        // first, or "all of these move together" undersells.
                        // Container CHILDREN stay quiet though: the
                        // container's own marker is the "this moves" cue,
                        // and child markers now drag their own block, not
                        // the cover.
                        for (const markerEl of dom.querySelectorAll<HTMLElement>(".heading-fold-marker")) {
                            if (markerEl.closest(".block-gutter-host--child")) {
                                continue;
                            }
                            markerEl.classList.add("heading-fold-marker--covered");
                            coveredMarkers.push(markerEl);
                        }
                    }
                });
            };

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
            const disposeMarquee = wireMarquee(view);

            return {
                update(updatedView, prevState) {
                    // Any document change invalidates an open block menu's
                    // captured position (and may destroy its anchor marker) —
                    // close it. Selection-only transactions keep the same doc
                    // node, so this never fires for caret movement.
                    if (updatedView.state.doc !== prevState.doc) {
                        closeBlockMenu();
                    }
                    syncSelectionCover();
                    if (hoveredGutter && !view.dom.contains(hoveredGutter)) {
                        hoveredGutter = null;
                    }
                },
                destroy() {
                    view.dom.removeEventListener("mousemove", handleMouseMove);
                    view.dom.removeEventListener("mouseleave", clearHoveredGutter);
                    view.dom.removeEventListener("keydown", handleKeyDown);
                    document.body.classList.remove("gutter-quiet");
                    disposeMarquee();
                    // A selection-cover veil must not outlive its editor
                    // (revert/reload recreates the view; the fresh plugin's
                    // first sync would otherwise early-return and leave the
                    // stale veil painted over the new document).
                    hideRangeVeil();
                    clearHoveredGutter();
                },
            };
        },
    }),
);
