/**
 * The flyout: while the collapsed panel's trigger is hovered or focused, the
 * panel is revealed transiently as a floating card BELOW the trigger (the
 * Claude-desktop sidebar pattern), retracting when the pointer and focus have
 * left both the trigger and the panel. A click still opens it persistently
 * (the composer's toggle). The flyout floats OVER the content (never pushes
 * it) and never fights the persistent open state: `show` bails when the panel
 * is already open.
 *
 * The trigger is whatever the pointer rests on to preview the panel: the
 * reveal tab, or a button elsewhere that replaced it (`setAnchor`). It is read
 * at flyout time rather than captured, so a replacement can arrive later than
 * this module does (a toolbar built after the panel).
 *
 * Exit is a fade plus a slight slide-up, and the box is torn down only once
 * the exit transition finishes, so it never animates back through the full
 * drawer (the visible "shrink to hidden full size" artifact).
 */
import { hideTooltip } from "@/ui/tooltip";
import { claimExclusiveChrome, releaseExclusiveChrome } from "@/ui/exclusiveChrome";
import { clearHostStrip, getTopbarBottom } from "@/utils/headingUtils";

/** Must match the exit transition in sidePanel.css (`.side-panel--flyout`). */
export const FLYOUT_EXIT_MS = 150;
/** Standard flyout width: a fixed dropdown width, independent of the docked
 *  panel's (possibly dragged) width variable. Kept in sync with sidePanel.css. */
export const FLYOUT_WIDTH = 260;
export const FLYOUT_GAP = 6;
/** The grace period that lets the pointer cross the gap from trigger to panel. */
export const FLYOUT_HIDE_DELAY_MS = 220;
/** The hover band's height above the card, set inline per show. */
const FLYOUT_BAND_VAR = "--side-panel-flyout-band-h";

export interface FlyoutOptions {
    panel: HTMLElement;
    prefix: string;
    /** The reveal tab: the default anchor, armed as a trigger only where the
     *  composer puts it on the page. */
    tab: HTMLElement;
    armTab: boolean;
    isOpen: () => boolean;
    isRight: () => boolean;
    /** A document drag holds the flyout open: the pointer roams off the
     *  trigger and must not yank the panel out from under it. */
    dragInFlight: () => boolean;
    /** Panel state classes, generic and prefixed together (the shell's helper). */
    setPanelState: (name: string, on: boolean) => void;
    /** Body `${prefix}-flyout-open` and the tab's lifted look, together. */
    setBodyFlag: (on: boolean) => void;
    /** Fill the panel before it is shown. */
    renderBody: () => void;
    /** After a presentation commit the composer may need to re-measure. */
    onPresentationSync: () => void;
    /** After the card's final layout exists: the composer scrolls to its place. */
    onFlyoutShown: () => void;
    /** Focus left on a box that is going away goes back to the editor. */
    restoreFocus: () => void;
    /** Reassert the docked drawer's inline geometry after the box is gone. */
    afterTeardown: () => void;
}

export interface Flyout {
    show: () => void;
    hide: () => void;
    hideImmediate: () => void;
    isOpen: () => boolean;
    anchor: () => HTMLElement;
    setAnchor: (el: HTMLElement) => void;
    /** Wire one element as a hover/focus preview trigger. */
    armTrigger: (el: HTMLElement) => void;
    dispose: () => void;
}

