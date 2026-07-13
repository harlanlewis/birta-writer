import type { EditorView } from "@milkdown/prose/view";
import { Plugin, TextSelection } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";
import { IconChevronDown, IconChevronRight } from "../ui/icons";
import { applyTooltip, hideTooltip } from "../ui/tooltip";
import {
    findHeadingFoldRange,
    headingFoldPluginKey,
    wireMarkerButtonProtocol,
    type HeadingFoldMeta,
} from "./headingFold";
import { t } from "../i18n";
import {
    getTopbarBottom,
    scrollElementBelowTopbar,
    getHeadingLevel,
    getVisibleHeadings,
    getHeadingText,
    findHeadingPos,
} from "../utils/headingUtils";

const HEADING_STICKY_ACTIVE_CHANGE_EVENT = "heading-sticky-active-change";

function scrollHeadingIntoStickyPosition(view: EditorView, headingPos: number): void {
    requestAnimationFrame(() => {
        const heading = view.nodeDOM(headingPos);
        if (!(heading instanceof HTMLElement)) {
            return;
        }
        scrollElementBelowTopbar(heading, 8, "auto");
    });
}

function dispatchStickyActiveChange(headingPos: number | null): void {
    window.dispatchEvent(
        new CustomEvent(HEADING_STICKY_ACTIVE_CHANGE_EVENT, {
            detail: { headingPos },
        }),
    );
}

/** Exported for tests: the sticky's DOM contract (gutter, handle, label). */
export function setStickyContent(
    sticky: HTMLElement,
    view: EditorView,
    heading: HTMLElement,
    headingPos: number,
    collapsed: boolean,
    foldable: boolean,
): void {
    const level = getHeadingLevel(heading);
    const text = getHeadingText(heading);
    sticky.className = "heading-sticky-title";
    sticky.innerHTML = "";

    const gutter = document.createElement("span");
    gutter.className = "heading-sticky-gutter";

    if (foldable) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "heading-sticky-toggle";
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

            // Derive the position at CLICK time: updateSticky refreshes
            // data-heading-pos on every state update, while this handler's
            // captured `headingPos` goes stale whenever content above the
            // heading shifts without changing its text/collapsed state
            // (external sync, find-replace) — the gutter's own rule
            // (gutterBlockPos) applied to the sticky clone.
            const livePos = Number(sticky.dataset["headingPos"] ?? headingPos);

            const tr = view.state.tr
                .setMeta(headingFoldPluginKey, { type: "toggle", pos: livePos } satisfies HeadingFoldMeta)
                .setMeta("addToHistory", false);

            if (!collapsed) {
                const range = findHeadingFoldRange(view.state.doc, livePos);
                if (
                    range &&
                    view.state.selection.from < range.to &&
                    view.state.selection.to > range.from
                ) {
                    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(livePos + 1, tr.doc.content.size))));
                }
            }

            view.dispatch(tr);
            view.focus();
            hideTooltip();
            scrollHeadingIntoStickyPosition(view, livePos);
        });
        gutter.appendChild(button);
    }

    // A real block handle, not a display-only badge: the shared marker-button
    // protocol (wireMarkerButtonProtocol — the same wiring as the in-flow
    // gutter handles) opens the same block menu for the real heading.
    // `draggable: false` encodes the sticky's fixed-mirror property: it is
    // deliberately not a grabbable block. The position callback applies the
    // same live-pos rule as the fold toggle above: the captured pos goes
    // stale when content above shifts; data-heading-pos is refreshed on
    // every state update.
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "heading-sticky-marker";
    const clampedLevel = Math.min(Math.max(level, 1), 6);
    // The heading's level badge, matching the in-document gutter (headingFold).
    marker.textContent = `H${clampedLevel}`;
    wireMarkerButtonProtocol(
        marker,
        view,
        `H${clampedLevel}`,
        () => Number(sticky.dataset["headingPos"] ?? headingPos),
        { draggable: false },
    );
    gutter.appendChild(marker);

    const label = document.createElement("span");
    label.className = "heading-sticky-text";
    label.textContent = text;
    // The title is clipped to a single line (see .heading-sticky-text), so a
    // heading wider than the sticky loses its tail to an ellipsis. Recover it
    // on hover exactly as the TOC does — the tooltip appears only when the text
    // is actually truncated, and measures on mouseenter, off the scroll path.
    applyTooltip(label, text, { placement: "above", truncatedOnly: true });

    sticky.append(gutter, label);
}

function syncStickyTypography(sticky: HTMLElement, heading: HTMLElement): void {
    const style = window.getComputedStyle(heading);
    sticky.style.fontSize = style.fontSize;
    sticky.style.lineHeight = style.lineHeight;
    sticky.style.fontWeight = style.fontWeight;
}

