import type { EditorView } from "@milkdown/prose/view";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { keymap } from "@milkdown/prose/keymap";
import {
    Plugin,
    Selection,
    TextSelection,
    type Command,
    type EditorState,
    type Transaction,
} from "@milkdown/prose/state";
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
import { createFoldEllipsis } from "../ui/foldEllipsis";
import { foldingEnabled } from "../utils/foldingControls";
import { slugify } from "../utils/slug";
import { getWebviewState, setWebviewState } from "../messaging";
import { t } from "../i18n";
// Runtime-only cycle (blockMenu imports this module's pure helpers back);
// both sides touch the other only inside event handlers / decoration passes,
// matching the slashMenu plugin ↔ component precedent.
import { closeBlockMenu, openBlockMenu } from "../components/blockMenu";
import { isTextBearingParagraph } from "../blockCapabilities";
import { selectionCoverRange, wireMarkerDrag } from "../components/blockMenu/drag";
import { hideRangeVeil, showRangeVeil } from "../components/blockMenu/rangeIndicator";
import { wireMarquee } from "../components/blockMenu/marquee";

// The key, state shape, and meta vocabulary live in ./foldState (a
// dependency-light module NodeViews can import without cycling through the
// menu component graph); re-exported here as the historical import surface.
import {
    foldPluginKey,
    type FoldMeta,
    type FoldPluginState,
} from "./foldState";

export {
    foldPluginKey,
    headingFoldPluginKey,
    type FoldMeta,
    type FoldPluginState,
    type HeadingFoldMeta,
    type HeadingFoldState,
} from "./foldState";

type HeadingFoldRange = { from: number; to: number };

type ProseNodeLike = {
    type: { name: string };
    attrs?: Record<string, unknown>;
    nodeSize: number;
};

function isHeadingNode(node: ProseNodeLike | null | undefined): node is ProseNodeLike {
    return node?.type.name === "heading";
}

function isCalloutNode(node: { type: { name: string } } | null | undefined): boolean {
    return node?.type.name === "callout";
}

/**
 * A callout is foldable whenever it has a body (MAR-110 — no longer only
 * when the source carries a `+`/`-` marker): anything beyond one empty
 * paragraph counts.
 */
export function calloutHasBody(node: { childCount: number; firstChild: { childCount: number } | null }): boolean {
    return !(node.childCount === 1 && (node.firstChild?.childCount ?? 0) === 0);
}

/**
 * THE foldable-callout invariant, shared by every layer that can create or
 * honor a callout fold (the meta guards in apply(), Fold All, fold-at-caret,
 * persistence restore, syntax seeding, and — via foldHiddenRange — the caret
 * guard and drop guards): a callout nested inside a list item is NOT
 * foldable. The decoration pass renders fold chrome only for top-level
 * blocks and container children (emitContainerChildGutters); list-item
 * children go through emitItemGutters, which has no fold context, so a fold
 * entry there would hide nothing visibly while the caret guard ejected
 * carets from the "hidden" body and drop guards vetoed the region — an
 * invisible fold, unrecoverable by undo (fold metas are history-exempt).
 * Feature-completing this (threading fold context through emitItemGutters)
 * is the future alternative to the restriction.
 */
function isFoldableCallout(doc: any, pos: number, node: any): boolean {
    if (!isCalloutNode(node) || !calloutHasBody(node)) {
        return false;
    }
    const $pos = doc.resolve(pos);
    for (let depth = $pos.depth; depth > 0; depth--) {
        if ($pos.node(depth).type.name === "list_item") {
            return false;
        }
    }
    return true;
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
    const pluginState = foldPluginKey.getState(state);
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
    if (!foldPluginKey.getState(state)?.folded.has(blockPos)) {
        return null;
    }
    return findHeadingFoldRange(state.doc, blockPos)?.to ?? null;
}

/**
 * The content range a fold at `pos` HIDES when collapsed, or null when the
 * block isn't foldable. The two kinds differ in where the hidden content
 * lives: a heading hides its following section (blocks OUTSIDE the node),
 * a callout hides its own body (blocks INSIDE the node). Everything that
 * needs to reason about invisible content — drop guards, reveal-on-navigate,
 * the caret skip-over — derives from this one map.
 */
