/**
 * headingUtils.ts
 *
 * Responsibility: provide shared utility functions related to headings.
 *
 * This module extracts the scroll-detection logic shared by headingSticky and the TOC:
 * - Get the visible heading elements
 * - Get the top toolbar position
 * - Detect the currently visible heading
 * - Find the document position corresponding to a heading
 */

import type { EditorView, Node as PmNode } from "../pm";
import { changedRange } from "./textblockEdit";

const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";

/** One heading pulled from the document model: its level, trimmed text, and
 *  the position of the heading node itself (its nav/anchor target). */
export interface DocHeading {
    level: number;
    text: string;
    pos: number;
}

/**
 * A textblock's text for SLUG purposes: `textContent`, minus the source bytes
 * of any `wiki_link`.
 *
 * A wikilink holds its raw source as text content so the caret can edit it
 * (MAR-74), which puts `metric|Display` into the enclosing heading's
 * `textContent` where an atom used to contribute nothing. Slugs are the one
 * consumer where that is not merely cosmetic: a heading's slug is the anchor
 * that `[](#slug)` and `[[#heading]]` already point at in users' files, so
 * letting raw wikilink bytes into it would silently break links that resolve
 * today. Every slug source routes through here for that reason.
 *
 * What a wikilink OUGHT to contribute is a live question — it renders as its
 * display text, so a heading reads "Cost Display" while its slug says "cost".
 * This function deliberately preserves the shipped answer (nothing) rather than
 * settling it; changing it changes anchors.
 */
export function slugTextOf(node: SlugTextNode): string {
    let text = "";
    node.forEach((child) => {
        if (child.type.name === "wiki_link") {
            return;
        }
        text += child.isText ? (child.text ?? "") : child.textContent;
    });
    return text;
}

/**
 * The structural shape slugTextOf needs. Declared rather than taking `PmNode`
 * so the fold layer, which addresses nodes through its own looser
 * `ProseNodeLike`, can call this without a cast.
 */
interface SlugTextChild {
    type: { name: string };
    isText: boolean;
    text?: string | null | undefined;
    textContent: string;
}
interface SlugTextNode {
    forEach: (f: (child: SlugTextChild) => void) => void;
}

/**
 * Walk the ProseMirror document and collect its headings in document order,
 * skipping empty ones. Reads the DOC MODEL, never the rendered DOM: the model
 * text here is the clean heading text, whereas the DOM's textContent would
 * include the `##` gutter-marker glyphs and corrupt every slug.
 *
 * This is the shared outline walk behind BOTH the table of contents (whose
 * getHeadings wraps it with position caching) and the section-link picker, so
 * the two can never disagree about what the document's headings are. The walk
 * scales with BLOCKS, not characters: returning false at every textblock prunes
 * descent into inline content, and a heading's content is inline, so it can
 * never hide inside another textblock.
 */
export function collectDocHeadings(doc: PmNode): DocHeading[] {
    const headings: DocHeading[] = [];
    doc.nodesBetween(0, doc.content.size, (node, pos) => {
        if (!node.isTextblock) {
            return true; // a container — keep descending
        }
        if (node.type.name === "heading") {
            const text = slugTextOf(node).trim();
            if (text) {
                headings.push({ level: node.attrs["level"] as number, text, pos });
            }
        }
        return false; // never walk a textblock's inline content
    });
    return headings;
}

/**
 * Get the bottom position of the top toolbar (0 when hidden via toolbar.visible).
 *
 * The bar hides through a translateY slide transition, so its rect reports
 * stale geometry while animating: body.toolbar-hidden is the source of truth
 * (mirroring the --editor-topbar-height: 0px CSS contract), and when visible
 * we read the rect's height — the bar is fixed at top: 0, so its settled
 * bottom equals its height, and height is immune to the transform.
 */
export function getTopbarBottom(): number {
    if (document.body.classList.contains("toolbar-hidden")) {
        return 0;
    }
    const topbar = document.querySelector(".editor-topbar");
    return topbar ? topbar.getBoundingClientRect().height : 40;
}

/**
 * Whether `el` is INSIDE the bar `getTopbarBottom` measures.
 *
 * The pair travels together: chrome placed against the bar's bottom edge has
 * to know whether the thing it is placing lives above that edge, because for
 * an anchor in the bar the edge pushes the chrome away from what it belongs
 * to rather than clear of what would cover it (ui/tooltip.ts is the reader).
 * Here so the selector has one home rather than two.
 */
export function isInTopbar(el: Element): boolean {
    return !!el.closest(".editor-topbar");
}

/**
 * The height of the sticky heading title, or 0 when it is not showing.
 *
 * NOT the same as `measureStickyHeadingHeight` in plugins/caretScrollMargin.ts,
 * and the difference is deliberate: that one reserves an ESTIMATED height even
 * while the title is hidden, because a caret scroll may summon it mid-flight.
 * Placement needs the opposite — a popup must not be pushed down to clear a bar
 * that is not on screen — so this reports only what is actually painted.
 */
