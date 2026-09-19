/**
 * The side-panel shell: a fixed drawer under the topbar that docks beside the
 * content when the viewport has room and floats over it when it does not, with
 * a hover-revealed resize sash on its inner edge, a reveal tab at its docked
 * corner while closed, a hover/focus flyout preview off that tab, and a side
 * switch. Everything INSIDE the drawer is the composer's: the table of
 * contents (components/toc) is the first, and a file explorer composes the
 * same shell with different rows.
 *
 * Two class vocabularies are written on the same nodes, on purpose.
 * `side-panel*` is what sidePanel.css styles, once, for every composer.
 * `${prefix}-*` (the panel's `toc-panel--open`, the body's `toc-open`, the
 * tab's `toc-toggle-tab`) is what the composer's own stylesheets, the editor's
 * margin math in style.css and every test selector read; the shell writes
 * those strings exactly as the composer wrote them before the shell existed.
 * Body classes are one panel's by nature, so nothing in sidePanel.css keys on
 * them; state the reveal tab draws lives on the tab (revealTab.ts).
 *
 * What the shell asks the composer, and when:
 * - `renderBody` whenever the panel becomes or stays visible in a commit, and
 *   as the flyout comes out, before it is positioned.
 * - `onPresentationSync` after every presentation commit (a sync, a width
 *   change, the flyout in or out), for anything measured against the panel's
 *   geometry.
 * - `onFlyoutShown` once the flyout's final layout exists.
 * - `openOnDock` when the viewport regains room for a docked drawer: whether
 *   it comes back open is the composer's policy (a remembered choice, an
 *   auto-open heuristic), not the shell's.
 * - `suppressTransitions` before every commit: while it answers true the
 *   commit lands with transitions off. The load reveal is two commits in a
 *   race the composer alone can see (toc/index.ts `initialLoad`), so it is a
 *   predicate rather than an argument to `sync`, or a commit the shell makes
 *   on its own (a resize mid-load) would animate.
 *
 * `setOpen` records state and commits nothing; `sync` commits. The pair is
 * exposed because a composer decides open-ness from a document walk it has
 * already paid for and wants exactly one commit, or none (toc `refreshContent`
 * commits only when the walk flipped visibility). `open`, `close` and `toggle`
 * are the pair in one call.
 */
import "./sidePanel.css";
import { bindActivate } from "@/ui/dom";
import { applyTooltip } from "@/ui/tooltip";
import { onOutsideClick } from "@/ui/outsideClick";
import { getContentAreaTop, getTopbarBottom } from "@/utils/headingUtils";
import type { EventManager } from "@/eventManager";
import { createRevealTab, sideIcon } from "./revealTab";
import { wireResizeHandle } from "./resize";
import { createFlyout } from "./flyout";

export type SidePanelMode = "docked" | "overlay";

/**
 * What a viewport too narrow to hold the drawer AND a comfortable column
 * beside it does to the drawer.
 *
 * `float` is the responsive rule: the drawer becomes an overlay over the
 * content and closes, and comes back docked (if `openOnDock` says so) when the
 * room returns. It is right for a drawer the document's own shape opens, where
 * a window too narrow for both means the document wins.
 *
 * `hold` keeps the drawer docked at every width, and the content column gives
 * up the room instead. It is right for a drawer the reader opened on purpose
 * and navigates with: a file list that closes itself when the window narrows
 * is one they have to open again after every resize, and an overlay that
 * dismisses on the next click into the document is the same cost per file.
 * There is no floor under it, deliberately: a window narrow enough for the
 * content column to be uncomfortable is a window whose reader can hide the
 * drawer, and a drawer that decided that for them is what this exists to stop.
 */
export type SidePanelNarrowPolicy =
    | { kind: "float"; minContentWidth: number }
    | { kind: "hold" };

export interface SidePanelWidth {
    /** The `:root` custom property the width is read from at mount and
     *  written to on every change; the composer's host injects the persisted
     *  value there. */
    cssVar: string;
    default: number;
    min: number;
    max: number;
    /** The width the user settled on (mouseup, or the double-click reset):
     *  what the composer persists. Never per pointer move. */
    onCommit: (width: number) => void;
}

