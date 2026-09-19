/**
 * The formatting row: every control that edits the document, on its own row
 * directly under the top bar, under the `formattingInSecondRow` arrangement
 * (shared/hostProfile.ts).
 *
 * This module, its element and its CSS all say "dock", and the prose around it
 * says "row". They are the same thing. The vocabulary is from when this was a
 * strip at the window's bottom edge, and it survives in the names that are
 * expensive to change (a persisted state key) and in the ones that follow them
 * for consistency.
 *
 * It is a second HOLDER for the toolbar's items, not a second toolbar. The
 * same `.tb-item` wrappers `index.ts` built once are re-parented into it, so
 * every listener, tooltip and active-state binding survives the move, exactly
 * as they survive a zone change on the top bar. Nothing here knows what any
 * item is.
 *
 * The row is a CHILD of `.editor-topbar` rather than a strip of its own, and
 * that placement is the whole design rather than a detail of it. Every
 * consumer of the bar's height already measures the element
 * (`--editor-topbar-height`, written from a ResizeObserver in index.ts, and
 * `getTopbarBottom()` behind `safeAreaTop()`), so the content padding, the
 * find bar's offset, heading scroll margins and every popup's placement follow
 * a second row for free. A sibling fixed to the viewport would have needed all
 * five taught about it separately, and the one that got missed would be a
 * popup painting over the row.
 *
 * Inside the bar, and still the top of the CONTENT AREA rather than of the
 * window. The bar's first row is the window's (on the Mac it is the titlebar
 * band, and the tab bar a host draws lands under that row, not under this
 * one); this row is where the document's area starts. So a docked side panel
 * starts level with it and the row starts where the panel ends (dock.css);
 * `getContentAreaTop()` (utils/headingUtils.ts) reads this element's top
 * edge and hands every panel that edge.
 *
 * Whether the row is open is the HOST'S fact: it is a setting, read from the
 * bootstrap (`window.__i18n.formattingRowExpanded`) and pushed to every page
 * (`setFormattingRowExpanded`, landing in `setExpanded` below). This module
 * posts nothing and applies nothing of its own.
 *
 * Two places ask for it, and neither of them flips it. The host's Settings
 * window is one; the gear menu's switch (settingsMenu.ts) is the other, and it
 * posts a REQUEST that the host stores and fans back out, so every window
 * learns the new answer the same way and no page can be showing a row the
 * setting says is shut.
 *
 * It is a setting rather than a button on the bar because of how often it is
 * asked. Somebody decides once whether they want a formatting row and then
 * writes; a control on the bar of every window spends permanent space on a
 * question answered at most a handful of times, which is the density this row
 * was already the worst offender for. A row in a menu is not that space, which
 * is why the gear may hold the switch and the bar may not. The rows it opens
 * are all reachable without it, from the menu bar, the slash menu and the
 * palette, so what the setting governs is whether they are also resident.
 *
 * Two states, and no chrome at all announces them:
 *
 *     off   no second row
 *     on    P⌄ B I | ⋯ below the bar, quiet until reached for
 *
 * ## Grouped, and quiet at rest
 *
 * The row is SEPARATED by kind (`ITEM_GROUP` in registry.ts, run out by
 * `groupRuns`) rather than evenly spaced. Evenly spaced, the eye has to read
 * every glyph because nothing says where it may skip; the rules cost no
 * control and turn one run of sixteen into five short ones.
 *
 * And it is drawn at reduced ink until somebody reaches for it
 * (`ui/proximityReveal.ts` plus the `:hover`/`:focus-within` rules in
 * dock.css). A row of controls that is not being used is not information, and
 * the document is what the window is for.
 *
 * The row scrolls horizontally rather than collapsing into an overflow menu:
 * the set is fixed and opinionated, so there is no tail to demote, and a
 * narrow window should let you reach the last control rather than reorganise
 * the row under you. `overflow-x: auto` computes `overflow-y` to `auto` as
 * well, so the row would clip the four dropdowns that open out of it;
 * `MENU_CLIP_ATTR` is the declaration that sends them to viewport coordinates
 * instead, and `placeMenu` is the one reader.
 *
 * Two chevrons overlay the row's edges when it has somewhere to scroll, and
 * each is shown only while there is room to move that way, so a row that fits
 * carries no chrome at all. They exist because the scroll is otherwise
 * discoverable only by trying it: a trackpad user swipes and finds out, and a
 * mouse user sees a row that appears to end at the window's edge. The
 * scrollbar that would have said so is hidden, deliberately, since a
 * permanent one across a row of chrome is louder than the controls in it.
 *
 * Each is a BUTTON the size of the items it sits over, centred on the row and
 * inset from the window frame, carrying a tooltip that says what pressing it
 * does; behind it sits a wider gradient of the bar's own ground, so the item
 * passing underneath goes out on a fade rather than being cut in half. The
 * two are separate elements, and dock.css holds the reason.
 */