export function foldHiddenRange(doc: any, pos: number): HeadingFoldRange | null {
    const node = doc.nodeAt(pos);
    if (isHeadingNode(node)) {
        // Only top-level headings own sections; the ranges map is keyed by
        // top-level offsets, so a nested heading simply misses.
        return cachedFoldRanges(doc).get(pos) ?? null;
    }
    // isFoldableCallout also excludes list-item-nested callouts, so the meta
    // guards, the caret guard, and the drop guards all inherit the
    // state/decoration-parity invariant from this one map.
    if (isFoldableCallout(doc, pos, node)) {
        return { from: pos + 1, to: pos + node.nodeSize - 1 };
    }
    return null;
}

/** Every currently-hidden range (both kinds), with its owning fold position. */
export function foldedHiddenRanges(
    state: EditorState,
): { pos: number; from: number; to: number }[] {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState || pluginState.folded.size === 0) {
        return [];
    }
    const out: { pos: number; from: number; to: number }[] = [];
    for (const pos of pluginState.folded) {
        const range = foldHiddenRange(state.doc, pos);
        if (range) {
            out.push({ pos, from: range.from, to: range.to });
        }
    }
    return out;
}

/**
 * Whether the hidden range owned by `range.pos` makes boundary `target` an
 * illegal landing site — the ONE open/closed rule every consumer shares
 * (the move primitive, the drag slot filter, the native-drop guard). The
 * two fold kinds differ at the range's end:
 *   - a HEADING hides FOLLOWING sibling blocks: `to` is the first visible
 *     boundary after the section, a legal slot — half-open;
 *   - a CALLOUT hides its own body: the end-of-body slot at `to` is still
 *     inside the collapsed node — inclusive.
 * `from`/`to` come from the argument (not re-derived), so callers that map
 * the span through pending steps (contentGuard's drop gate) share the rule.
 */
export function hiddenRangeCoversTarget(
    doc: any,
    range: { pos: number; from: number; to: number },
    target: number,
): boolean {
    const halfOpen = isHeadingNode(doc.nodeAt(range.pos));
    return target >= range.from && (halfOpen ? target < range.to : target <= range.to);
}

/**
 * True when a block boundary at `pos` sits inside content a collapsed fold
 * hides — the single target-legality registry (MAR-112). The move primitive
 * (editing/moveBlocks) rejects such targets and the drag UI
 * (visibleBoundaryPositions) never offers them, both through this function,
 * so UI slots and primitive legality cannot drift.
 */
export function isHiddenTargetPos(state: EditorState, pos: number): boolean {
    return foldedHiddenRanges(state).some((range) =>
        hiddenRangeCoversTarget(state.doc, range, pos));
}

/**
 * An explicit ENTRY intent into hidden content (Find match navigation, TOC
 * click, goto-symbol): unfold every fold whose hidden range contains `pos`
 * and leave them unfolded — VS Code's reveal semantics. No-op when the
 * target is already visible.
 */
export function revealPosition(view: EditorView, pos: number): void {
    const containing = foldedHiddenRanges(view.state).filter(
        (r) => pos >= r.from && pos < r.to,
    );
    if (containing.length === 0) {
        return;
    }
    view.dispatch(
        view.state.tr
            .setMeta(foldPluginKey, {
                type: "setMany",
                positions: containing.map((r) => r.pos),
                folded: false,
            } satisfies FoldMeta)
            .setMeta("addToHistory", false),
    );
}

/** Whether `pos` holds a block the fold plugin may keep an entry for. */
function isFoldEntryAt(doc: any, pos: number): boolean {
    const node = doc.nodeAt(pos);
    return isHeadingNode(node) || isCalloutNode(node);
}

function cleanFoldedPositions(doc: any, folded: Iterable<number>): Set<number> {
    const next = new Set<number>();
    for (const pos of folded) {
        // The block must still exist AND still hide something: a heading
        // whose section was emptied by edits (fold range now null) resets to
        // open. A kept entry would show no chevron and no ellipsis, then
        // silently swallow the next content to appear under the heading.
        if (foldHiddenRange(doc, pos) !== null) {
            next.add(pos);
        }
    }
    return next;
}

