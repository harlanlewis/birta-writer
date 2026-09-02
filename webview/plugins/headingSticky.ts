import type { EditorState, EditorView } from "../pm";
import { Plugin, TextSelection } from "../pm";
import { $prose } from "@milkdown/utils";
import { IconChevronDown, IconChevronRight } from "../ui/icons";
import { applyTooltip, hideTooltip } from "../ui/tooltip";
import {
    foldHiddenRange,
    foldSubtreeAt,
    foldPluginKey,
    wireMarkerButtonProtocol,
    type FoldMeta,
} from "./headingFold";
import { t } from "../i18n";
import {
    getTopbarBottom,
    scrollElementBelowTopbar,
    getHeadingLevel,
    getVisibleHeadings,
    getHeadingText,
    findHeadingPos,
    SAFE_AREA_CHANGE_EVENT,
} from "../utils/headingUtils";

const HEADING_STICKY_ACTIVE_CHANGE_EVENT = "heading-sticky-active-change";

/**
 * Whether the sticky bar offers a fold chevron for the heading at
 * `headingPos` — asked of `foldHiddenRange`, the same source of truth every
 * other fold consumer uses (the caret guard, the drop gates, the toggle
 * itself), so the bar shows the control only where the fold plugin would
 * honor a toggle. `findHeadingFoldRange` is NOT the right question here: it
 * scans top-level offsets, so for a heading nested inside a blockquote or
 * callout it reports a range up to the next top-level heading — a section
 * the fold plugin refuses to fold, which put a chevron on the bar that read
 * "Collapse content" and never did anything. Exported for unit testing.
 */
export function stickyHeadingFoldable(state: EditorState, headingPos: number): boolean {
    const foldState = foldPluginKey.getState(state);
    return (foldState?.enabled ?? false) && foldHiddenRange(state.doc, headingPos) !== null;
}

function scrollHeadingIntoStickyPosition(view: EditorView, headingPos: number): void {
    requestAnimationFrame(() => {
        const heading = view.nodeDOM(headingPos);
        if (!(heading instanceof HTMLElement)) {
            return;
        }
        scrollElementBelowTopbar(heading, 8, "auto");
    });
}

/**
 * Put the caret on the heading's first text line at the given viewport x.
 * Coordinate resolution needs real layout; when it is unavailable (jsdom) or
 * misses, the caret falls back to the heading's start.
 */
export function placeCaretOnHeadingFirstLine(
    view: EditorView,
    headingPos: number,
    clientX: number,
): void {
    const heading = view.nodeDOM(headingPos);
    const node = view.state.doc.nodeAt(headingPos);
    if (!(heading instanceof HTMLElement) || !node) {
        return;
    }
    let pos = headingPos + 1;
    try {
        const rect = heading.getBoundingClientRect();
        const style = window.getComputedStyle(heading);
        const fontSize = parseFloat(style.fontSize) || 16;
        const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.3;
        const paddingTop = parseFloat(style.paddingTop) || 0;
        const x = Math.min(Math.max(clientX, rect.left + 1), rect.right - 1);
        const y = rect.top + paddingTop + lineHeight / 2;
        const hit = view.posAtCoords({ left: x, top: y });
        if (hit) {
            pos = Math.min(Math.max(hit.pos, headingPos + 1), headingPos + 1 + node.content.size);
        }
    } catch {
        // No layout engine — keep the heading-start fallback.
    }
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
    view.focus();
}

function dispatchStickyActiveChange(headingPos: number | null): void {
    window.dispatchEvent(
        new CustomEvent(HEADING_STICKY_ACTIVE_CHANGE_EVENT, {
            detail: { headingPos },
        }),
    );
}

/** One crumb of the ancestor trail: a heading above the stuck one, one
 * level up at a time. */
export interface StickyAncestor {
    heading: HTMLElement;
    text: string;
}

