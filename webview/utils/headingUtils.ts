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

/** Get the bottom position of the top toolbar */
export function getTopbarBottom(): number {
    return document.querySelector(".editor-topbar")?.getBoundingClientRect().bottom ?? 40;
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
