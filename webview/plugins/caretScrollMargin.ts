import { Plugin } from "../pm";
import type { EditorView } from "../pm";
import { $prose } from "@milkdown/utils";
import { getTopbarBottom } from "../utils/headingUtils";
import { computeTypewriterInsets, isTypewriterMode } from "./typewriterScroll";

// Caret auto-scroll margins (vim-scrolloff style).
//
// The document scrolls at the window level while the topbar and the sticky
// heading title are position:fixed overlays, so ProseMirror's default
// scroll-into-view (threshold 0, margin 5px) parks the caret underneath
// them. This plugin supplies per-side scrollThreshold/scrollMargin editor
// props whose top side reserves the full header stack plus a comfort band,
// and whose bottom side keeps a few lines of context visible — the
// edge-offset model VS Code (cursorSurroundingLines) and vim (scrolloff)
// default to. Mouse clicks are unaffected: ProseMirror only applies these
// props to transaction-driven scrolls (typing, keyboard navigation).
//
// ProseMirror reads `value[side]` on every scroll-into-view pass, so the
// exported insets object uses getters to re-measure the DOM lazily at the
// exact moment a scroll happens — no observers or stale caches involved.

const CSS_VAR_TOP = "--caret-scroll-top-inset";
const CSS_VAR_BOTTOM = "--caret-scroll-bottom-inset";

/** One line of body text in pixels; the unit for comfort bands. */
export function bodyLineHeightPx(): number {
    const style = window.getComputedStyle(document.body);
    const lineHeight = parseFloat(style.lineHeight);
    if (Number.isFinite(lineHeight) && lineHeight > 0) {
        return lineHeight;
    }
    const fontSize = parseFloat(style.fontSize);
    // 1.6 mirrors the body line-height in style.css.
    return (Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 14) * 1.6;
}

let stickyTitleEl: HTMLElement | null = null;

/**
 * Height reserved for the sticky heading title. When it is currently shown
 * we measure it exactly. When hidden it may still appear right after the
 * scroll lands (the caret ends up inside some heading's section), so
 * reserve an estimated line: sticky typography tracks the active heading,
 * so this can undershoot for H1/H2 sections — the comfort band in
 * computeInsets() absorbs that difference.
 */
export function measureStickyHeadingHeight(): number {
    // The sticky title is a singleton headingSticky creates once per mount and
    // thereafter only toggles [hidden] on, so cache the element rather than
    // re-running a whole-document querySelector — this is read twice per
    // caret-scroll pass, which is every keystroke (MAR-137). A stale cache
    // (editor re-created) leaves the element detached; isConnected catches it.
    if (!stickyTitleEl?.isConnected) {
        stickyTitleEl = document.querySelector<HTMLElement>(".heading-sticky-title");
    }
    const sticky = stickyTitleEl;
    if (sticky && !sticky.hidden) {
        return sticky.getBoundingClientRect().height;
    }
    const fontSize = parseFloat(window.getComputedStyle(document.body).fontSize);
    const base = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 14;
    // Sticky title: text at line-height 1.3 + 0.5em vertical padding × 2.
    return base * (1.3 + 1);
}

/**
 * The `scrollElementBelowTopbar` margin that lands a navigation target below
 * the sticky heading title with about two lines of lead-in. The one
 * expression for every "jump into a section" scroll — the review sidebar's
 * range navigation and the post-drop landing scroll share it — so they all
 * settle the viewport identically, and none can clear only the topbar and
 * leave its target inside the band the active section's title paints over.
 */
export function stickyClearanceMargin(): number {
    return measureStickyHeadingHeight() + bodyLineHeightPx() * 2 + 8;
}

function viewportHeight(): number {
    // ProseMirror's window rect uses documentElement.clientHeight; mirror it.
    // jsdom reports 0 there, hence the innerHeight fallback.
    return document.documentElement.clientHeight || window.innerHeight;
}

export interface CaretScrollBand {
    top: number;
    bottom: number;
}

/**
 * The live view, for the one measurement the insets cannot take from the DOM
 * alone: how tall the caret's own rect is. A module singleton in the same way
 * `stickyTitleEl` above is one - there is a single editor per mount, and the
 * plugin's own view() owns both ends of its lifetime.
 */
let activeView: EditorView | null = null;

/**
 * Typewriter-mode insets for the caret as it stands now, or null when the mode
 * is off or does not apply to this selection.
 *
 * The caret's height is measured per scroll rather than assumed, because the
 * band has to be the height of THIS caret: a band sized for body text with the
 * caret in an H1 would put the taller rect outside it in both directions at
 * once, which is the jitter typewriterScroll's slack constant describes.
 *
 * A non-empty selection declines, and that is the mode's "don't fight the user"
 * rule rather than an implementation limit. Extending a selection with the
 * keyboard scrolls by its head; recentering the page on every extension would
 * make a multi-line selection unusable.
 *
 * UNMEASURED, and the thing to look at first if the mode ever feels heavy: with
 * it ON this runs `coordsAtPos`, which forces layout, once per prop read.
 * ProseMirror reads a side off `scrollThreshold` and again off `scrollMargin`,
 * and `syncScrollPaddingVars` reads once more per scroll frame, so one gesture
 * costs several. Nothing caches it, deliberately - a cache keyed on anything
 * short of the layout itself goes stale on a font or zoom change with no
 * transaction to invalidate it. With the mode OFF the cost is the boolean above
 * and nothing else, which is the case every perf gate here actually measures,
 * since they run at default settings. Measure with `pnpm perf:typing` against a
 * build whose default is flipped on, not against the shipped one.
 */