import { IconChevronLeft, IconChevronRight } from "@/ui/icons";
import { t } from "@/i18n";
import { MENU_CLIP_ATTR } from "@/ui/anchoredPlacement";
import { bindActivate, createSeparator } from "@/ui/dom";
import { applyTooltip } from "@/ui/tooltip";
import { createProximityReveal } from "@/ui/proximityReveal";
import { groupRuns } from "./registry";
import type { ToolbarItemId } from "./registry";
import "./dock.css";

export interface FormattingDock {
    /** The row element. The caller places it; this module never appends it. */
    el: HTMLElement;
    /** Re-parent `ids`' wrappers into the row, in the order given. */
    render: (ids: readonly ToolbarItemId[]) => void;
    /** Whether the row is showing. */
    isExpanded: () => boolean;
    /** Show or hide the row, as the host's setting says. */
    setExpanded: (expanded: boolean) => void;
    /** Tear down the listeners and remove the element (tests). */
    dispose: () => void;
}

export interface FormattingDockDeps {
    /** Every built item wrapper, keyed by id. Read on render; never rebuilt. */
    items: Partial<Record<ToolbarItemId, HTMLElement>>;
}

/**
 * Whether the host's setting asks for the row. Defaults to OFF, which is both
 * the quiet answer a first run should give and the answer the setting itself
 * defaults to, so the two cannot disagree on a page that boots before the
 * host has said anything.
 */
function readExpanded(): boolean {
    return window.__i18n?.formattingRowExpanded === true;
}