/** Every foldable position in the doc: top-level heading sections plus
 * foldable callouts (any depth outside list items — see isFoldableCallout).
 * Drives Fold All. */
export function allFoldablePositions(doc: any): number[] {
    const positions: number[] = [];
    for (const [pos, range] of cachedFoldRanges(doc)) {
        if (range) {
            positions.push(pos);
        }
    }
    doc.descendants((node: any, pos: number) => {
        if (isFoldableCallout(doc, pos, node)) {
            positions.push(pos);
        }
        return true;
    });
    return positions;
}

// ─── T2 persistence (webview state bag, structural anchors) ─────────────────

/**
 * Fold state persisted as structural anchors, not positions — absolute
 * positions rot across external edits/reverts. Headings anchor as
 * `slug:occurrenceIndex` (the link-anchor identity scheme, shared/slug.ts);
 * callouts as a root-relative child-index path (`"2"`, `"1/0"`). On restore,
 * anchors that no longer resolve are dropped silently (never guess).
 */
export interface FoldAnchors {
    headings: string[];
    callouts: string[];
}

const FOLD_ANCHORS_STATE_KEY = "foldAnchors";

export function computeFoldAnchors(doc: any, folded: ReadonlySet<number>): FoldAnchors {
    const headings: string[] = [];
    const callouts: string[] = [];
    if (folded.size === 0) {
        return { headings, callouts };
    }
    const counts = new Map<string, number>();
    doc.forEach((node: any, offset: number) => {
        if (!isHeadingNode(node)) {
            return;
        }
        const slug = slugify((node as { textContent?: string }).textContent ?? "");
        const occurrence = counts.get(slug) ?? 0;
        counts.set(slug, occurrence + 1);
        if (folded.has(offset)) {
            headings.push(`${slug}:${occurrence}`);
        }
    });
    for (const pos of folded) {
        if (!isCalloutNode(doc.nodeAt(pos))) {
            continue;
        }
        const $pos = doc.resolve(pos);
        const path: number[] = [];
        for (let depth = 0; depth <= $pos.depth; depth++) {
            path.push($pos.index(depth));
        }
        callouts.push(path.join("/"));
    }
    return { headings, callouts };
}

export function resolveFoldAnchors(doc: any, anchors: FoldAnchors): Set<number> {
    const folded = new Set<number>();
    const wanted = new Set(anchors.headings);
    if (wanted.size > 0) {
        const ranges = cachedFoldRanges(doc);
        const counts = new Map<string, number>();
        doc.forEach((node: any, offset: number) => {
            if (!isHeadingNode(node)) {
                return;
            }
            const slug = slugify((node as { textContent?: string }).textContent ?? "");
            const occurrence = counts.get(slug) ?? 0;
            counts.set(slug, occurrence + 1);
            if (wanted.has(`${slug}:${occurrence}`) && ranges.get(offset)) {
                folded.add(offset);
            }
        });
    }
    for (const encoded of anchors.callouts) {
        const path = encoded.split("/").map(Number);
        if (path.length === 0 || path.some((i) => !Number.isInteger(i) || i < 0)) {
            continue;
        }
        let node: any = doc;
        let pos = 0;
        let resolved = true;
        for (let depth = 0; depth < path.length; depth++) {
            const index = path[depth]!;
            if (index >= node.childCount) {
                resolved = false;
                break;
            }
            let childPos = depth === 0 ? 0 : pos + 1;
            for (let sibling = 0; sibling < index; sibling++) {
                childPos += node.child(sibling).nodeSize;
            }
            pos = childPos;
            node = node.child(index);
        }
        // Same predicate as the live layers: an anchor persisted for a
        // callout that is no longer foldable (or never was — e.g. a
        // list-item-nested one from an older build) is dropped, never
        // restored into an invisible fold.
        if (resolved && isFoldableCallout(doc, pos, node)) {
            folded.add(pos);
        }
    }
    return folded;
}

function readPersistedFoldAnchors(): FoldAnchors | null {
    const raw = getWebviewState()?.[FOLD_ANCHORS_STATE_KEY];
    if (!raw || typeof raw !== "object") {
        return null;
    }
    const partial = raw as Partial<FoldAnchors>;
    const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    return { headings: strings(partial.headings), callouts: strings(partial.callouts) };
}

