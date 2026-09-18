/**
 * The reveal tab: a standalone fixed icon button at the panel's docked outer
 * corner, shown only while the panel is closed. It carries the same side-bar
 * glyph as the panel's own hide button and sits at the same corner, so hiding
 * the panel reads as the control staying put while the panel slides away
 * behind it.
 *
 * Its geometry is load-bearing. The closed tab must sit exactly over the open
 * hide button so the glyph does not shift on toggle: the composer's floating
 * controls are inset from the drawer's top trailing corner by these amounts
 * (`.toc-controls` top/right in toc.css is the first composer's), the tab and
 * the control buttons share the same box (22px) and glyph (15px), so matching
 * the insets keeps the glyph perceptually stable across the toggle.
 *
 * The tab is `position: fixed` and the hide button rides the panel, so a
 * drawer that stands in from the window (`SIDE_PANEL_INSET`) takes its button
 * in with it and the tab has to follow by the same amount. Both of these
 * insets are therefore measured from the DRAWER's corner rather than the
 * window's, and the shell hands each one the drawer's inset to add.
 *
 * State the tab draws is written on the tab itself (`side-panel-tab--*`),
 * never keyed on a body class: the shell serves more than one panel, and a
 * body class is one panel's. The body classes the composer's own stylesheets
 * read (`toc-open` and kin) are still set by the shell, unchanged.
 */
import { IconPanelLeft, IconPanelRight } from "@/ui/icons";

/** Inset from the drawer's docked outer edge, matching the panel controls'
 *  trailing inset. The drawer's own inset from the WINDOW is added to it. */
export const TAB_EDGE_INSET = 7;
/** Nudged down a touch from a pure top inset so the glyph optically centers on
 *  the first row's text (lowercase-dominant, so its optical center sits low). */
export const TAB_TOP_INSET = 7;

/** The side-bar glyph whose filled edge marks the dock side. */
export function sideIcon(right: boolean): string {
    return right ? IconPanelRight : IconPanelLeft;
}

export interface RevealTab {
    readonly el: HTMLElement;
    /** Pin to the docked outer edge and draw that side's glyph. CSS conceals
     *  the tab while the panel is open (the panel's hide button rules then). */
    setSide: (right: boolean) => void;
    /** Land the glyph exactly where the panel's hide button sits: the topbar's
     *  bottom plus the controls' top inset. */
    setTop: (topbarBottom: number) => void;
    /** Hidden while the panel is open, in either mode. */
    setConcealed: (on: boolean) => void;
    /** Transitions off for the current commit (load reveal, a resize drag). */
    setInstant: (on: boolean) => void;
    /** Lifted above the flown-out panel and held in its hover look. */
    setFlyoutOpen: (on: boolean) => void;
}

export function createRevealTab(prefix: string, inset = 0): RevealTab {
    const el = document.createElement("button");
    el.className = `ui-btn ui-btn--icon side-panel-tab ${prefix}-toggle-tab`;
    // Keyboard-reachable: Tab focuses it (flying the panel out as a preview via
    // the shell's focus listener), Enter/Space docks it open. Without tabIndex
    // 0, and because the click path preventDefaults click-focus, the focus
    // path would be dead and the flyout pointer-only.
    el.tabIndex = 0;

    return {
        el,
        setSide: (right) => {
            el.innerHTML = sideIcon(right);
            if (right) {
                el.style.left = "auto";
                el.style.right = `${TAB_EDGE_INSET + inset}px`;
            } else {
                el.style.right = "auto";
                el.style.left = `${TAB_EDGE_INSET + inset}px`;
            }
        },
        setTop: (topbarBottom) => {
            el.style.top = `${topbarBottom + TAB_TOP_INSET + inset}px`;
        },
        setConcealed: (on) => { el.classList.toggle("side-panel-tab--concealed", on); },
        setInstant: (on) => { el.classList.toggle("side-panel-tab--instant", on); },
        setFlyoutOpen: (on) => { el.classList.toggle("side-panel-tab--flyout-open", on); },
    };
}