/**
 * The stuck heading's ancestors, root first: walking back through the
 * visible headings, each heading whose level is smaller than every level
 * seen so far is the parent of the section the reader is in. A heading of
 * the same or a deeper level is a sibling or a cousin and is skipped, and
 * so is a heading nested inside a container (a quote, a callout, a list
 * item): a `## Note` inside a callout is not the section a top-level `###`
 * below it belongs to, which is the same rule `stickyHeadingFoldable`
 * applies to folding. `isTopLevel` is injected because the answer is a
 * property of the view (`heading.parentElement === view.dom`); the tests
 * pass their own. Pure otherwise. Exported for tests.
 */
export function stickyAncestors(
    headings: readonly HTMLElement[],
    activeIndex: number,
    isTopLevel: (heading: HTMLElement) => boolean = () => true,
): StickyAncestor[] {
    const trail: StickyAncestor[] = [];
    let level = activeIndex >= 0 && activeIndex < headings.length
        ? getHeadingLevel(headings[activeIndex]!)
        : 0;
    for (let i = activeIndex - 1; i >= 0 && level > 1; i--) {
        const heading = headings[i]!;
        if (!isTopLevel(heading)) {
            continue;
        }
        const candidate = getHeadingLevel(heading);
        if (candidate < level) {
            level = candidate;
            trail.push({ heading, text: getHeadingText(heading) });
        }
    }
    return trail.reverse();
}

/** The trail's identity, for the "rebuild only when something changed"
 * comparison in updateSticky: the same headings in the same order with the
 * same text is the same trail. */
function trailKey(trail: readonly StickyAncestor[]): string {
    return trail.map((crumb) => `${getHeadingLevel(crumb.heading)}:${crumb.text}`).join("\u0000");
}