function persistFoldAnchors(state: EditorState): void {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState) {
        return;
    }
    setWebviewState({
        ...(getWebviewState() ?? {}),
        [FOLD_ANCHORS_STATE_KEY]: computeFoldAnchors(state.doc, pluginState.folded),
    });
}

/** T1 default state from syntax: `[!kind]-` callouts start collapsed. */
function seedSyntaxFolds(doc: any): Set<number> {
    const folded = new Set<number>();
    doc.descendants((node: any, pos: number) => {
        if (node.attrs?.["fold"] === "-" && isFoldableCallout(doc, pos, node)) {
            folded.add(pos);
        }
        return true;
    });
    return folded;
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

/**
 * The one fold-chevron protocol, shared by heading gutters and callout
 * gutters (MAR-110): derive the block position at interaction time, dispatch
 * the shared toggle meta with zero steps and no history entry, and eject a
 * selection that would otherwise end up inside the newly hidden range.
 */
function createFoldToggle(view: EditorView, gutter: HTMLElement, collapsed: boolean): HTMLButtonElement {
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

        const blockPos = gutterBlockPos(view, gutter);
        const node = blockPos === null ? null : view.state.doc.nodeAt(blockPos);
        if (blockPos === null || !(isHeadingNode(node) || isCalloutNode(node))) {
            return;
        }

        const tr = view.state.tr
            .setMeta(foldPluginKey, { type: "toggle", pos: blockPos } satisfies FoldMeta)
            .setMeta("addToHistory", false);

        if (!collapsed) {
            const range = foldHiddenRange(view.state.doc, blockPos);
            if (
                range &&
                view.state.selection.from < range.to &&
                view.state.selection.to > range.from
            ) {
                // A heading keeps a visible caret home on its own line; a
                // collapsed callout has none, so the caret lands just before.
                tr.setSelection(
                    isHeadingNode(node)
                        ? TextSelection.near(tr.doc.resolve(Math.min(blockPos + 1, tr.doc.content.size)))
                        : Selection.near(tr.doc.resolve(blockPos), -1),
                );
            }
        }

        view.dispatch(tr);
        view.focus();
        hideTooltip();
    });
    return button;
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

    gutter.appendChild(createFoldToggle(view, gutter, collapsed));
    gutter.appendChild(marker);
    return gutter;
}

/** Chevron state for a foldable non-heading block's gutter (callouts). */
interface GutterFoldInfo {
    foldable: boolean;
    collapsed: boolean;
}

/**
 * The non-heading twin of the heading gutter: the block's slash-menu icon
 * (pilcrow, list flavor, quote, code, image, …), invisible until its block
 * is hovered (CSS), opening the block menu at full contrast when interacted
 * with — so every top-level block's conversions and actions are as reachable
 * as a heading's. Foldable blocks (callouts with a body) get the same fold
 * chevron headings carry, left of the marker (MAR-110).
 */
function createBlockGutter(
    view: EditorView,
    spec: MarkerSpec,
    nestedDepth?: number,
    fold?: GutterFoldInfo,
): HTMLElement {
    const gutter = document.createElement("span");
    gutter.className = `heading-fold-gutter heading-fold-gutter--block${fold?.foldable ? " heading-fold-gutter--foldable" : ""}`;
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

    if (fold?.foldable) {
        gutter.appendChild(createFoldToggle(view, gutter, fold.collapsed));
    }
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
    foldCtx: { folded: ReadonlySet<number>; enabled: boolean },
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
            const fold = calloutFoldInfo(child, childPos, foldCtx);
            const foldKey = foldKeyPart(fold);
            // Depth is part of the identity: it drives the marker's gutter
            // column (--nested-gutter-depth), so a block that re-nests must
            // re-render its widget, not reuse the old one.
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
    });
}

/** Fold info for a callout block's gutter, or null for everything else
 * (and for everything while `editor.folding` is off — zero fold chrome). */