export function createFormattingDock({ items }: FormattingDockDeps): FormattingDock {
    const el = document.createElement("div");
    el.className = "tb-dock";

    const row = document.createElement("div");
    row.className = "tb-dock-row tb-zone";
    // The declaration that sends this row's dropdowns to viewport coordinates
    // (webview/ui/anchoredPlacement.ts). It belongs to the box that clips.
    row.setAttribute(MENU_CLIP_ATTR, "");

    /** One edge chevron: shown only while the row can move that way. */
    function makeScroller(direction: "start" | "end"): HTMLButtonElement {
        const btn = document.createElement("button");
        btn.className = `ui-btn tb-btn tb-dock-scroll tb-dock-scroll--${direction}`;
        btn.innerHTML = direction === "start" ? IconChevronLeft : IconChevronRight;
        const label = direction === "start"
            ? t("Scroll the formatting controls left")
            : t("Scroll the formatting controls right");
        btn.setAttribute("aria-label", label);
        // A chevron at the edge of a scrolling row is the one control here
        // whose PURPOSE a glyph does not carry: an arrow against the window's
        // edge reads as "there is more" without saying that pressing it is
        // what fetches the more. The tooltip is the sentence.
        //
        // Placed below, which is the side with room: the row is the bar's last
        // child, so above is the bar's own first row.
        applyTooltip(btn, label, { placement: "below" });
        // Out of the tab order and hidden from assistive tech: these move a
        // viewport, they do not reach anything. Every control they scroll to is
        // already focusable and already reachable by tabbing, which scrolls it
        // into view on its own, so a keyboard or screen-reader user gains
        // nothing here and would have two extra stops to pass.
        btn.tabIndex = -1;
        btn.setAttribute("aria-hidden", "true");
        bindActivate(btn, () => {
            // Just under a full pane, so something that was at the edge stays
            // on screen and the jump has an anchor in what was already there.
            const step = Math.max(40, row.clientWidth * 0.8);
            row.scrollBy({ left: direction === "start" ? -step : step, behavior: "smooth" });
        });
        return btn;
    }

    const scrollStart = makeScroller("start");
    const scrollEnd = makeScroller("end");

    /**
     * The gradient under one chevron, as an element of its own rather than a
     * pseudo-element on the button (dock.css says why the obvious shape does
     * not work). Purely decorative, so it is hidden from assistive tech; the
     * button on top of it carries the label.
     */
    function makeFade(direction: "start" | "end"): HTMLElement {
        const fade = document.createElement("div");
        fade.className = `tb-dock-fade tb-dock-fade--${direction}`;
        fade.setAttribute("aria-hidden", "true");
        return fade;
    }

    const fadeStart = makeFade("start");
    const fadeEnd = makeFade("end");

    /**
     * Show each chevron only while the row can move that way.
     *
     * A tolerance rather than an equality: `scrollLeft` is fractional under
     * display scaling and after a smooth scroll settles, so `scrollLeft === 0`
     * and `scrollLeft + clientWidth === scrollWidth` both fail at rest by a
     * fraction of a pixel and leave a chevron pointing at nothing.
     */
    function paintScrollers(): void {
        const slack = row.scrollWidth - row.clientWidth;
        const atStart = row.scrollLeft <= 1;
        const atEnd = row.scrollLeft >= slack - 1;
        scrollStart.hidden = slack <= 1 || atStart;
        scrollEnd.hidden = slack <= 1 || atEnd;
        // The fade goes with its chevron, always. A gradient left behind on an
        // edge with nothing past it says the row scrolls when it does not.
        fadeStart.hidden = scrollStart.hidden;
        fadeEnd.hidden = scrollEnd.hidden;
    }

    // Fades first, so the buttons paint over them in DOM order as well as by
    // z-index; the chevron is the thing being pressed.
    el.append(row, fadeStart, fadeEnd, scrollStart, scrollEnd);
    row.addEventListener("scroll", paintScrollers, { passive: true });
    // The row's own box changes with the window, and its content's width
    // changes when the items are rendered into it. Both move the answer, and
    // neither fires a scroll event.
    const rowResize = typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => paintScrollers())
        : null;
    rowResize?.observe(row);

    let expanded = readExpanded();

    /**
     * The early half of the reveal. Hover and focus are dock.css's, and they
     * work with this disposed; what this adds is the band below the row, so
     * the controls are already up by the time the pointer arrives.
     *
     * The band is a little deeper than the row is tall, which is what makes it
     * an approach rather than a near miss: a pointer heading for the bar
     * crosses it while still clearly in the document.
     */
    const reveal = createProximityReveal({
        el,
        marginPx: 72,
        className: "tb-dock--near",
    });

    function paint(): void {
        el.dataset["expanded"] = String(expanded);
        // `hidden` rather than a CSS rule on a row that is still in the box:
        // the bar measures its own height, so a collapsed row has to stop
        // occupying one or the content below never comes back up.
        el.hidden = !expanded;
        // A hidden row measures zero, so the chevrons have to be recomputed on
        // the way back rather than trusted from when it was closed.
        paintScrollers();
        // Nothing to reveal while the row is away, so the listener goes too:
        // a surface with the setting off pays nothing for a feature it is not
        // showing (docs/DESIGN_PRINCIPLES.md, "A disabled feature costs
        // nothing"). Coming back, the row's box is new, so the cached edge is
        // dropped with it.
        reveal.setActive(expanded);
    }

    /** Show or hide the row. */
    function setExpanded(next: boolean): void {
        if (next === expanded) { return; }
        expanded = next;
        paint();
    }

    paint();

    return {
        el,
        render(ids: readonly ToolbarItemId[]): void {
            row.replaceChildren();
            // Rules BETWEEN runs and never around them, so a row that happens
            // to hold one kind of control carries no chrome, and a leading or
            // trailing rule cannot be drawn by construction rather than by a
            // check here. An empty run is impossible: `groupRuns` only opens
            // one to put an item in it.
            let first = true;
            for (const run of groupRuns(ids)) {
                const built = run.map((id) => items[id]).filter((el): el is HTMLElement => !!el);
                // A run whose every item this host declined leaves no gap and
                // no rule; the next one that has items is the next first.
                if (built.length === 0) { continue; }
                if (!first) {
                    // A hairline of the bar's own ink rather than a menu
                    // divider: this run is horizontal, so the rule is vertical,
                    // and `makeSep` draws the other axis.
                    const sep = createSeparator("tb-dock-sep");
                    sep.setAttribute("role", "separator");
                    sep.setAttribute("aria-orientation", "vertical");
                    row.appendChild(sep);
                }
                first = false;
                for (const item of built) { row.appendChild(item); }
            }
            paintScrollers();
        },
        isExpanded: () => expanded,
        setExpanded,
        dispose(): void {
            rowResize?.disconnect();
            row.removeEventListener("scroll", paintScrollers);
            reveal.dispose();
            el.remove();
        },
    };
}
