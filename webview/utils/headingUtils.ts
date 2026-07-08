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

import type { EditorView } from "@milkdown/prose/view";

const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";

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

/** Get all visible heading elements (excluding those hidden by folding) */
export function getVisibleHeadings(view: EditorView): HTMLElement[] {
    return Array.from(view.dom.querySelectorAll<HTMLElement>(HEADING_SELECTOR)).filter((heading) => {
        const rect = heading.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !heading.classList.contains("heading-fold-hidden");
    });
}

/** Get all heading elements (including those hidden by folding) */
export function getAllHeadings(view: EditorView): HTMLElement[] {
    return Array.from(view.dom.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
}

/** Find the document position corresponding to a heading element */
export function findHeadingPos(view: EditorView, heading: HTMLElement): number | null {
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
    let activeHeading: HTMLElement | null = null;
    let activePos: number | null = null;

    for (const heading of headings) {
        const rect = heading.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            continue;
        }
        if (rect.top <= threshold) {
            const pos = findHeadingPos(view, heading);
            if (pos !== null) {
                activeHeading = heading;
                activePos = pos;
            }
        } else {
            break;
        }
    }

    if (activeHeading && activePos !== null) {
        return { element: activeHeading, pos: activePos };
    }
    return null;
}