function calloutFoldInfo(
    node: any,
    pos: number,
    foldCtx: { folded: ReadonlySet<number>; enabled: boolean },
): GutterFoldInfo | null {
    if (!foldCtx.enabled || !isCalloutNode(node)) {
        return null;
    }
    return { foldable: calloutHasBody(node), collapsed: foldCtx.folded.has(pos) };
}

/** The widget-key / fingerprint suffix a fold state contributes. */
function foldKeyPart(fold: GutterFoldInfo | null): string {
    if (!fold) {
        return "";
    }
    return `${fold.collapsed ? "c" : "o"}${fold.foldable ? "f" : "l"}`;
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
            emitItemGutters(node, offset, null, parts);
        } else {
            const fold = calloutFoldInfo(node, offset, foldCtx);
            parts.push(`${blockMarkerSpec(node)?.key ?? "·"}${foldKeyPart(fold)}`);
            if (isContainerNode(node)) {
                emitContainerChildGutters(node, offset, null, parts, foldCtx);
            }
        }
    });
    return parts.join("|");
}

/** The heading's collapsed `…` widget (mirrors `editor.unfoldOnClickAfterEndOfLine`):
 * expand is a `set` meta targeting the heading derived at CLICK time. */
function createHeadingEllipsis(view: EditorView, hiddenCount: number): HTMLElement {
    const ellipsis = createFoldEllipsis(hiddenCount, () => {
        if (!ellipsis.dom.isConnected) {
            return;
        }
        try {
            const $pos = view.state.doc.resolve(view.posAtDOM(ellipsis.dom, 0));
            if ($pos.depth < 1 || !isHeadingNode($pos.node(1))) {
                return;
            }
            view.dispatch(
                view.state.tr
                    .setMeta(foldPluginKey, {
                        type: "set",
                        pos: $pos.before(1),
                        folded: false,
                    } satisfies FoldMeta)
                    .setMeta("addToHistory", false),
            );
            view.focus();
        } catch {
            /* widget no longer resolvable — nothing to expand */
        }
    });
    return ellipsis.dom;
}

function buildHeadingFoldDecorations(
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
                emitItemGutters(node, offset, decorations, null);
                return;
            }
            const spec = blockMarkerSpec(node);
            const fold = calloutFoldInfo(node, offset, foldCtx);
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

function isHeadingElement(element: Element | null): element is HTMLElement {
    return element instanceof HTMLElement && element.matches("h1,h2,h3,h4,h5,h6");
}