/**
 * How far a drawer drawn as a SURFACE SET INTO the window stands in from its
 * edges, and the one number for every such drawer: a reader sees the two
 * side by side (the file list and the outline can be docked at once), so two
 * insets that merely happen to be equal are two that can drift apart in a
 * commit that only meant to move one.
 *
 * Deliberately well under what the platform's own sidebars take: these are
 * panels inside an editor window, not windows in their own right. A drawer
 * that wants to be flush against the frame passes no inset at all.
 */
export const SIDE_PANEL_INSET = 8;

/**
 * What reveals the panel while it is closed. `tab` puts the reveal tab on the
 * page and arms it as the flyout trigger. `external` builds the tab (the
 * flyout's default anchor, whose box the positioning reads) but never appends
 * it: the surface carries a button that does exactly this elsewhere, and
 * registers it through `setFlyoutTrigger`.
 */
export type SidePanelTrigger =
    | { kind: "tab"; tooltip: string }
    | { kind: "external" };

export interface SidePanelShellOptions {
    /** Body classes are `${prefix}-open` and kin; the panel is `${prefix}-panel`
     *  with `${prefix}-panel--*` modifiers; the tab is `${prefix}-toggle-tab`. */
    prefix: string;
    /** Further classes on the panel element, beside `side-panel` and `${prefix}-panel`. */
    panelClasses?: readonly string[];
    /**
     * How far the drawer stands in from the window's edges, in CSS pixels:
     * the bottom and the docked edge, so it reads as a surface set into the
     * window rather than a column flush against its frame. Never the top,
     * which is the window's own chrome rather than an edge (`updatePosition`
     * has the reason). The
     * inset comes out of the drawer's OWN box, never out of the room it
     * takes (`dockedReserve` is the width as ever), so the content beside it
     * and the formatting row above that content keep the width as their one
     * number. It also takes the drawer's reveal tab in, since the tab has to
     * land on a hide button that went in with the panel. Default 0, a drawer
     * flush to the frame; both drawers that exist take `SIDE_PANEL_INSET`.
     */
    inset?: number;
    eventManager: EventManager;
    /** The docked edge at mount; `setSide` moves it. */
    initialRight: boolean;
    width: SidePanelWidth;
    /** What a viewport with no room for both does to this drawer, and the
     *  content column "room" is measured against (`SidePanelNarrowPolicy`). */
    narrow: SidePanelNarrowPolicy;
    /** Pixels another docked panel already takes on the viewport (a second
     *  side panel on the same surface). Read at every mode decision. */
    neighborReserve?: () => number;
    /** This panel's own `dockedReserve` just changed (it opened or closed
     *  docked, flipped mode, or was resized): what a NEIGHBOUR wires to its
     *  own `checkResponsiveMode`, so the two panels' docking decisions are
     *  re-made when either moves rather than only on a viewport resize. */
    onReserveChange?: () => void;
    trigger: SidePanelTrigger;
    /** What the reveal tab's click and Enter/Space run. Defaults to `toggle`;
     *  a composer that persists the choice passes its own. */
    onTabActivate?: () => void;
    openOnDock: () => boolean;
    renderBody: () => void;
    onPresentationSync?: () => void;
    onFlyoutShown?: () => void;
    suppressTransitions?: () => boolean;
    /** Where focus goes when the panel stops being focusable with the
     *  keyboard inside it. */
    focusEditor: () => void;
    /** A document drag in flight: the flyout must not retract under it. */
    dragInFlight?: () => boolean;
    /** An outside mousedown the overlay must NOT close on (a drag source
     *  whose gesture travels into the panel). */
    outsideClickExempt?: (e: MouseEvent) => boolean;
}