export function createFlyout(opts: FlyoutOptions): Flyout {
    const { panel } = opts;
    let flyoutOpen = false;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
    let anchor: HTMLElement = opts.tab;
    /**
     * The flyout's identity in the one-transient-surface-at-a-time set
     * (`ui/exclusiveChrome.ts`): coming out takes down any toolbar dropdown,
     * and a dropdown opening retracts this.
     *
     * The FLYOUT alone, never the docked drawer. The drawer is a panel the
     * reader has opened and is entitled to keep; sweeping it away when a menu
     * opened would be reading the rule as being about panels rather than about
     * menus.
     */
    const exclusiveFlyout = Symbol(`${opts.prefix} flyout`);

    function cancelHide(): void {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    }
    function cancelCleanup(): void {
        if (cleanupTimer) { clearTimeout(cleanupTimer); cleanupTimer = null; }
    }

    /** Anchor the flyout as a dropdown directly BELOW its trigger, aligned to
     *  the panel's docked side: the trigger itself never moves, so the cursor
     *  stays over it (no moving target). Positioned inline; CSS gives it card
     *  chrome. */
    function position(): void {
        const r = anchor.getBoundingClientRect();
        // Under the trigger, and never inside the bar. The card is a
        // body-level surface with a z-index below the bar's, so any part of
        // it drawn in the bar's box is drawn UNDER the bar; a menu off the
        // same button may open over the bar's second row because it shares
        // the bar's stacking context, and this cannot. So the floor is the
        // bar's bottom, and past that the strip a host paints over (the Mac
        // app's tab bar) for the same reason. The hover band below is what
        // keeps the pointer's crossing covered.
        const flyoutTop = Math.round(Math.max(
            getTopbarBottom() + FLYOUT_GAP,
            clearHostStrip(r.bottom + FLYOUT_GAP, panel.offsetHeight || 1, FLYOUT_GAP),
        ));
        panel.style.top = `${flyoutTop}px`;
        panel.style.left = opts.isRight()
            ? `${Math.round(Math.max(8, r.right - FLYOUT_WIDTH))}px`
            : `${Math.round(r.left)}px`;
        // The docked drawer sets an inline `height` (the shell's updatePosition);
        // clear it so the flyout card sizes to its content via CSS (height:auto
        // capped by max-height) instead of inheriting the full drawer height and
        // padding its footer with empty space when the body is short.
        panel.style.height = "";
        // The invisible hover band above the panel spans the whole gap up to the
        // bar's bottom, so the flyout stays open while the pointer is anywhere
        // in that column: no hyper-precise mousing down. The band cannot reach
        // into the bar, so with a formatting row open the pointer crosses that
        // row on the hide delay alone; widening the band would not help, the
        // bar paints over it.
        const bandHeight = Math.max(FLYOUT_GAP, flyoutTop - getTopbarBottom());
        panel.style.setProperty(FLYOUT_BAND_VAR, `${bandHeight}px`);
    }

    /** Fully remove the flyout box (after the exit transition, or immediately
     *  for the dock-open path) and restore the docked drawer's CSS positioning. */
    function teardown(): void {
        cancelCleanup();
        // Released HERE rather than in `hide`, because the box is still on
        // screen through the exit transition and every path that removes it
        // for good arrives here: the fade-out, the dock-open, and a live
        // visibility change.
        releaseExclusiveChrome(exclusiveFlyout);
        // A flyout that retracts with the keyboard inside it (Tab moved focus
        // in; the trigger's blur timer still fires) must not strand focus on a
        // hidden box. Skipped when the teardown is the dock-open path, where
        // the panel stays visible and keeps its focus.
        if (!opts.isOpen()) { opts.restoreFocus(); }
        opts.setPanelState("flyout", false);
        opts.setPanelState("flyout-in", false);
        opts.setBodyFlag(false);
        panel.style.left = "";
        panel.style.removeProperty(FLYOUT_BAND_VAR);
        // Reassert the docked drawer's inline top+height (position cleared the
        // height so the flyout could auto-size) so a later dock-open is
        // full-height and correctly positioned again, then let the composer
        // re-measure on the docked width.
        opts.afterTeardown();
        opts.onPresentationSync();
    }

    function show(): void {
        cancelHide();
        cancelCleanup(); // interrupt a pending exit teardown, if any
        if (opts.isOpen()) { return; }
        if (flyoutOpen) {
            // Re-entered mid-exit-fade: just re-assert the shown state.
            opts.setPanelState("flyout-in", true);
            return;
        }
        flyoutOpen = true;
        // The flyout shows the panel itself, so the trigger's tooltip is
        // redundant (and would overlap the panel): dismiss it.
        hideTooltip();
        // ...and any toolbar dropdown, for the same reason one level up: two
        // transient surfaces out at once is the editor answering "what else is
        // here" twice. `hide` is the dismissal, not `teardown`, so being swept
        // looks exactly like retracting on its own.
        claimExclusiveChrome(exclusiveFlyout, panel, hide);
        opts.renderBody();
        // Enter with transitions SUPPRESSED (--flyout-enter): the closed drawer's
        // transform is translateX(+-100%), and animating straight to the flyout's
        // translateY(-6px) interpolates diagonally, a sideways sweep in from the
        // viewport edge. Snap to the flyout's start state first, then release the
        // transition so only the translateY + opacity animate.
        opts.setPanelState("flyout", true);
        opts.setPanelState("flyout-enter", true);
        opts.setBodyFlag(true);
        position();
        // The flyout has its OWN width (fixed, controls hidden), so anything the
        // composer measures against the panel's width must be re-measured for
        // it, never inherited from the docked drawer's geometry.
        opts.onPresentationSync();
        // Commit the initial (down + faded) state with no transition, then release
        // it and transition to shown, so the reveal is a slight slide-DOWN + fade.
        void panel.offsetWidth;
        opts.setPanelState("flyout-enter", false);
        opts.setPanelState("flyout-in", true);
        // The enter transition is transform/opacity only, so the geometry is
        // already final here: the composer can place its scroll.
        opts.onFlyoutShown();
    }

    /** Retract with a fade + slight slide-UP, tearing the box down only once the
     *  exit transition finishes. */
    function hide(): void {
        cancelHide();
        if (!flyoutOpen) { return; }
        flyoutOpen = false;
        opts.setPanelState("flyout-in", false); // start the exit transition
        cancelCleanup();
        cleanupTimer = setTimeout(teardown, FLYOUT_EXIT_MS + 20);
    }

    /** Drop the flyout with no exit transition: for the click/keyboard path that
     *  docks the panel open, so the flyout box never overlaps the opening drawer. */
    function hideImmediate(): void {
        cancelHide();
        if (!flyoutOpen && !cleanupTimer) { return; }
        flyoutOpen = false;
        teardown();
    }

    function scheduleHide(): void {
        cancelHide();
        // Never retract mid-drag: a reorder/refile drag moves the pointer around
        // (and off the trigger), which must not yank the panel out from under
        // it. The drag end restores normal hover via the next pointer move.
        if (opts.dragInFlight()) { return; }
        hideTimer = setTimeout(hide, FLYOUT_HIDE_DELAY_MS);
    }

    // The trigger outlives the panel (the toolbar's button does), so what was
    // armed on it is unarmed on dispose, or hovering the button after the
    // panel is gone flies a detached node out and claims the exclusive chrome
    // for it.
    let disarmTrigger: (() => void) | null = null;
    function armTrigger(el: HTMLElement): void {
        disarmTrigger?.();
        el.addEventListener("mouseenter", show);
        el.addEventListener("mouseleave", scheduleHide);
        el.addEventListener("focus", show);
        el.addEventListener("blur", scheduleHide);
        disarmTrigger = () => {
            el.removeEventListener("mouseenter", show);
            el.removeEventListener("mouseleave", scheduleHide);
            el.removeEventListener("focus", show);
            el.removeEventListener("blur", scheduleHide);
        };
    }
    if (opts.armTab) { armTrigger(opts.tab); }

    // Moving onto the flown-out panel keeps it; leaving it retracts (unless a
    // click already promoted it to a persistent open, when flyoutOpen is false).
    panel.addEventListener("mouseenter", () => { if (flyoutOpen) { cancelHide(); } });
    panel.addEventListener("mouseleave", () => { if (flyoutOpen) { scheduleHide(); } });
    // The keyboard half of the hover pair (MAR-295 follow-up): Tabbing from
    // the trigger into the flyout fires the trigger's blur, and the hide that
    // blur scheduled needs a canceller, or the flyout retracts under the
    // keyboard. Focus arriving anywhere in the panel cancels the pending hide,
    // exactly like mouseenter; the focusout handler re-arms it when focus
    // leaves, so blur-out still retracts and the flyout never turns sticky.
    panel.addEventListener("focusin", () => { if (flyoutOpen) { cancelHide(); } });
    panel.addEventListener("focusout", (e) => {
        if (flyoutOpen && !panel.contains(e.relatedTarget as Node | null)) {
            scheduleHide();
        }
    });
    // A drag holds the flyout open (scheduleHide bails while dragging), but
    // drag-end fires no mouseleave, so on mouseup, once the drag has settled,
    // retract if the pointer no longer rests on the trigger/panel/band. Without
    // this the flyout is stuck open after a drag that ends off the panel.
    const onDocumentMouseUp = (): void => {
        if (!flyoutOpen) { return; }
        requestAnimationFrame(() => {
            if (flyoutOpen && !panel.matches(":hover") && !anchor.matches(":hover")) {
                scheduleHide();
            }
        });
    };
    document.addEventListener("mouseup", onDocumentMouseUp, true);

    return {
        show,
        hide,
        hideImmediate,
        isOpen: () => flyoutOpen,
        anchor: () => anchor,
        setAnchor: (el) => { anchor = el; },
        armTrigger,
        dispose: () => {
            cancelHide();
            cancelCleanup();
            releaseExclusiveChrome(exclusiveFlyout);
            document.removeEventListener("mouseup", onDocumentMouseUp, true);
            disarmTrigger?.();
            disarmTrigger = null;
        },
    };
}