function findSectionHeadingPosAt(view: EditorView, pos: number): number | null {
    // Innermost heading whose section contains pos — the innermost is the
    // one starting latest. One cached stack walk instead of the old
    // per-heading full-doc scan: this runs on EVERY mousemove over
    // non-heading content, where the old shape was O(headings × doc) and
    // measured 2.6ms/event on a 500-heading document.
    let headingPos: number | null = null;
    for (const [candidate, range] of cachedFoldRanges(view.state.doc)) {
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
    new Plugin<FoldPluginState>({
        key: foldPluginKey,
        state: {
            init: (_config, state) => {
                // `editor.folding: false` disables the layer wholesale: no
                // seeds, no restore, zero fold chrome in the decorations.
                const enabled = foldingEnabled();
                let folded: Set<number> = new Set();
                if (enabled) {
                    // Persisted view state wins when present (it is the full
                    // fold state, including "user expanded a [!kind]- callout");
                    // a first open seeds from the syntax defaults (T1).
                    const persisted = readPersistedFoldAnchors();
                    folded = persisted
                        ? resolveFoldAnchors(state.doc, persisted)
                        : seedSyntaxFolds(state.doc);
                }
                return {
                    folded,
                    enabled,
                    decorations: buildHeadingFoldDecorations(state.doc, folded, enabled),
                    fingerprint: structureFingerprint(state.doc, folded, computeFoldRanges(state.doc), enabled),
                };
            },
            apply(tr, value, _oldState, newState) {
                const meta = tr.getMeta(foldPluginKey) as FoldMeta | undefined;
                let folded: ReadonlySet<number> = value.folded;
                let enabled = value.enabled;

                if (tr.docChanged) {
                    const move = meta?.type === "move" ? meta : null;
                    const del = meta?.type === "delete" ? meta : null;
                    const next = new Set<number>();
                    for (const pos of value.folded) {
                        // Entries inside a moved range travel with the
                        // content to its new location.
                        if (move && pos >= move.from && pos < move.to) {
                            const relocated = move.insertAt + (pos - move.from);
                            if (isFoldEntryAt(newState.doc, relocated)) {
                                next.add(relocated);
                            }
                            continue;
                        }
                        // Entries inside a deleted block die with it.
                        if (del && pos >= del.from && pos < del.to) {
                            continue;
                        }
                        // Forward assoc: an entry must FOLLOW its block when
                        // content is inserted exactly at the block's start
                        // (duplicating the block above, dropping a section
                        // there). Backward assoc left the entry at the old
                        // offset — the newly inserted block inherited the
                        // collapse while the real block expanded.
                        const mapped = tr.mapping.map(pos);
                        if (isFoldEntryAt(newState.doc, mapped)) {
                            next.add(mapped);
                        }
                    }
                    folded = cleanFoldedPositions(newState.doc, next);
                }

                switch (meta?.type) {
                    case "toggle": {
                        const next = new Set<number>(folded);
                        if (next.has(meta.pos)) {
                            next.delete(meta.pos);
                        } else if (enabled && foldHiddenRange(newState.doc, meta.pos)) {
                            next.add(meta.pos);
                        }
                        folded = next;
                        break;
                    }
                    case "set":
                    case "setMany": {
                        const positions = meta.type === "set" ? [meta.pos] : meta.positions;
                        const next = new Set<number>(folded);
                        for (const pos of positions) {
                            if (!meta.folded) {
                                next.delete(pos);
                            } else if (enabled && foldHiddenRange(newState.doc, pos)) {
                                next.add(pos);
                            }
                        }
                        folded = next;
                        break;
                    }
                    case "foldAll":
                        if (enabled) {
                            folded = new Set(allFoldablePositions(newState.doc));
                        }
                        break;
                    case "unfoldAll":
                        folded = new Set();
                        break;
                    case "setEnabled":
                        enabled = meta.enabled;
                        if (!enabled) {
                            // The layer going off expands every UI-only fold.
                            folded = new Set();
                        }
                        break;
                }

                // Selection-only transaction, nothing folded/unfolded: the
                // state is untouched — zero decoration work per caret move.
                if (!tr.docChanged && folded === value.folded && enabled === value.enabled) {
                    return value;
                }

                const fingerprint = structureFingerprint(
                    newState.doc,
                    folded,
                    computeFoldRanges(newState.doc),
                    enabled,
                );
                if (fingerprint === value.fingerprint) {
                    if (!tr.docChanged) {
                        return { folded, enabled, fingerprint, decorations: value.decorations };
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
                        return { folded, enabled, fingerprint, decorations: mapped };
                    }
                }
                return {
                    folded,
                    enabled,
                    fingerprint,
                    decorations: buildHeadingFoldDecorations(newState.doc, folded, enabled),
                };
            },
        },
        /**
         * Caret skip-over (VS Code semantics): a bare caret must never rest
         * inside a hidden range — vertical motion, Home/End, or programmatic
         * selection landing there is mapped just past the fold, in the
         * direction of travel. Explicit entry intents unfold FIRST
         * (revealPosition), so this only catches accidental entries.
         */
        appendTransaction(_trs, oldState, newState) {
            const pluginState = foldPluginKey.getState(newState);
            if (!pluginState?.enabled || pluginState.folded.size === 0) {
                return null;
            }
            const sel = newState.selection;
            if (!sel.empty) {
                return null;
            }
            const pos = sel.from;
            const containing = foldedHiddenRanges(newState).filter(
                (r) => pos >= r.from && pos < r.to,
            );
            if (containing.length === 0) {
                return null;
            }
            const from = Math.min(...containing.map((r) => r.from));
            const to = Math.max(...containing.map((r) => r.to));
            const forward = pos >= oldState.selection.from;
            const target =
                forward && to < newState.doc.content.size
                    ? Selection.near(newState.doc.resolve(to), 1)
                    : Selection.near(newState.doc.resolve(from), -1);
            if (target.eq(sel)) {
                return null;
            }
            return newState.tr.setSelection(target).setMeta("addToHistory", false);
        },
        props: {
            decorations(state) {
                return foldPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
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
                    // T2 persistence: write structural anchors into the
                    // webview state bag whenever the fold set changes (or a
                    // doc edit shifts what existing anchors point at) — the
                    // same bag as scrollY/fmCollapsed, so folds survive the
                    // tab-hide webview teardown.
                    const foldState = foldPluginKey.getState(updatedView.state);
                    const prevFoldState = foldPluginKey.getState(prevState);
                    if (
                        foldState && prevFoldState && foldState.enabled &&
                        (foldState.folded !== prevFoldState.folded ||
                            (updatedView.state.doc !== prevState.doc && foldState.folded.size > 0))
                    ) {
                        persistFoldAnchors(updatedView.state);
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

// ─── Fold commands (MAR-110: markdownWysiwyg.editor.fold/unfold/…) ──────────

/** Every foldable containing `pos` (heading line or section; callout node),
 * innermost first. */
function foldablesContaining(state: EditorState, pos: number): number[] {
    const candidates: number[] = [];
    for (const [candidate, range] of cachedFoldRanges(state.doc)) {
        if (range && pos >= candidate && pos < range.to) {
            candidates.push(candidate);
        }
    }
    const $pos = state.doc.resolve(Math.min(pos, state.doc.content.size));
    for (let depth = 1; depth <= $pos.depth; depth++) {
        const node = $pos.node(depth);
        // isFoldableCallout keeps list-item-nested callouts out — the fold
        // command must never target what the decoration pass won't render.
        if (isCalloutNode(node) && isFoldableCallout(state.doc, $pos.before(depth), node)) {
            candidates.push($pos.before(depth));
        }
    }
    return candidates.sort((a, b) => b - a);
}

/** Dispatch a single idempotent fold/unfold with the shared invariants:
 * zero steps, no history entry, selection ejected out of hidden content. */
function dispatchFold(
    state: EditorState,
    dispatch: (tr: Transaction) => void,
    pos: number,
    folded: boolean,
): void {
    const tr = state.tr
        .setMeta(foldPluginKey, { type: "set", pos, folded } satisfies FoldMeta)
        .setMeta("addToHistory", false);
    if (folded) {
        const range = foldHiddenRange(state.doc, pos);
        if (range && state.selection.from < range.to && state.selection.to > range.from) {
            tr.setSelection(
                isHeadingNode(state.doc.nodeAt(pos))
                    ? TextSelection.near(tr.doc.resolve(Math.min(pos + 1, tr.doc.content.size)))
                    : Selection.near(tr.doc.resolve(pos), -1),
            );
        }
    }
    dispatch(tr);
}

/**
 * Fold the innermost foldable containing the caret; when it is already
 * folded, bubble to the nearest still-open foldable ancestor (VS Code's
 * fold-at-cursor semantics).
 */
export const foldAtCaret: Command = (state, dispatch) => {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState?.enabled) {
        return false;
    }
    for (const pos of foldablesContaining(state, state.selection.from)) {
        if (!pluginState.folded.has(pos)) {
            if (dispatch) {
                dispatchFold(state, dispatch, pos, true);
            }
            return true;
        }
    }
    return false;
};

/** Unfold the innermost folded foldable at the caret. */
export const unfoldAtCaret: Command = (state, dispatch) => {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState?.enabled) {
        return false;
    }
    for (const pos of foldablesContaining(state, state.selection.from)) {
        if (pluginState.folded.has(pos)) {
            if (dispatch) {
                dispatchFold(state, dispatch, pos, false);
            }
            return true;
        }
    }
    return false;
};

export const foldAllCommand: Command = (state, dispatch) => {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState?.enabled) {
        return false;
    }
    if (allFoldablePositions(state.doc).length === 0) {
        return false;
    }
    if (dispatch) {
        dispatch(
            state.tr
                .setMeta(foldPluginKey, { type: "foldAll" } satisfies FoldMeta)
                .setMeta("addToHistory", false),
        );
    }
    return true;
};

export const unfoldAllCommand: Command = (state, dispatch) => {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState?.enabled || pluginState.folded.size === 0) {
        return false;
    }
    if (dispatch) {
        dispatch(
            state.tr
                .setMeta(foldPluginKey, { type: "unfoldAll" } satisfies FoldMeta)
                .setMeta("addToHistory", false),
        );
    }
    return true;
};

// ─── Backspace/Delete at a fold boundary: reveal, never edit hidden content ─

/** Backspace at the start of a top-level textblock whose previous visible
 * neighbor is a collapsed fold: expand it instead of deleting into it. */
export const revealOnBackspace: Command = (state, dispatch) => {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState?.enabled || pluginState.folded.size === 0) {
        return false;
    }
    const sel = state.selection;
    const $from = sel.$from;
    if (!sel.empty || $from.depth !== 1 || $from.parentOffset !== 0) {
        return false;
    }
    const blockStart = $from.before(1);
    // A collapsed heading's hidden section ending exactly here…
    const section = foldedHiddenRanges(state).find((r) => r.to === blockStart);
    if (section) {
        if (dispatch) {
            dispatchFold(state, dispatch, section.pos, false);
        }
        return true;
    }
    // …or a collapsed callout immediately before (its body is the hidden part).
    const before = state.doc.resolve(blockStart).nodeBefore;
    if (before && isCalloutNode(before) && pluginState.folded.has(blockStart - before.nodeSize)) {
        if (dispatch) {
            dispatchFold(state, dispatch, blockStart - before.nodeSize, false);
        }
        return true;
    }
    return false;
};

/** Delete at the end of a collapsed heading line (forward-deleting into its
 * hidden section) or just before a collapsed callout: expand instead. */
export const revealOnDelete: Command = (state, dispatch) => {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState?.enabled || pluginState.folded.size === 0) {
        return false;
    }
    const sel = state.selection;
    const $from = sel.$from;
    if (!sel.empty || $from.depth !== 1 || $from.parentOffset !== $from.parent.content.size) {
        return false;
    }
    const blockStart = $from.before(1);
    if (pluginState.folded.has(blockStart) && isHeadingNode(state.doc.nodeAt(blockStart))) {
        if (dispatch) {
            dispatchFold(state, dispatch, blockStart, false);
        }
        return true;
    }
    const blockEnd = $from.after(1);
    const after = state.doc.resolve(blockEnd).nodeAfter;
    if (after && isCalloutNode(after) && pluginState.folded.has(blockEnd)) {
        if (dispatch) {
            dispatchFold(state, dispatch, blockEnd, false);
        }
        return true;
    }
    return false;
};

/**
 * Enter (split) or Mod-Enter (insert paragraph below) with the caret on a
 * COLLAPSED heading's line: the new block would land at the first position
 * of the hidden range — instantly display:none — and the caret guard would
 * then eject the caret into the next visible section (or, at doc end, snap
 * it back so Enter seemed dead while hidden empty paragraphs accreted).
 * Unfold first (revealOnBackspace's philosophy: edits at a fold boundary
 * reveal, never touch hidden content) and ALWAYS return false, so the
 * default Enter handling proceeds against the now-visible section.
 */
export const revealOnEnter: Command = (state, dispatch) => {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState?.enabled || pluginState.folded.size === 0) {
        return false;
    }
    const $from = state.selection.$from;
    if ($from.depth !== 1) {
        return false;
    }
    const blockStart = $from.before(1);
    if (
        !pluginState.folded.has(blockStart) ||
        !isHeadingNode(state.doc.nodeAt(blockStart)) ||
        foldHiddenRange(state.doc, blockStart) === null
    ) {
        return false;
    }
    if (dispatch) {
        dispatchFold(state, dispatch, blockStart, false);
    }
    return false; // never consume — the split/insert runs on the unfolded state
};

/** Typing-level fold-boundary guards (plain keys — not rebindable chords).
 * Registered BEFORE the presets and insertParagraphKeymapPlugin (editor.ts):
 * revealOnEnter must dispatch its unfold before the default Enter /
 * Mod-Enter handlers read the state. */
export const foldRevealKeymapPlugin = $prose(() =>
    keymap({
        "Backspace": revealOnBackspace,
        "Delete": revealOnDelete,
        "Enter": revealOnEnter,
        "Mod-Enter": revealOnEnter,
    }),
);