function visibleStickyHeadingHeight(): number {
    const sticky = document.querySelector<HTMLElement>(".heading-sticky-title:not([hidden])");
    return sticky ? sticky.getBoundingClientRect().height : 0;
}

/**
 * The top of the area a popup may actually occupy.
 *
 * Two opaque fixed layers stack above the document — the topbar and, under it,
 * the sticky heading title — and almost every floating
 * surface paints BELOW both. Anything placed above this line is not merely
 * awkward, it is invisible and unclickable, so "does it fit?" has to be asked
 * against this edge rather than against y=0 (`viewportSize()` in
 * ui/anchoredPlacement.ts is what feeds it to the placement engine).
 *
 * Approximation, on purpose: the sticky title spans only the content column,
 * but this treats it as full-width. That over-insets a popup opening outside
 * that column, which costs a few pixels of placement and never occlusion.
 */
export function safeAreaTop(): number {
    return getTopbarBottom() + visibleStickyHeadingHeight();
}

let stickyReservedPx = 0;

/**
 * The height CSS is currently reserving for the sticky heading title: what
 * plugins/headingSticky.ts last published as `--editor-sticky-heading-height`,
 * 0 while the bar is hidden. Held here so a reader that sizes a scroll band
 * from the bar (plugins/caretScrollMargin.ts) can take the reserved height
 * without asking layout for the bar's box, and so it moves only when the
 * reservation does: the bar's box changes with every heading level it
 * mirrors, and a band that followed the box re-wrote its own root variables
 * on every such change, each a whole-document restyle.
 */
export function stickyReservedHeight(): number {
    return stickyReservedPx;
}

/** The publisher's write; nothing else sets it. */
export function setStickyReservedHeight(px: number): void {
    stickyReservedPx = px;
}

/**
 * Fired on `window` when the sticky heading title's painted height changes
 * (plugins/headingSticky.ts, alongside its `--editor-sticky-heading-height`
 * write).
 * Chrome that MEASURES `safeAreaTop()` and caches the result in a layout pass
 * must re-run that pass on this event: the title shows and hides on its own
 * rAF, so a single scroll event (a TOC click, a find jump) can land the
 * caching pass one frame before the title appears, leaving the cached
 * placement under it with no further trigger. CSS consumers of the variable
 * restyle automatically and need no listener.
 */
export const SAFE_AREA_CHANGE_EVENT = "birta-safe-area-change";

/**
 * Scroll the window so `el` sits `margin` px below the topbar (or below the
 * viewport top when the toolbar is hidden). The single place for this offset
 * math — TOC clicks, anchor links, footnote jumps, find matches, and sticky
 * headings must all reserve the same space for the bar.
 */
export function scrollElementBelowTopbar(
    el: HTMLElement,
    margin: number = 8,
    behavior: ScrollBehavior = "smooth",
): void {
    const top = el.getBoundingClientRect().top + window.scrollY - getTopbarBottom() - margin;
    window.scrollTo({ top: Math.max(0, top), behavior });
}

/**
 * The heading elements of `view`, in document order, cached per document.
 *
 * The query itself is what costs: `querySelectorAll` walks the whole editor
 * subtree, which is 75,000 nodes on the `xlarge` fixture, and the scroll path
 * runs it twice a frame — the sticky heading and the table of contents each
 * re-derive the same list (MAR-316).
 *
 * A heading element exists only because the document holds a heading node, so
 * the document is the natural key — but doc IDENTITY alone is too coarse a key:
 * every keystroke replaces the doc, and re-querying 75,000 nodes per keystroke
 * put this walk at ~2 ms/key of the xlarge dispatch median (MAR-137). A doc
 * change whose diff region contains no heading in either doc cannot have
 * added, removed, or re-typed one, so the element set is provably intact:
 * re-key the cache to the new doc instead of re-querying. `changedRange` costs
 * structure sharing, not document size, so the check is far below the query.
 *
 * What the doc key does NOT cover is a decoration-only change that makes
 * ProseMirror rebuild a heading's DOM without touching the document. So rather
 * than reason about which decorations do that, the cache checks: a rebuilt
 * heading leaves the element we cached detached, and `isConnected` is a flag
 * read, cheap enough to run over every entry on every read.
 */
const headingCache = new WeakMap<EditorView, { doc: PmNode; elements: HTMLElement[] }>();

/**
 * Could the edit between these two docs have changed the set of heading
 * ELEMENTS the view renders? False only when the diff region provably contains
 * no heading in either doc. Exported for the heading-id sync plugin, whose
 * skip condition is exactly this one (plugins/headingIdSync.ts).
 */
export function changeTouchesHeading(prev: PmNode, next: PmNode): boolean {
    const range = changedRange(prev, next);
    if (!range) {
        return false;
    }
    return rangeTouchesHeading(prev, range.start, range.endA)
        || rangeTouchesHeading(next, range.start, range.endB);
}

