import { Plugin } from "../pm";
import { $prose } from "@milkdown/utils";
import { getTopbarBottom } from "../utils/headingUtils";

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

/**
 * Height reserved for the sticky heading title. When it is currently shown
 * we measure it exactly. When hidden it may still appear right after the
 * scroll lands (the caret ends up inside some heading's section), so
 * reserve an estimated line: sticky typography tracks the active heading,
 * so this can undershoot for H1/H2 sections — the comfort band in
 * computeInsets() absorbs that difference.
 */
export function measureStickyHeadingHeight(): number {
    const sticky = document.querySelector<HTMLElement>(".heading-sticky-title:not([hidden])");
    if (sticky) {
        return sticky.getBoundingClientRect().height;
    }
    const fontSize = parseFloat(window.getComputedStyle(document.body).fontSize);
    const base = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 14;
    // Sticky title: text at line-height 1.3 + 0.5em vertical padding × 2.
    return base * (1.3 + 1);
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
        view() {
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