export interface SidePanelShell {
    readonly panel: HTMLElement;
    /** The reveal tab: on the page under `trigger.kind === "tab"`, built and
     *  detached otherwise. */
    readonly tabEl: HTMLElement;
    /** An empty container for the composer's panel controls (hide, side
     *  switch), hidden while the flyout is out. The composer places it. */
    readonly controlsSlot: HTMLElement;
    isOpen: () => boolean;
    /** On screen in ANY form: docked or overlay open, or transiently flown out. */
    isVisible: () => boolean;
    isRight: () => boolean;
    mode: () => SidePanelMode;
    /** Record the open state; `sync` commits it. */
    setOpen: (open: boolean) => void;
    open: () => void;
    close: () => void;
    toggle: () => void;
    /** Re-commit the whole presentation: open/mode classes, the tab, the
     *  outside-click listener, and (when visible) the body. The RARE path, a
     *  toggle, a responsive flip, an edge swap, or load, never a keystroke. */
    sync: () => void;
    /** Read the viewport and record the mode with no commit: the mount path,
     *  where the composer decides the opening state from the mode and
     *  commits once. */
    settleMode: () => SidePanelMode;
    /** Re-read the viewport; on a mode change, decide open-ness and commit. */
    checkResponsiveMode: () => void;
    /** The width this panel takes off the viewport while docked open, else
     *  0: what a second side panel subtracts before deciding whether it can
     *  dock (its `neighborReserve`). */
    dockedReserve: () => number;
    /** Align the drawer under the topbar and land the tab over the controls. */
    updatePosition: () => void;
    setSide: (right: boolean) => void;
    /** The dock-side glyph, for a composer's hide button that mirrors the tab. */
    sideIcon: () => string;
    width: () => number;
    /** Clamp and apply; the mode is NOT re-evaluated (the drag path does that
     *  on mouseup). A one-shot change from a settings echo also wants
     *  `checkResponsiveMode`. */
    setWidth: (width: number) => void;
    showFlyout: () => void;
    hideFlyout: () => void;
    hideFlyoutImmediate: () => void;
    isFlyoutOpen: () => boolean;
    flyoutTrigger: () => HTMLElement;
    /** Hand the hover/focus preview to a button outside the panel. Honoured
     *  only under `trigger.kind === "external"`: anywhere else it would arm a
     *  SECOND trigger beside the tab's own. */
    setFlyoutTrigger: (el: HTMLElement) => void;
    dispose: () => void;
}