/** Exported for tests: the sticky's DOM contract (trail, gutter, handle, label). */
export function setStickyContent(
    sticky: HTMLElement,
    view: EditorView,
    heading: HTMLElement,
    headingPos: number,
    collapsed: boolean,
    foldable: boolean,
    ancestors: readonly StickyAncestor[] = [],
): void {
    const level = getHeadingLevel(heading);
    const text = getHeadingText(heading);
    sticky.className = "heading-sticky-title";
    sticky.innerHTML = "";

    // The ancestor trail (MAR-31): the sections the stuck heading sits in,
    // root first, above the title in chrome type. Each crumb is a real
    // button that scrolls its heading under the topbar and drops the caret
    // at its start; the current heading is the title row below, which
    // already is one. Hidden while the outline is open, docked or overlaid
    // (style.css: it shows the same ancestry, highlighted), and absent for a
    // top-level heading, so the bar is one row exactly as before then.
    if (ancestors.length > 0) {
        const trail = document.createElement("nav");
        trail.className = "heading-sticky-trail";
        trail.setAttribute("aria-label", t("Section path"));
        ancestors.forEach((crumb, index) => {
            if (index > 0) {
                const separator = document.createElement("span");
                separator.className = "heading-sticky-crumb-sep";
                separator.setAttribute("aria-hidden", "true");
                separator.textContent = "\u203a";
                trail.appendChild(separator);
            }
            const button = document.createElement("button");
            button.type = "button";
            button.className = "heading-sticky-crumb";
            button.textContent = crumb.text;
            // The clipped tail comes back on hover, the label's own rule.
            applyTooltip(button, crumb.text, { placement: "above", truncatedOnly: true });
            button.addEventListener("mousedown", (event) => {
                event.preventDefault();
            });
            button.addEventListener("click", (event) => {
                event.preventDefault();
                // Resolve at click time: the crumb's heading is a live DOM
                // node the view still renders, so its position is current.
                const pos = findHeadingPos(view, crumb.heading);
                if (pos === null) {
                    return;
                }
                hideTooltip();
                scrollElementBelowTopbar(crumb.heading, 8, "auto");
                view.dispatch(view.state.tr.setSelection(
                    TextSelection.near(view.state.doc.resolve(Math.min(pos + 1, view.state.doc.content.size))),
                ));
                view.focus();
            });
            trail.appendChild(button);
        });
        sticky.appendChild(trail);
    }

    // The title row: the gutter (chevron, badge) hangs off it, so the row is
    // the gutter's containing block and stays aligned with the title when a
    // trail sits above.
    const row = document.createElement("div");
    row.className = "heading-sticky-row";

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
            // data-heading-pos on every doc change, while this handler's
            // captured `headingPos` goes stale whenever content above the
            // heading shifts without changing its text/collapsed state
            // (external sync, find-replace) — the gutter's own rule
            // (gutterBlockPos) applied to the sticky clone. A doc change is
            // exactly what shifts that content, so the refresh still covers it.
            const livePos = Number(sticky.dataset["headingPos"] ?? headingPos);

            // Alt+click folds the region and everything nested inside it, the
            // same pointer modifier the in-flow chevron carries (MAR-116). This
            // copy is the same control by construction: same icon, same label,
            // same tooltip, and the two were deliberately brought into parity.
            // A modifier that worked on one and silently did nothing on the
            // other would read as the feature being broken.
            if (event.altKey) {
                if (foldSubtreeAt(view.state, view.dispatch.bind(view), livePos, !collapsed)) {
                    view.focus();
                    hideTooltip();
                    scrollHeadingIntoStickyPosition(view, livePos);
                }
                return;
            }

            const tr = view.state.tr
                .setMeta(foldPluginKey, { type: "toggle", pos: livePos } satisfies FoldMeta)
                .setMeta("addToHistory", false);

            if (!collapsed) {
                const range = foldHiddenRange(view.state.doc, livePos);
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
    // every doc change, which is what shifting that content is.
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

    // Clicking the sticky's text is a navigation gesture: scroll the real
    // heading fully into view (below the topbar) and drop the caret at the
    // character under the click. The x coordinate maps 1:1 onto the heading's
    // first line — the sticky shares its left/width and typography
    // (syncStickyTypography) — so after the instant scroll the clicked point
    // resolves against the live document.
    label.addEventListener("mousedown", (event) => {
        // No native focus/selection on the body-mounted clone; click owns it.
        event.preventDefault();
    });
    label.addEventListener("click", (event) => {
        const livePos = Number(sticky.dataset["headingPos"] ?? headingPos);
        const target = view.nodeDOM(livePos);
        if (!(target instanceof HTMLElement)) {
            return;
        }
        const clickX = event.clientX;
        hideTooltip();
        scrollElementBelowTopbar(target, 8, "auto");
        requestAnimationFrame(() => {
            placeCaretOnHeadingFirstLine(view, livePos, clickX);
        });
    });

    row.append(gutter, label);
    sticky.appendChild(row);
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

            /**
             * Publish how much the bar actually covers, so CSS can reserve it.
             *
             * The bar is fixed and opaque and paints OVER the content column,
             * so any chrome that can pin itself inside that column has to
             * clear it as well as the topbar — a code block's language pill
             * (codeBlock.css) and the block control strip's pinned stack
             * (blockControls.css: nesting in a quote/callout insets the strip
             * into the column) both reserve it. What is published is the PAINTED
             * extent below the topbar, not the box height: the bar slides up
             * under the next heading, and a reservation that ignored that would
             * push chrome down to clear a band nothing is drawn in.
             *
             * Guarded so scroll frames that change nothing write nothing, and
             * a change is announced on `window`: chrome that MEASURES the safe
             * area in its own rAF (the table overlay) may have already run
             * this frame, and a single-event scroll (a TOC click, a find
             * jump) would otherwise leave its placement stale under the bar.
             * CSS consumers of the variable restyle on their own.
             *
             * Starts at 0, never a sentinel: every consumer's fallback for the
             * unset variable is 0px, so "nothing published yet" and "published
             * 0" are the same state, and publishing 0 over it must stay a
             * no-op. The first update runs on the mount rAF, before first
             * paint, and the bar starts hidden — a sentinel would turn that
             * hide into a root-level custom-property write, and a custom
             * property on <html> inherits everywhere, so the write restyles
             * the whole document on the frame the first paint is waiting on.
             */
            let publishedHeight = 0;
            const publishHeight = (px: number): void => {
                const height = Math.max(0, px);
                if (height === publishedHeight) {
                    return;
                }
                publishedHeight = height;
                document.documentElement.style.setProperty(
                    "--editor-sticky-heading-height",
                    `${height}px`,
                );
                window.dispatchEvent(new Event(SAFE_AREA_CHANGE_EVENT));
            };

            const hideSticky = () => {
                activeHeading = null;
                if (activeHeadingPos !== null) {
                    activeHeadingPos = null;
                    dispatchStickyActiveChange(null);
                }
                sticky.hidden = true;
                publishHeight(0);
                delete sticky.dataset["headingPos"];
            };

            let tocPanel: HTMLElement | null = null;
            /**
             * The column an OPEN outline panel occupies, or null when none is
             * out. Read from `offsetLeft`/`offsetWidth`, which are layout and
             * so ignore the open/close slide's transform: the column is the one
             * the panel settles at, from the first frame of the slide to the
             * last, rather than a value that has to be chased frame by frame.
             * Whether a panel is out is the one thing geometry cannot answer,
             * since a closed panel keeps its box and is merely translated away,
             * so it comes from the outline's published body classes.
             */
            const tocColumn = (): { left: number; right: number } | null => {
                const cls = document.body.classList;
                if (!cls.contains("toc-open") && !cls.contains("toc-overlay-open")
                    && !cls.contains("toc-flyout-open")) {
                    return null;
                }
                if (!tocPanel?.isConnected) {
                    tocPanel = document.querySelector<HTMLElement>(".toc-panel");
                }
                if (!tocPanel) {
                    return null;
                }
                return { left: tocPanel.offsetLeft, right: tocPanel.offsetLeft + tocPanel.offsetWidth };
            };

            /**
             * How far to clip each end of the bar so it never paints into that
             * column. The panel is opaque and covers the document underneath it
             * in overlay mode, so the bar, which mirrors a heading down there,
             * has to be covered the same way. It cannot simply be layered under
             * the panel: the panel sits BELOW the document popups (slash menu,
             * footnote and proofreading cards) so they can open over it, and
             * the bar sits ABOVE the drag veil, and no single order satisfies
             * both. Clipping leaves the bar's left and typography untouched,
             * which is what keeps a click on it mapping 1:1 onto the heading's
             * own first line.
             */
            const stickyClip = (rect: DOMRect): string => {
                const col = tocColumn();
                if (!col) {
                    return "";
                }
                const panelLeads = col.left + col.right < rect.left + rect.right;
                const left = panelLeads ? Math.max(0, col.right - rect.left) : 0;
                const right = panelLeads ? 0 : Math.max(0, rect.right - col.left);
                if (!left && !right) {
                    return "";
                }
                // The un-clipped end keeps the bar's own paint outsets, or the
                // clip would cut off the gutter backdrop it reaches out to.
                const leftInset = left ? `${left}px` : "var(--sticky-paint-left)";
                return `inset(var(--sticky-paint-block) ${right}px var(--sticky-paint-block) ${leftInset})`;
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
                // Asked of the DOCUMENT, not of the heading's rendered class:
                // the sticky title's heading is above the viewport by
                // definition, and since MAR-215 the gutter chrome is only
                // materialized near the viewport — the class would simply be
                // missing and the sticky badge would lose its chevron.
                const foldState = foldPluginKey.getState(view.state);
                const foldable = stickyHeadingFoldable(view.state, headingPos);
                const collapsed = foldState?.folded.has(headingPos) ?? false;
                const rect = heading.getBoundingClientRect();
                // Measured with the reads above and applied with the writes
                // below: it asks the panel for its box, so taken after the
                // writes it would force a second layout on every frame of a
                // scroll.
                const clip = stickyClip(rect);
                sticky.hidden = false;
                sticky.dataset["headingPos"] = String(headingPos);
                sticky.style.top = `${top}px`;
                sticky.style.left = `${rect.left}px`;
                sticky.style.width = `${rect.width}px`;
                sticky.style.clipPath = clip;

                const ancestors = stickyAncestors(headings, activeIndex, (h) => h.parentElement === view.dom);
                const trail = trailKey(ancestors);
                if (
                    heading !== activeHeading ||
                    sticky.dataset["headingText"] !== text ||
                    sticky.dataset["collapsed"] !== String(collapsed) ||
                    sticky.dataset["trail"] !== trail
                ) {
                    activeHeading = heading;
                    sticky.dataset["headingText"] = text;
                    sticky.dataset["collapsed"] = String(collapsed);
                    sticky.dataset["trail"] = trail;
                    syncStickyTypography(sticky, heading);
                    setStickyContent(sticky, view, heading, headingPos, collapsed, foldable, ancestors);
                }

                const nextHeading = headings[activeIndex + 1] ?? null;
                const stickyHeight = sticky.getBoundingClientRect().height;
                const nextTop = nextHeading?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
                const offset = Math.min(0, nextTop - top - stickyHeight);
                sticky.style.transform = `translateY(${offset}px)`;
                // Publish ONCE, after the slide offset is known: the published
                // value is the painted extent, and each publish that changes
                // it is a root-level write that restyles the whole document,
                // so an intermediate pre-offset publish would double that cost
                // on every frame of the slide-under transition.
                publishHeight(stickyHeight + offset);
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

            // Fire only when the topbar's extent actually MOVES, not on every
            // body-class mutation — the same shape nativeThemeBridge uses, and
            // for the same reason. Body classes churn on ordinary editing: the
            // fold plugin writes `handles-quiet` on EVERY keydown, and
            // `classList.add` re-writes the class attribute even when the class
            // is already present, so an unfiltered observer here rescans every
            // heading in the document on every keystroke — a querySelectorAll
            // plus a forced layout per heading, twice per mutation because
            // scheduleLayoutUpdate queues two frames (MAR-266).
            //
            // So measure what the sticky is POSITIONED from rather than
            // enumerating class names — two rects instead of one per heading in
            // the document, and a class that starts moving the editor tomorrow
            // is handled without editing a list here.
            // The sticky takes its top from the topbar and its
            // left/width from the active heading, which tracks the editor
            // column; `toc-docked`/`toc-open`/`editor-width-auto` all shift that
            // column through CSS variables. The ResizeObserver below is NOT
            // enough on its own for those: docking moves the column with a
            // margin, and a pure horizontal shift resizes nothing.
            // The outline's column joins the key for the same reason: opening it
            // in overlay mode moves nothing and resizes nothing, so the clip
            // above would otherwise stay behind until the next scroll.
            const placement = (): string => {
                const box = view.dom.getBoundingClientRect();
                const col = tocColumn();
                return `${getTopbarBottom()}|${box.left}|${box.width}|${col?.left}|${col?.right}`;
            };
            let lastPlacement = placement();
            const bodyClassObserver = new MutationObserver(() => {
                const next = placement();
                if (next === lastPlacement) {
                    return;
                }
                lastPlacement = next;
                scheduleLayoutUpdate();
            });
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
                // A selection-only transaction cannot change which heading sits
                // above the viewport, and this scan is O(headings in the
                // document) with a forced layout on each — so running it on
                // every transaction puts that whole cost on every caret move
                // (MAR-266).
                //
                // What DOES change the answer: a doc edit (content above the
                // threshold shifts, or the active heading's own text changes)
                // and a fold toggle (collapsing a section changes the VISIBLE
                // heading set without touching the doc). Scrolling and resizing
                // arrive through their own listeners below. The fold set is
                // compared by identity, the same way headingFold's own plugin
                // does it.
                update(updatedView, prevState) {
                    const fold = foldPluginKey.getState(updatedView.state);
                    const prevFold = foldPluginKey.getState(prevState);
                    if (
                        updatedView.state.doc !== prevState.doc ||
                        fold?.folded !== prevFold?.folded ||
                        fold?.enabled !== prevFold?.enabled
                    ) {
                        scheduleUpdate();
                    }
                },
                destroy() {
                    if (rafId !== null) {
                        cancelAnimationFrame(rafId);
                    }
                    window.removeEventListener("scroll", scheduleUpdate);
                    window.removeEventListener("resize", scheduleUpdate);
                    bodyClassObserver.disconnect();
                    resizeObserver.disconnect();
                    sticky.remove();
                    // The bar is gone, so nothing may still be reserving room
                    // for it (the variable outlives this view on <html>).
                    publishHeight(0);
                },
            };
        },
    }),
);