function typewriterInsets(): CaretScrollBand | null {
    if (!isTypewriterMode()) {
        return null;
    }
    const view = activeView;
    if (!view || !view.state.selection.empty) {
        return null;
    }
    let caretHeight: number;
    try {
        const coords = view.coordsAtPos(view.state.selection.head);
        caretHeight = coords.bottom - coords.top;
    } catch {
        // coordsAtPos throws for a position whose DOM is not laid out yet
        // (mid-reconfigure, a collapsed fold). The ordinary insets are the
        // right answer for one frame.
        return null;
    }
    if (!(caretHeight > 0)) {
        caretHeight = bodyLineHeightPx();
    }
    return computeTypewriterInsets({
        viewportHeight: viewportHeight(),
        caretHeight,
        topbarBottom: getTopbarBottom(),
    });
}

/**
 * Vertical insets for caret auto-scroll. Top: topbar + sticky title + one
 * line of air. Bottom: ~2.5 lines of context while typing.
 *
 * Clamped so both bands plus two caret lines always fit in the viewport:
 * ProseMirror corrects a top violation and a bottom violation with an
 * if/else, so overlapping bands in a short pane would make consecutive
 * keystrokes alternate between the two corrections and the viewport would
 * jump on every keypress. The bottom comfort band gives way first; the top
 * inset (real occlusion) is only sacrificed in pathologically short panes.
 */
export function computeInsets(): CaretScrollBand {
    const centered = typewriterInsets();
    if (centered) {
        return centered;
    }
    const line = bodyLineHeightPx();
    let top = getTopbarBottom() + measureStickyHeadingHeight() + line;
    let bottom = line * 2.5;
    const maxCombined = viewportHeight() - line * 2;
    if (top + bottom > maxCombined) {
        bottom = Math.max(5, maxCombined - top);
        if (top + bottom > maxCombined) {
            top = Math.max(0, maxCombined - bottom);
        }
    }
    return { top: Math.round(top), bottom: Math.round(bottom) };
}

// Shared by scrollThreshold and scrollMargin. Equal threshold and margin
// give the classic scrolloff feel: once the caret enters the band, each new
// line scrolls the document by one line, holding the caret at the band edge.
export const caretScrollInsets = {
    get top(): number {
        return computeInsets().top;
    },
    get bottom(): number {
        return computeInsets().bottom;
    },
    // ProseMirror's horizontal default.
    left: 5,
    right: 5,
};

/**
 * Mirrors the insets into CSS vars consumed by `scroll-padding-*` on the
 * root element (see style.css) so browser-native scroll paths that bypass
 * ProseMirror's scrollRectIntoView — initial focus, find-in-page — respect
 * the header stack too. Returns the applied top inset.
 */
export function syncScrollPaddingVars(): number {
    const { top, bottom } = computeInsets();
    const root = document.documentElement.style;
    const topValue = `${top}px`;
    const bottomValue = `${bottom}px`;
    // Runs on every scroll frame — leave the style attribute alone unless
    // the measured header stack actually changed.
    if (
        root.getPropertyValue(CSS_VAR_TOP) !== topValue ||
        root.getPropertyValue(CSS_VAR_BOTTOM) !== bottomValue
    ) {
        root.setProperty(CSS_VAR_TOP, topValue);
        root.setProperty(CSS_VAR_BOTTOM, bottomValue);
    }
    return top;
}

export function createCaretScrollMarginPlugin(): Plugin {
    return new Plugin({
        props: {
            scrollThreshold: caretScrollInsets,
            scrollMargin: caretScrollInsets,
        },
        view(editorView) {
            activeView = editorView;
            let rafId: number | null = null;
            const update = () => {
                rafId = null;
                syncScrollPaddingVars();
            };
            const schedule = () => {
                if (rafId === null) {
                    rafId = requestAnimationFrame(update);
                }
            };
            // The header stack height changes on window resize (topbar
            // wrapping) and on scroll (sticky title appearing/segueing
            // between headings of different levels).
            window.addEventListener("scroll", schedule, { passive: true });
            window.addEventListener("resize", schedule);
            syncScrollPaddingVars();
            return {
                destroy() {
                    if (activeView === editorView) {
                        activeView = null;
                    }
                    if (rafId !== null) {
                        cancelAnimationFrame(rafId);
                    }
                    window.removeEventListener("scroll", schedule);
                    window.removeEventListener("resize", schedule);
                },
            };
        },
    });
}

export const caretScrollMarginPlugin = $prose(createCaretScrollMarginPlugin);