export const headingStickyPlugin = $prose(() =>
    new Plugin({
        view(view) {
            const sticky = document.createElement("div");
            sticky.className = "heading-sticky-title";
            sticky.hidden = true;
            document.body.appendChild(sticky);

            let rafId: number | null = null;
            let activeHeading: HTMLElement | null = null;
            let activeHeadingPos: number | null = null;

            const hideSticky = () => {
                activeHeading = null;
                if (activeHeadingPos !== null) {
                    activeHeadingPos = null;
                    dispatchStickyActiveChange(null);
                }
                sticky.hidden = true;
                delete sticky.dataset["headingPos"];
            };

            const updateSticky = () => {
                rafId = null;

                const top = getTopbarBottom();
                const headings = getVisibleHeadings(view);

                // Compute the offset dynamically: the difference between the heading's padding-top (1em) and the sticky padding (0.5em)
                let paddingOffset = 0;
                if (headings.length > 0) {
                    const headingStyle = window.getComputedStyle(headings[0]);
                    const headingPaddingTop = parseFloat(headingStyle.paddingTop) || 0;
                    // The sticky padding is 0.5em, so use half the heading padding as an approximation
                    paddingOffset = headingPaddingTop / 2 - 1;
                }
                const threshold = top - paddingOffset;

                let activeIndex = -1;

                for (let i = 0; i < headings.length; i++) {
                    if (headings[i].getBoundingClientRect().top <= threshold) {
                        activeIndex = i;
                    } else {
                        break;
                    }
                }

                if (activeIndex < 0) {
                    hideSticky();
                    return;
                }

                const heading = headings[activeIndex];
                const text = getHeadingText(heading);
                if (!text) {
                    hideSticky();
                    return;
                }

                const headingPos = findHeadingPos(view, heading);
                if (headingPos === null) {
                    hideSticky();
                    return;
                }

                if (activeHeadingPos !== headingPos) {
                    activeHeadingPos = headingPos;
                    dispatchStickyActiveChange(headingPos);
                }
                const foldable = heading.classList.contains("heading-fold-heading--foldable");
                const collapsed = headingFoldPluginKey.getState(view.state)?.folded.has(headingPos) ?? false;
                const rect = heading.getBoundingClientRect();
                sticky.hidden = false;
                sticky.dataset["headingPos"] = String(headingPos);
                sticky.style.top = `${top}px`;
                sticky.style.left = `${rect.left}px`;
                sticky.style.width = `${rect.width}px`;

                if (
                    heading !== activeHeading ||
                    sticky.dataset["headingText"] !== text ||
                    sticky.dataset["collapsed"] !== String(collapsed)
                ) {
                    activeHeading = heading;
                    sticky.dataset["headingText"] = text;
                    sticky.dataset["collapsed"] = String(collapsed);
                    syncStickyTypography(sticky, heading);
                    setStickyContent(sticky, view, heading, headingPos, collapsed, foldable);
                }

                const nextHeading = headings[activeIndex + 1] ?? null;
                const stickyHeight = sticky.getBoundingClientRect().height;
                const nextTop = nextHeading?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
                const offset = Math.min(0, nextTop - top - stickyHeight);
                sticky.style.transform = `translateY(${offset}px)`;
            };

            const scheduleUpdate = () => {
                if (rafId !== null) {
                    return;
                }
                rafId = requestAnimationFrame(updateSticky);
            };

            const scheduleLayoutUpdate = () => {
                scheduleUpdate();
                requestAnimationFrame(scheduleUpdate);
            };

            const bodyClassObserver = new MutationObserver(scheduleLayoutUpdate);
            bodyClassObserver.observe(document.body, {
                attributes: true,
                attributeFilter: ["class"],
            });

            const resizeObserver = new ResizeObserver(scheduleUpdate);
            resizeObserver.observe(view.dom);
            const editorRoot = document.getElementById("editor");
            if (editorRoot) {
                resizeObserver.observe(editorRoot);
            }

            window.addEventListener("scroll", scheduleUpdate, { passive: true });
            window.addEventListener("resize", scheduleUpdate);
            scheduleUpdate();

            return {
                update: scheduleUpdate,
                destroy() {
                    if (rafId !== null) {
                        cancelAnimationFrame(rafId);
                    }
                    window.removeEventListener("scroll", scheduleUpdate);
                    window.removeEventListener("resize", scheduleUpdate);
                    bodyClassObserver.disconnect();
                    resizeObserver.disconnect();
                    sticky.remove();
                },
            };
        },
    }),
);
