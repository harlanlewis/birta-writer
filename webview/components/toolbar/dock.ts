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
 * Two states, and the toggle is the whole of the chrome:
 *
 *     collapsed   [T] in the top bar, no second row
 *     expanded    [T] in the top bar, and P⌄ B I ⋯ below it
 *
 * The toggle sits in the TOP BAR, beside Find, rather than at the head of the
 * row it opens. A control that opens a row cannot live in that row: collapsed,
 * it would be the only thing on it, so the bar would keep a row's worth of
 * height to hold one button and the row would never really be gone.
 *
 * A serif T because the row is about text, and because a letter survives being
 * drawn at chrome size where a glyph for "formatting" would not. No chevron
 * beside it: the row either is or is not below the bar, which says more about
 * the state than a mark next to the letter, and the bar's other controls are
 * single glyphs.
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
 */
import { IconChevronLeft, IconChevronRight } from "@/ui/icons";
import { t } from "@/i18n";
import { MENU_CLIP_ATTR } from "@/ui/anchoredPlacement";
import { getWebviewState, setWebviewState } from "@/messaging";
import { bindActivate } from "@/ui/dom";
import { applyTooltip } from "@/ui/tooltip";
import type { ToolbarItemId } from "./registry";
import "./dock.css";

/**
 * The view-state key the expanded flag rides on.
 *
 * Still says "dock" after the arrangement became `formattingInSecondRow`, and
 * that is deliberate: the bag is persisted, so renaming the key would silently
 * drop the saved choice of everyone who had opened the row. The name is
 * historical rather than descriptive, and it stays that way until there is a
 * migration worth writing for a boolean.
 */
const STATE_KEY = "formattingDockExpanded";

export interface FormattingDock {
    /** The row element. The caller places it; this module never appends it. */
    el: HTMLElement;
    /**
     * The button that opens and closes the row, for the caller to place in the
     * top bar. Handed over rather than positioned from here, because where a
     * top-bar control sits among the other top-bar controls is the layout's
     * question and this module knows nothing about the bar.
     */
    toggle: HTMLElement;
    /** Re-parent `ids`' wrappers into the row, in the order given. */
    render: (ids: readonly ToolbarItemId[]) => void;
    /** Whether the row is showing. */
    isExpanded: () => boolean;
    /** Tear down the listeners and remove the element (tests). */
    dispose: () => void;
}

export interface FormattingDockDeps {
    /** Every built item wrapper, keyed by id. Read on render; never rebuilt. */
    items: Partial<Record<ToolbarItemId, HTMLElement>>;
}

/**
 * Whether the row was left open. Defaults to CLOSED: the dock replaces a
 * setting that used to decide whether the editing controls existed at all, and
 * the answer a first run should give is the quiet one. A saved `true` is
 * honoured, so the choice survives a relaunch without being a preference
 * anybody has to go and find.
 */
function readExpanded(): boolean {
    return getWebviewState()?.[STATE_KEY] === true;
}

function writeExpanded(expanded: boolean): void {
    setWebviewState({ ...(getWebviewState() ?? {}), [STATE_KEY]: expanded });
}

export function createFormattingDock({ items }: FormattingDockDeps): FormattingDock {
    const el = document.createElement("div");
    el.className = "tb-dock";

    // Built by hand rather than through createButton, because the label and the
    // tooltip depend on the state and have to change with it: createButton
    // applies its tooltip once and keeps no handle. Placed BELOW, which is the
    // side with room now that the button sits in the top bar.
    const toggle = document.createElement("button");
    toggle.className = "ui-btn tb-btn tb-dock-toggle";
    const toggleTip = applyTooltip(toggle, "", { placement: "below" });
    bindActivate(toggle, () => setExpanded(!expanded));
    const glyph = document.createElement("span");
    glyph.className = "tb-dock-glyph";
    glyph.textContent = "T";
    // The letter alone. A chevron beside it drew a second mark for the same
    // fact the pressed state already carries, in a bar whose other controls
    // are single glyphs.
    toggle.appendChild(glyph);

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
        btn.setAttribute("aria-label", direction === "start"
            ? t("Scroll the formatting controls left")
            : t("Scroll the formatting controls right"));
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
    }

    el.append(row, scrollStart, scrollEnd);
    row.addEventListener("scroll", paintScrollers, { passive: true });
    // The row's own box changes with the window, and its content's width
    // changes when the items are rendered into it. Both move the answer, and
    // neither fires a scroll event.
    const rowResize = typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => paintScrollers())
        : null;
    rowResize?.observe(row);

    let expanded = readExpanded();

    function paint(): void {
        el.dataset["expanded"] = String(expanded);
        // `hidden` rather than a CSS rule on a row that is still in the box:
        // the bar measures its own height, so a collapsed row has to stop
        // occupying one or the content below never comes back up.
        el.hidden = !expanded;
        toggle.dataset["expanded"] = String(expanded);
        toggle.setAttribute("aria-expanded", String(expanded));
        // A hidden row measures zero, so the chevrons have to be recomputed on
        // the way back rather than trusted from when it was closed.
        paintScrollers();
        // The label says what the click DOES, which is the opposite of the
        // state; the glyph and the chevron already say which state it is in.
        const label = expanded ? t("Hide formatting controls") : t("Show formatting controls");
        toggle.setAttribute("aria-label", label);
        toggleTip.setText(label);
    }

    function setExpanded(next: boolean): void {
        if (next === expanded) { return; }
        expanded = next;
        paint();
        writeExpanded(next);
    }

    paint();

    return {
        el,
        toggle,
        render(ids: readonly ToolbarItemId[]): void {
            row.replaceChildren();
            for (const id of ids) {
                const item = items[id];
                if (item) { row.appendChild(item); }
            }
            paintScrollers();
        },
        isExpanded: () => expanded,
        dispose(): void {
            rowResize?.disconnect();
            row.removeEventListener("scroll", paintScrollers);
            el.remove();
            toggle.remove();
        },
    };
}