function rangeTouchesHeading(doc: PmNode, from: number, to: number): boolean {
    let found = false;
    const max = doc.content.size;
    doc.nodesBetween(Math.min(from, max), Math.min(to, max), (node) => {
        if (found) {
            return false;
        }
        if (node.type.name === "heading") {
            found = true;
            return false;
        }
        // Prune inline content: a heading is a textblock and can never sit
        // inside another textblock (collectDocHeadings makes the same claim).
        return !node.isTextblock;
    });
    return found;
}

function cachedHeadings(view: EditorView): HTMLElement[] {
    const hit = headingCache.get(view);
    if (hit && hit.elements.every((el) => el.isConnected)) {
        if (hit.doc === view.state.doc) {
            return hit.elements;
        }
        if (!changeTouchesHeading(hit.doc, view.state.doc)) {
            // Re-key so the next read takes the identity fast path.
            hit.doc = view.state.doc;
            return hit.elements;
        }
    }
    const elements = Array.from(view.dom.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
    headingCache.set(view, { doc: view.state.doc, elements });
    return elements;
}

/** Get all visible heading elements (excluding those hidden by folding) */
export function getVisibleHeadings(view: EditorView): HTMLElement[] {
    return cachedHeadings(view).filter((heading) => {
        const rect = heading.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !heading.classList.contains("heading-fold-hidden");
    });
}

/** Get all heading elements (including those hidden by folding) */
export function getAllHeadings(view: EditorView): HTMLElement[] {
    // A copy: callers must not be able to reorder or truncate the cached list.
    return cachedHeadings(view).slice();
}

/**
 * Find the document position corresponding to a heading element.
 *
 * Asks the view where this element sits rather than searching the document for
 * it. `posAtDOM` resolves upward from the element through the ViewDesc tree,
 * which costs the element's depth; the search below is O(document) and calls
 * `view.nodeDOM` once per heading node it passes on the way. That is 344
 * lookups per call on the `xlarge` fixture, and the scroll path calls this many
 * times a frame: one flick of 40 frames measured 549 calls and 188,856
 * `nodeDOM` lookups (MAR-316).
 *
 * The search is kept as a fallback, and the fast path is verified rather than
 * trusted: `posAtDOM` answers for any DOM position, including ones inside a
 * heading's decorations, so the candidate only stands if the document really
 * holds a heading there and the view really renders it as this element.
 */
export function findHeadingPos(view: EditorView, heading: HTMLElement): number | null {
    try {
        // posAtDOM(el, 0) lands just inside the node's content; the node itself
        // is one position earlier.
        const pos = view.posAtDOM(heading, 0) - 1;
        if (pos >= 0 && view.state.doc.nodeAt(pos)?.type.name === "heading" && view.nodeDOM(pos) === heading) {
            return pos;
        }
    } catch {
        // posAtDOM throws for an element the view does not render (a detached
        // clone, or a heading in another editor) — fall through to the search.
    }
    let result: number | null = null;
    view.state.doc.descendants((node, pos) => {
        if (node.type.name === "heading" && view.nodeDOM(pos) === heading) {
            result = pos;
            return false;
        }
        return true;
    });
    return result;
}

/** Get a heading's text content (stripping internal elements like the fold button) */
export function getHeadingText(heading: HTMLElement): string {
    const clone = heading.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".heading-fold-gutter").forEach((node) => node.remove());
    return clone.textContent?.trim() ?? "";
}

/** Get a heading's level */
export function getHeadingLevel(heading: HTMLElement): number {
    const level = Number(heading.tagName.slice(1));
    return Number.isFinite(level) ? level : 1;
}

/**
 * Detect the currently visible active heading.
 * @param view - EditorView
 * @param threshold - the threshold position (usually topbarBottom + offset)
 * @param excludeCollapsed - whether to exclude fold-hidden headings (headingSticky needs this, the TOC does not)
 * @returns info about the active heading, or null if there is none
 */
export function findActiveHeading(
    view: EditorView,
    threshold: number,
    excludeCollapsed: boolean = true,
): { element: HTMLElement; pos: number } | null {
    const headings = excludeCollapsed ? getVisibleHeadings(view) : getAllHeadings(view);

    // Collect the candidates first and resolve a position only for the one that
    // wins. Resolving as we go asked the document for a position per heading
    // above the threshold, so scrolling deeper into a document cost strictly
    // more per frame — the same answer, priced by how far down the reader had
    // got (MAR-316). The walk backwards preserves the old fall-through: a
    // candidate the document cannot place yields to the one before it.
    const candidates: HTMLElement[] = [];
    for (const heading of headings) {
        const rect = heading.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            continue;
        }
        if (rect.top > threshold) {
            break;
        }
        candidates.push(heading);
    }

    for (let i = candidates.length - 1; i >= 0; i--) {
        const pos = findHeadingPos(view, candidates[i]);
        if (pos !== null) {
            return { element: candidates[i], pos };
        }
    }
    return null;
}
