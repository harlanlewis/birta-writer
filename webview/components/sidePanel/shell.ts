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
import { getTopbarBottom } from "@/utils/headingUtils";
import type { EventManager } from "@/eventManager";
import { createRevealTab, sideIcon } from "./revealTab";
import { wireResizeHandle } from "./resize";
import { createFlyout } from "./flyout";

export type SidePanelMode = "docked" | "overlay";

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
    eventManager: EventManager;
    /** The docked edge at mount; `setSide` moves it. */
    initialRight: boolean;
    width: SidePanelWidth;
    /** The content column that must fit beside the docked drawer, or the
     *  panel floats instead. */
    dockedMinContentWidth: number;
    /** Pixels another docked panel already takes on the viewport (a second
     *  side panel on the same surface). Read at every mode decision. */
    neighborReserve?: () => number;
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

    /** Every panel state is written in both vocabularies (see the header). */
    function setPanelState(name: string, on: boolean): void {
        panel.classList.toggle(`side-panel--${name}`, on);
        panel.classList.toggle(`${prefix}-panel--${name}`, on);
    }
    setPanelState("right", right);

    const controlsSlot = document.createElement("div");
    controlsSlot.className = "side-panel-controls";

    const tab = createRevealTab(prefix);
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
    function hasEnoughSpace(): boolean {
        return window.innerWidth - neighborReserve() >= width + opts.dockedMinContentWidth;
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

    function updatePosition(): void {
        const topbarBottom = getTopbarBottom();
        panel.style.top = `${topbarBottom}px`;
        panel.style.height = `calc(100vh - ${topbarBottom}px)`;
        tab.setTop(topbarBottom);
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

    opts.eventManager.onWindow("resize", () => {
        updatePosition();
        checkResponsiveMode();
    });

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
            flyout.dispose();
        },
    };
}