export function createSidePanelShell(opts: SidePanelShellOptions): SidePanelShell {
    const { prefix } = opts;
    const body = document.body;
    const neighborReserve = opts.neighborReserve ?? (() => 0);
    const onReserveChange = opts.onReserveChange ?? (() => {});
    const dragInFlight = opts.dragInFlight ?? (() => false);
    const onPresentationSync = opts.onPresentationSync ?? (() => {});
    const onFlyoutShown = opts.onFlyoutShown ?? (() => {});
    const suppressTransitions = opts.suppressTransitions ?? (() => false);

    let right = opts.initialRight;
    let mode: SidePanelMode = "overlay";
    let isOpen = false;

    const panel = document.createElement("div");
    panel.className = ["side-panel", `${prefix}-panel`, ...(opts.panelClasses ?? [])].join(" ");
    // The docked width follows the composer's :root variable; bound here as a
    // panel-scoped custom property so sidePanel.css names no composer.
    panel.style.setProperty("--side-panel-width", `var(${opts.width.cssVar}, ${opts.width.default}px)`);
    const inset = Math.max(0, opts.inset ?? 0);
    panel.style.setProperty("--side-panel-inset", `${inset}px`);

    /** Every panel state is written in both vocabularies (see the header). */
    function setPanelState(name: string, on: boolean): void {
        panel.classList.toggle(`side-panel--${name}`, on);
        panel.classList.toggle(`${prefix}-panel--${name}`, on);
    }
    setPanelState("right", right);

    const controlsSlot = document.createElement("div");
    controlsSlot.className = "side-panel-controls";

    // The tab stands in from the window by the drawer's own inset, because
    // the button it has to land on rides the drawer and went in with it.
    const tab = createRevealTab(prefix, inset);
    const tabEl = tab.el;

    // Injected by the host on :root (the persisted value, or absent).
    function readInitialWidth(): number {
        const raw = getComputedStyle(document.documentElement).getPropertyValue(opts.width.cssVar);
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) ? clampWidth(parsed) : opts.width.default;
    }
    function clampWidth(width: number): number {
        return Math.min(opts.width.max, Math.max(opts.width.min, Math.round(width)));
    }
    let width = readInitialWidth();

    function setWidth(next: number): void {
        width = clampWidth(next);
        document.documentElement.style.setProperty(opts.width.cssVar, `${width}px`);
        updateTab();
        onPresentationSync(); // the row's available width changed
        notifyReserve();
    }

    function dockedReserve(): number {
        return isOpen && mode === "docked" ? width : 0;
    }

    // The neighbour is told only when the number it reads actually moved, so
    // a commit that changes nothing about the docked footprint (a flyout, a
    // body re-render) costs it nothing, and the two panels cannot ping-pong:
    // each tells the other only on a change, and a change a re-check causes
    // is at most one more.
    let lastReserve = 0;
    function notifyReserve(): void {
        const next = dockedReserve();
        if (next === lastReserve) {
            return;
        }
        lastReserve = next;
        onReserveChange();
    }

    function updateTab(): void {
        tab.setSide(right);
    }

    function updateBodyClasses(): void {
        body.classList.toggle(`${prefix}-docked`, mode === "docked");
        body.classList.toggle(`${prefix}-overlay`, mode === "overlay");
        body.classList.toggle(`${prefix}-open`, isOpen && mode === "docked");
        body.classList.toggle(`${prefix}-overlay-open`, isOpen && mode === "overlay");
        // Hidden while the panel is open: the composer's hide button is the
        // control then.
        tab.setConcealed(isOpen);
    }

    /** Outside-click detach handle (null while the overlay dismissal is off). */
    let outsideOff: (() => void) | null = null;
    let outsideArmTimer: ReturnType<typeof setTimeout> | null = null;

    function syncOutsideClickHandler(): void {
        outsideOff?.();
        outsideOff = null;
        if (isOpen && mode === "overlay") {
            // Deferred one tick so the opening click can't instantly close the
            // overlay; the state is re-checked (and any listener a racing sync
            // already attached is detached first) when the timeout fires.
            outsideArmTimer = setTimeout(() => {
                outsideArmTimer = null;
                if (isOpen && mode === "overlay") {
                    outsideOff?.();
                    // Bubble phase (`capture: false`), matching the
                    // hand-rolled original.
                    outsideOff = onOutsideClick([panel], (e) => {
                        if (opts.outsideClickExempt?.(e)) {
                            return;
                        }
                        close();
                    }, { capture: false });
                }
            }, 0);
        }
    }

    function isVisible(): boolean {
        return isOpen || flyout.isOpen();
    }

    /**
     * MAR-295: when the panel stops being focusable while the keyboard is
     * inside it (the hide button, the panel-toggle command, a responsive
     * docked-to-overlay collapse, a flyout teardown) focus goes back to the
     * editor, exactly where Escape would have put it. Without this it drops
     * to <body>, stranding the keyboard nowhere. Only ever called when the
     * panel is NOT visible, so an open panel's focus is never yanked.
     */
    function restoreFocusToEditor(): void {
        if (panel.contains(document.activeElement)) {
            opts.focusEditor();
        }
    }

    function setInstant(on: boolean): void {
        body.classList.toggle(`${prefix}-initial`, on);
        panel.classList.toggle("side-panel--instant", on);
        tab.setInstant(on);
    }

    function sync(): void {
        // Suppress the slide/fade for the commits the composer says so for
        // (the initial load reveal).
        const instant = suppressTransitions();
        if (instant) {
            setInstant(true);
        }
        setPanelState("open", isOpen);
        setPanelState("docked", mode === "docked");
        setPanelState("overlay", mode === "overlay");
        updatePosition();
        updateBodyClasses();
        updateTab();
        syncOutsideClickHandler();
        // Render whenever the panel is VISIBLE, docked/overlay open OR flown
        // out: a flyout shows the panel with isOpen false, and its body must
        // still track the document.
        if (isVisible()) {
            opts.renderBody();
        } else {
            restoreFocusToEditor(); // the panel just stopped being focusable (MAR-295)
        }
        onPresentationSync(); // presentation (open/side/mode) may have changed the geometry
        if (instant) {
            // Flush the no-transition state, then re-enable transitions with no
            // pending change so nothing animates from this commit.
            void panel.offsetWidth;
            setInstant(false);
        }
        notifyReserve();
    }

    function close(): void {
        isOpen = false;
        sync();
    }

    function open(): void {
        flyout.hideImmediate();
        isOpen = true;
        sync();
    }

    function toggle(): void {
        // Drop any preview first. A flown-out panel carries its own classes and
        // its own inline position, and docking it open on top of that leaves a
        // panel that is open and still drawn as a floating card halfway down
        // the window.
        flyout.hideImmediate();
        isOpen = !isOpen;
        sync();
    }

    // Docked when the viewport can hold the drawer plus a comfortable content
    // column beside it (less whatever a neighbouring panel already takes): a
    // pure viewport measure, identical in fixed and full-width mode. Measuring
    // the content's own position instead would be circular, since the content
    // recenters into the space beside a docked drawer.
    //
    // A drawer that holds the dock asks nothing: its answer is yes at every
    // width, which is also why it has no content column to be measured against
    // (`SidePanelNarrowPolicy`).
    function hasEnoughSpace(): boolean {
        if (opts.narrow.kind === "hold") {
            return true;
        }
        return window.innerWidth - neighborReserve() >= width + opts.narrow.minContentWidth;
    }

    function resolveMode(): SidePanelMode {
        return hasEnoughSpace() ? "docked" : "overlay";
    }

    function checkResponsiveMode(): void {
        const nextMode = resolveMode();
        if (nextMode === mode) {
            return;
        }
        mode = nextMode;
        isOpen = mode === "docked" ? opts.openOnDock() : false;
        sync();
    }

    /**
     * The drawer runs from its top edge to the window's bottom edge, less its
     * inset at the BOTTOM only, and which top edge that is depends on the mode.
     *
     * Flush at the top, and that is the one direction the inset does not go.
     * The chrome above the drawer is the window's own, and the air between the
     * two read as part of it: on the Mac app the toolbar band ends where this
     * drawer begins, so an inset there put eight points of paper under a row
     * of controls that were centred without it, and the window's furniture
     * looked high in a strip it did not own. The sides and the foot still
     * stand in, which is what gives the card its ground and its radius
     * something to be drawn against.
     *
     * DOCKED, the drawer stands beside the content: its top is the content
     * area's, which on the surface with a formatting row is the row's own top
     * edge rather than the bar's bottom (utils/headingUtils.ts,
     * `getContentAreaTop`), because the row starts where the drawer ends and
     * the two draw one edge. The tab lands on the same edge.
     *
     * OVERLAY, the drawer floats over the document, the row carries no margin
     * for it, and its z-index is below the bar's: a top at the row's edge
     * would put its first rows UNDER the row. So it floors at the bar's
     * bottom, as the flyout card does, for the same reason.
     *
     * Re-read on every commit (`sync`), because the answer moves with the
     * mode and not only with the window.
     */
    function updatePosition(): void {
        const edge = mode === "docked" ? getContentAreaTop() : getTopbarBottom();
        panel.style.top = `${edge}px`;
        panel.style.height = `calc(100vh - ${edge + inset}px)`;
        tab.setTop(edge);
    }

    function setSide(nextRight: boolean): void {
        if (nextRight === right) {
            return;
        }
        right = nextRight;
        body.classList.toggle(`${prefix}-right`, right);
        setPanelState("right", right);
        // The available side-space changed, so re-evaluate docked/overlay, then
        // re-sync classes and the tab's side/position (sync runs updateTab).
        updatePosition();
        checkResponsiveMode();
        sync();
    }

    const resizeCursor = (window.__i18n?.isMac ?? false) ? "col-resize" : "ew-resize";
    wireResizeHandle({
        panel,
        prefix,
        cursor: resizeCursor,
        isRight: () => right,
        width: () => width,
        defaultWidth: opts.width.default,
        applyWidth: setWidth,
        setResizing: (on) => {
            body.classList.toggle(`${prefix}-resizing`, on);
            tab.setInstant(on);
        },
        tabEl,
        onCommit: opts.width.onCommit,
        afterCommit: checkResponsiveMode,
    });

    const flyout = createFlyout({
        panel,
        prefix,
        tab: tabEl,
        armTab: opts.trigger.kind === "tab",
        isOpen: () => isOpen,
        isRight: () => right,
        dragInFlight,
        setPanelState,
        setBodyFlag: (on) => {
            body.classList.toggle(`${prefix}-flyout-open`, on);
            tab.setFlyoutOpen(on);
        },
        renderBody: opts.renderBody,
        onPresentationSync,
        onFlyoutShown,
        restoreFocus: restoreFocusToEditor,
        afterTeardown: updatePosition,
    });

    // The reveal tab: on the page only where the surface has not withdrawn it.
    // Click and Enter/Space run the composer's toggle (the mousedown path never
    // fires for the keyboard, since a button synthesizes a click, not a
    // mousedown; Space is prevented so it doesn't scroll).
    const onTabActivate = opts.onTabActivate ?? toggle;
    bindActivate(tabEl, onTabActivate);
    tabEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onTabActivate();
        }
    });
    if (opts.trigger.kind === "tab") {
        body.appendChild(tabEl);
        applyTooltip(tabEl, opts.trigger.tooltip, { placement: "below" });
    }

    // Kept to unbind on dispose: a resize after the panel is gone would
    // otherwise re-sync it and write its body classes back, and the editor's
    // margin math would make room for a panel that does not exist.
    const offResize = opts.eventManager.onWindow("resize", () => {
        updatePosition();
        checkResponsiveMode();
    });
    // The viewport can change size without a `resize` event this page hears:
    // a page loaded into a tab of an existing window settles its mode while
    // its view is still at the size it was created at, and is then given the
    // window's, with the event having fired before the shell existed or not
    // at all. Left to the event alone the drawer stays in overlay mode at a
    // width that docks, closed, or docked at the bar's bottom rather than the
    // row's top. So the root element's box is watched too, which follows the
    // viewport whatever delivered the change.
    const viewportResize = typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => { updatePosition(); checkResponsiveMode(); })
        : null;
    viewportResize?.observe(document.documentElement);
    // The edge the drawer hangs from moves without the window moving: the bar
    // grows a row, a host's strip under it comes or goes. The inline `top`
    // written above cannot follow a variable, so the bar's box is watched.
    const topbar = document.querySelector(".editor-topbar");
    const topbarResize = topbar && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => updatePosition())
        : null;
    topbarResize?.observe(topbar as Element);

    return {
        panel,
        tabEl,
        controlsSlot,
        isOpen: () => isOpen,
        isVisible,
        isRight: () => right,
        mode: () => mode,
        setOpen: (next) => { isOpen = next; },
        open,
        close,
        toggle,
        sync,
        settleMode: () => {
            mode = resolveMode();
            return mode;
        },
        checkResponsiveMode,
        dockedReserve,
        updatePosition,
        setSide,
        sideIcon: () => sideIcon(right),
        width: () => width,
        setWidth,
        showFlyout: flyout.show,
        hideFlyout: flyout.hide,
        hideFlyoutImmediate: flyout.hideImmediate,
        isFlyoutOpen: flyout.isOpen,
        flyoutTrigger: flyout.anchor,
        setFlyoutTrigger: (el) => {
            if (opts.trigger.kind !== "external") { return; }
            flyout.setAnchor(el);
            flyout.armTrigger(el);
        },
        dispose: () => {
            if (outsideArmTimer) { clearTimeout(outsideArmTimer); outsideArmTimer = null; }
            outsideOff?.();
            outsideOff = null;
            offResize();
            topbarResize?.disconnect();
            viewportResize?.disconnect();
            flyout.dispose();
        },
    };
}
