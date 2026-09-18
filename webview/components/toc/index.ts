// The shell's stylesheet lands before this one: where the two tie on
// specificity, the composer's rule is the one that should win.
import { createSidePanelShell, SIDE_PANEL_INSET } from "../sidePanel/shell";
import './toc.css';
import { bindActivate } from "@/ui/dom";
import type { EditorView, Node as PmNode } from "@/pm";
import { applyTooltip } from "@/ui/tooltip";
import { t } from "@/i18n";
import { notifyTocWidth, notifyTocVisibility, notifySetTocPosition } from "@/messaging";
import type { TocVisibility } from "../../../shared/messages";
import { revealPosition } from "@/editing/blockOps";
import { IconArrowLeftRight } from "@/ui/icons";
import { hostArranges } from "../../../shared/hostProfile";
import { commandAvailable } from "../../../shared/commandAvailability";
import type { EventManager } from "@/eventManager";
import {
    getTopbarBottom,
    scrollElementBelowTopbar,
    findActiveHeading,
    collectDocHeadings,
} from "@/utils/headingUtils";
import { initTocDnd } from "./dnd";
import { wireRoving } from "../sidePanel/keyboardNav";
import { initProofreadingList } from "./proofreadingList";
import { initNotesList } from "./notesList";
import { initLinksList } from "./linksList";
import { PROOFREAD_FINDINGS_CHANGED, hasProofreadFindings } from "@/plugins/proofread";
import { requestIdle } from "@/utils/idle";
import { singleTextblockInlineEdit } from "@/utils/textblockEdit";

interface HeadingEntry {
    level: number;
    text: string;
    pos: number;
    /** At the document root (`resolve(pos).depth === 0`) — the only rows that
     *  drag/drop. Depth, NOT rank: in a flat document that is every heading,
     *  H6 included. See TocHeadingEntry in ./dropModel. */
    atDocRoot: boolean;
}

// 260 default / 240 floor: wide enough that the four tab labels + controls fit
// on one row at the default, and the floor never crushes rows into ellipsis
// soup (the old 150px floor did). The tab list wraps as the fallback below 290.
const TOC_DEFAULT_WIDTH = 260;
const TOC_MIN_WIDTH = 240;
const TOC_MAX_WIDTH = 600;
const DOCKED_MIN_CONTENT_WIDTH = 720;
const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";
const tocAutoHideThreshold = window.__i18n?.tocAutoHideThreshold ?? 3;
// ToC show/hide preference (birta.tocVisibility, via window.__i18n).
// "auto" (or absent) → the auto-open-by-heading-count heuristic governs.
const tocVisibility = window.__i18n?.tocVisibility ?? "auto";

export interface TocOptions {
    /**
     * Pixels another docked side panel already takes on the viewport (the
     * file explorer, when a directory window has one open), read at every
     * docking decision. The two panels each ask the other, so neither docks
     * into room the other is standing in.
     */
    neighborReserve?: () => number;
    /** This panel's docked footprint changed; the neighbour re-decides. */
    onReserveChange?: () => void;
}

export function initToc(eventManager: EventManager, getEditorView: () => EditorView | null, options: TocOptions = {}): {
    panel: HTMLElement;
    toggle: () => void;
    /** The width this panel takes off the viewport while docked open, else 0:
     *  what a second side panel subtracts before deciding whether it can dock. */
    dockedReserve: () => number;
    /** Re-decide docked against overlay from the viewport and the neighbour's
     *  reserve: what the neighbour's `onReserveChange` runs. */
    checkResponsiveMode: () => void;
    /** Full re-sync (presentation + content) — load time, and any caller whose
     *  own state may have changed. Not for doc changes: see refreshContent. */
    refresh: () => void;
    /** THE HOT PATH: the outline tracks a changed document. Costs at most one
     *  heading walk, and touches the DOM only when the outline really moved. */
    refreshContent: () => void;
    setPosition: (position: "left" | "right") => void;
    /** Flip to the other edge and persist it — what `swapTocSide` runs, and
     *  what the panel's own flip button runs, so there is one implementation
     *  of the gesture rather than one per surface. */
    swapSide: () => void;
    /** Apply a birta.tocVisibility change without re-persisting (keeps every open
     *  editor in sync with the setting). */
    applyVisibility: (visibility: TocVisibility) => void;
    /** Apply a birta.tocWidth change (settings edit echoed to every editor). */
    setWidth: (width: number) => void;
    /** Current open/docked-side state — drives the slash menu's dynamic toggle labels. */
    isOpen: () => boolean;
    isRight: () => boolean;
    /** Apply a birta.notes.customMarkers change to the Notes tab (rescan if shown). */
    setNotesMarkers: (markers: string[]) => void;
    /** Apply a birta.review.groupByType change to both review tabs (settings echo). */
    setReviewGroupByType: (grouped: boolean) => void;
    /** Reveal the sidebar and switch to the Proofreading tab (toolbar menu action). */
    showProofreadingTab: () => void;
    /** Reveal the sidebar (if hidden) and move keyboard focus into it — the
     *  `Focus Review Sidebar` command's entry point (MAR-294). */
    focusPanel: () => void;
    /** Hand the hover/focus preview to a button outside the panel, for the
     *  surface whose own reveal tab is withdrawn (`tocToggleInBar`). A no-op
     *  on every other surface, where the tab is still the trigger. */
    setFlyoutTrigger: (el: HTMLElement) => void;
    /** Unregister the panel's drop-zone provider (teardown/tests). */
    dispose: () => void;
} {
    // What the SURFACE has settled, read once. The two are asked differently on
    // purpose, and the difference is which question the surface answered.
    //
    // The flip button IS `swapTocSide`, so it asks the command predicate rather
    // than the arrangement behind it. `fixedTocSide` is declared on that
    // command's own metadata and read by `commandAvailable`, which is what makes
    // the palette, the slash row and this button withdraw together; reading the
    // arrangement here instead would put a second reader on one declaration and
    // let the panel and the command lists drift.
    //
    // The hide button is not a command being withdrawn: `toggleToc` still runs,
    // from the bar, the palette and the slash row. What the surface settled is
    // WHICH control carries it, and that has no command to ask.
    const offerFlip = commandAvailable("swapTocSide");
    const toggleInBar = hostArranges("tocToggleInBar");

    // The user's explicit show/hide decision, and whether one has been taken.
    // Seeded from the birta.tocVisibility setting so show/hide survives a fresh
    // webview init (reloading the window, or reopening the file). "shown"/"hidden"
    // is an explicit choice that overrides auto-open; "auto" leaves the heuristic
    // in charge. `dockedUserCollapsed` is the inverse of "visible" when docked.
    // (Switching tabs never reset this — the webview is retained hidden,
    // `retainContextWhenHidden`; this seed is only read on a brand-new webview.)
    let dockedUserCollapsed = false;
    let userToggled = false;
    if (tocVisibility === "shown" || tocVisibility === "hidden") {
        userToggled = true;
        dockedUserCollapsed = tocVisibility === "hidden";
    }

    // The initial auto-open on load should snap into place, not slide/fade in —
    // the switch into the rendered editor shouldn't draw attention to itself.
    // While this is true, every shell commit lands with transitions off.
    //
    // TWO independent commits make up the load reveal, and which of them opens
    // the panel is a race: the init rAF at the bottom of this function, and the
    // first `refresh()` after the editor mounts (index.ts calls it synchronously
    // once createEditor resolves). Either can win. Clearing the flag on
    // whichever ran first — what this used to do, from `refresh()` alone — left
    // the OTHER one to animate the reveal it was supposed to suppress: with the
    // editor mounting inside a single frame, refresh() cleared the flag before
    // the init rAF had committed anything, and the panel slid in. That is the
    // `toc` suite's intermittent "initial reveal is instant" failure, and it
    // reproduces on demand by delaying rAF so the mount always wins.
    //
    // So the flag survives until BOTH have committed, in whichever order they
    // arrive; only then does a later user toggle or resize animate.
    let initialLoad = true;
    let initRafCommitted = false;
    let mountedRefreshCommitted = false;
    const endInitialLoadIfSettled = (): void => {
        if (initRafCommitted && mountedRefreshCommitted) {
            initialLoad = false;
        }
    };

    // Headings a caller has already walked, handed through to the shell's
    // render callback for the duration of ONE commit: only a caller with
    // nothing to reuse pays a walk there.
    let pendingHeadings: HeadingEntry[] | undefined;

    // The drawer, its flyout, the resize sash, the reveal tab and the
    // docked/overlay decision are the side-panel shell's; this module fills it
    // with the outline and the review tabs, and answers its policy questions.
    // Initial side comes from the birta.tocPosition setting via a
    // server-rendered body class; the flip button mutates it live.
    const shell = createSidePanelShell({
        prefix: "toc",
        eventManager,
        initialRight: document.body.classList.contains("toc-right"),
        // Set into the window the way the file list is, and by the same
        // number (`SIDE_PANEL_INSET`): the two can be docked at once, and a
        // drawer standing in while its neighbour is flush reads as one of
        // them being misplaced. Out of the panel's own box, so the width the
        // content's margin reads is unchanged.
        inset: SIDE_PANEL_INSET,
        width: {
            // Injected by the extension as --toc-width on :root (the persisted
            // value or the default); the dragged width is reported back on
            // mouseup, never per move.
            cssVar: "--toc-width",
            default: TOC_DEFAULT_WIDTH,
            min: TOC_MIN_WIDTH,
            max: TOC_MAX_WIDTH,
            onCommit: notifyTocWidth,
        },
        dockedMinContentWidth: DOCKED_MIN_CONTENT_WIDTH,
        neighborReserve: options.neighborReserve ?? (() => 0),
        onReserveChange: options.onReserveChange,
        // Under `tocToggleInBar` the reveal tab is never put on the page: the
        // bar already carries a button that does exactly this, and two of them
        // a few pixels apart is one control drawn twice. The surface registers
        // the bar's button in its place (`setFlyoutTrigger`), so the hover
        // preview survives the withdrawal rather than being the price of it.
        trigger: toggleInBar ? { kind: "external" } : { kind: "tab", tooltip: t("Show table of contents") },
        // The tab runs THIS toggle, which persists the choice; the shell's own
        // would only flip the panel.
        onTabActivate: () => toggle(),
        openOnDock: () => (userToggled ? !dockedUserCollapsed : shouldAutoOpen(getHeadings())),
        renderBody: () => renderActiveView(pendingHeadings),
        onPresentationSync: () => syncTabOverflow(),
        onFlyoutShown: () => centerActiveRowInFlyout(),
        suppressTransitions: () => initialLoad,
        focusEditor: () => getEditorView()?.focus(),
        dragInFlight: () => document.body.classList.contains("block-dragging"),
        // A gutter-handle drag must be able to travel into an overlay TOC: the
        // grab's mousedown lands outside the panel but must not close it.
        outsideClickExempt: (e) => e.target instanceof Element && e.target.closest(".heading-fold-marker") !== null,
    });
    const { panel } = shell;

    // Controls float in the drawer's top trailing corner, layered above the list
    // which scrolls underneath them. No header row/title — the panel blends with
    // the editor background, so the drawer reads as an unadorned overlay. They are
    // only visible while the panel is open, which is exactly when a side-switch or
    // hide action makes sense.
    const controls = shell.controlsSlot;
    controls.classList.add("toc-controls");
    // The pair is its own toolbar, not part of the surrounding tablist's tab
    // set — a tablist's arrows must move between TABS (and these are not
    // tabs; the strip's keydown handler is scoped to .toc-tab for exactly
    // that reason), so reaching them takes the strip's second Tab stop.
    controls.setAttribute("role", "toolbar");
    controls.setAttribute("aria-orientation", "horizontal");
    controls.setAttribute("aria-label", t("Sidebar controls"));

    // Side-switch: moves the panel to the opposite edge. Two-way arrows read as
    // "swap sides"; the tooltip names the destination. Absent wherever
    // `swapTocSide` is withdrawn, so the panel and the command lists agree
    // without either knowing why.
    const flipBtn = document.createElement("button");
    flipBtn.className = "ui-btn ui-btn--icon toc-control-btn toc-flip-btn";
    flipBtn.innerHTML = IconArrowLeftRight;
    if (offerFlip) { controls.appendChild(flipBtn); }

    // Hide button: collapses the panel. Carries the VS Code side-bar glyph (the
    // filled edge marks the docked side) — the same icon the reveal tab uses, so
    // the two read as one persistent control as the panel slides away.
    //
    // Absent under `tocToggleInBar`, where the bar's button is the only control
    // that shows and hides the panel. Both are built either way: everything
    // below wires them, and appending is the one decision, so a withdrawn
    // control cannot half-exist with a stale glyph or a stale tooltip.
    const hideBtn = document.createElement("button");
    hideBtn.className = "ui-btn ui-btn--icon toc-control-btn toc-hide-btn";
    if (!toggleInBar) { controls.appendChild(hideBtn); }

    // A surface may withdraw both, and then the strip has no control group at
    // all: an empty `role="toolbar"` is a landmark a screen reader announces
    // and a Tab stop that lands on nothing, so it is left out rather than
    // emptied. The class is what tells the tab row it no longer has to reserve
    // the trailing room those buttons took (toc.css).
    const hasPanelControls = controls.childElementCount > 0;
    panel.classList.toggle("toc-panel--bare-tabs", !hasPanelControls);

    // MAR-295: the flip/hide pair used to sit at tabIndex -1 outside every
    // group — mouse-only. It is now the sidebar's standard shape in miniature:
    // one roving group, one Tab stop, arrows along its own (horizontal) axis.
    // wireRoving seeds the single tabbable slot, so the buttons no longer set
    // tabIndex themselves.
    if (hasPanelControls) {
        wireRoving({
            container: controls,
            items: () => [...controls.querySelectorAll<HTMLElement>("button")],
            orientation: "horizontal",
            onEscape: () => getEditorView()?.focus(),
        });
    }

    const list = document.createElement("div");
    list.className = "toc-list";
    list.setAttribute("role", "tree");

    // Keyboard navigation for the outline: arrow between visible heading rows,
    // Enter jumps, Left/Right fold a section, Escape returns to the editor.
    // (setRowCollapsed is a hoisted declaration; outlineRoving is captured by the
    // render/fold closures and only used after init.)
    const outlineRoving = wireRoving({
        container: list,
        items: () => [...list.querySelectorAll<HTMLElement>(".toc-item:not([hidden])")],
        onEscape: () => getEditorView()?.focus(),
        onHorizontal: (item, dir) => {
            if (!item.classList.contains("toc-item--parent")) { return false; }
            const isCollapsed = item.classList.contains("toc-item--collapsed");
            if (dir === -1 && !isCollapsed) { setRowCollapsed(item, true); return true; }
            if (dir === 1 && isCollapsed) { setRowCollapsed(item, false); return true; }
            return false;
        },
    });

    // ── Review tabs: Contents / Proofreading / Notes ────────────────────────
    // The panel is a 3-tab review sidebar; all the drawer chrome (docked/overlay,
    // flyout, resize, flip/hide) is shared and only the body switches. Contents
    // is the heading outline (`list`); the other two read their data live and
    // ONLY while active — an inactive tab scans/enumerates nothing (see
    // renderActiveView). Flip/hide move into the sticky tab row (right-aligned)
    // so they can't overlap the tabs.
    type ReviewTab = "contents" | "proofreading" | "notes" | "links";
    let activeTab: ReviewTab = "contents";
    // The Proofreading tab exists only while the master switch is on; when off
    // it's removed from the strip entirely (not shown with an "off" body).
    // Seeded from the injected config, kept live via proofread-config-changed.
    let proofreadingEnabled = window.__i18n?.proofread?.proofreadingEnabled ?? true;

    const tabStrip = document.createElement("div");
    tabStrip.className = "toc-tabs";
    tabStrip.setAttribute("role", "tablist");
    const tabContents = makeTabButton("contents", t("Contents"));
    const tabLinks = makeTabButton("links", t("Links"));
    const tabNotes = makeTabButton("notes", t("Notes"));
    const tabProofread = makeTabButton("proofreading", t("Proofread"));
    // A review tab exists only while it has entries. Until the first idle
    // visibility pass (scheduleTabVisibility) they stay hidden, so document
    // open pays for nothing beyond the Contents outline.
    tabLinks.hidden = true;
    tabNotes.hidden = true;
    tabProofread.hidden = true;
    // Tabs in their strip with the flip/hide controls at the trailing edge —
    // the hide button's top-right position is LOAD-BEARING (the closed reveal
    // tab sits exactly over it; see TAB_EDGE_INSET in sidePanel/revealTab.ts)
    // and must not move. When the visible tabs overflow the row, the strip
    // collapses to a SELECT: a single button showing the active tab that opens
    // a menu of the others.
    const tabsList = document.createElement("div");
    tabsList.className = "toc-tabs__list";
    tabsList.append(tabContents, tabLinks, tabNotes, tabProofread);

    const tabsSelect = document.createElement("button");
    tabsSelect.className = "ui-btn toc-tabs-select";
    // Tabbable ONLY in select mode (syncTabOverflow flips it). In list mode the
    // real tab buttons carry the strip's single Tab stop; in select mode THEY are
    // visibility:hidden — which is unfocusable — so without this the whole tab
    // strip was keyboard-dead in the default docked 260px panel (MAR-291).
    tabsSelect.tabIndex = -1;
    tabsSelect.setAttribute("aria-haspopup", "menu");
    tabsSelect.setAttribute("aria-expanded", "false");
    const tabsSelectLabel = document.createElement("span");
    const tabsSelectCaret = document.createElement("span");
    tabsSelectCaret.className = "toc-tabs-select__caret";
    tabsSelect.append(tabsSelectLabel, tabsSelectCaret);

    const tabsMenu = document.createElement("div");
    tabsMenu.className = "toc-tabs-menu";
    tabsMenu.hidden = true;
    tabsMenu.setAttribute("role", "menu");

    tabStrip.append(tabsList, tabsSelect, tabsMenu);
    if (hasPanelControls) { tabStrip.appendChild(controls); }

    const ALL_TABS: Array<[HTMLButtonElement, ReviewTab]> = [
        [tabContents, "contents"], [tabLinks, "links"], [tabNotes, "notes"], [tabProofread, "proofreading"],
    ];

    function closeTabsMenu(): void {
        // Hand focus back to the button that opened it, so closing never strands
        // the keyboard on the hidden menu.
        const hadFocus = tabsMenu.contains(document.activeElement);
        tabsMenu.hidden = true;
        tabsSelect.setAttribute("aria-expanded", "false");
        if (hadFocus) { tabsSelect.focus(); }
    }
    function openTabsMenu(): void {
        tabsMenu.replaceChildren(...ALL_TABS.filter(([btn]) => !btn.hidden).map(([btn, tab]) => {
            const item = document.createElement("button");
            item.className = "ui-menu-row toc-tabs-menu__item";
            item.textContent = btn.textContent;
            item.setAttribute("role", "menuitem");
            item.tabIndex = -1; // the menu's roving group hands out the tabbable slot
            item.classList.toggle("toc-tabs-menu__item--active", tab === activeTab);
            bindActivate(item, () => {
                closeTabsMenu();
                setActiveTab(tab);
            });
            return item;
        }));
        tabsMenu.hidden = false;
        tabsSelect.setAttribute("aria-expanded", "true");
        // Open ON the current tab, the menu-button convention — arrows then walk
        // from where you already are rather than from the top.
        tabsMenu.querySelector<HTMLElement>(".toc-tabs-menu__item--active")?.focus();
    }
    // The overflow menu's own vertical roving group: Up/Down walk the rows, Enter
    // activates (bindActivate handles the synthesized click), Escape closes and
    // hands focus back to the select button.
    wireRoving({
        container: tabsMenu,
        items: () => [...tabsMenu.querySelectorAll<HTMLElement>(".toc-tabs-menu__item")],
        onEscape: () => closeTabsMenu(),
    });
    bindActivate(tabsSelect, () => {
        if (tabsMenu.hidden) { openTabsMenu(); } else { closeTabsMenu(); }
    });
    // Any click elsewhere drops the menu (capture: stopped mousedowns count).
    document.addEventListener("mousedown", (e) => {
        if (!tabsMenu.hidden && !tabsMenu.contains(e.target as Node) && e.target !== tabsSelect) {
            closeTabsMenu();
        }
    }, true);

    /**
     * List mode vs select mode, decided by MEASURING: show the tab list and, if
     * its items wrapped past one row (the strip is too narrow for the visible
     * tabs + controls), collapse to the select. Runs on width/visibility/active
     * changes only — never per keystroke. jsdom (no layout) always measures
     * unwrapped, so unit tests exercise list mode.
     */
    function syncTabOverflow(): void {
        tabStrip.classList.remove("toc-tabs--select");
        closeTabsMenu();
        const visibleTabs = ALL_TABS.filter(([btn]) => !btn.hidden).map(([btn]) => btn);
        // One tab is not a choice, so it is not drawn as one: the row of tabs
        // appears with the second tab and goes with it. The one left is always
        // Contents (a review tab is only kept while it has entries or the
        // reader is in it), and an outline under no label reads as what it is.
        // The strip itself stays while it still holds the panel's controls,
        // and goes with the tabs where a surface has withdrawn those.
        const choice = visibleTabs.length > 1;
        tabsList.hidden = !choice;
        tabStrip.hidden = !choice && !hasPanelControls;
        const wrapped = visibleTabs.length > 1
            && visibleTabs.some((btn) => btn.offsetTop !== visibleTabs[0]!.offsetTop);
        if (wrapped) {
            tabStrip.classList.add("toc-tabs--select");
            const active = ALL_TABS.find(([, tab]) => tab === activeTab)?.[0];
            tabsSelectLabel.textContent = active?.textContent ?? "";
        }
        // Exactly one Tab stop for the strip in either mode: the select button
        // when it is the visible control, the active tab button otherwise.
        tabsSelect.tabIndex = wrapped ? 0 : -1;
    }

    const proofreadView = initProofreadingList(getEditorView);
    const notesView = initNotesList(getEditorView);
    const linksView = initLinksList(getEditorView);

    // The card is the surface; the panel is its box, and keeps a strip of
    // page along its sash edge so the resize line stands off the card's
    // rounded corner rather than lying on it. The file explorer is the same
    // arrangement (`.files-card`), and the flyout is neither: it is a card of
    // the shell's own, which is why `.toc-card` only dresses a docked drawer.
    const card = document.createElement("div");
    card.className = "toc-card";
    card.append(tabStrip, list, proofreadView.element, notesView.element, linksView.element);
    panel.appendChild(card);

    function makeTabButton(tab: ReviewTab, label: string): HTMLButtonElement {
        const btn = document.createElement("button");
        btn.className = "ui-btn toc-tab";
        btn.textContent = label;
        btn.setAttribute("role", "tab");
        btn.dataset["tab"] = tab;
        // Roving tabindex (updateTabButtons keeps exactly the active tab at 0).
        btn.tabIndex = -1;
        bindActivate(btn, () => {
            setActiveTab(tab);
        });
        return btn;
    }

    // Tablist keyboard nav: arrows move + activate (auto-activation), Home/End
    // jump to the ends, Enter/Space activate the focused tab. Hidden tabs (the
    // Proofreading tab when the master switch is off) are skipped.
    tabStrip.addEventListener("keydown", (e) => {
        // Escape from the strip returns to the editor — the region rule every
        // other wired region already follows; the strip was the one without it
        // (found while pinning the flyout's keyboard path). The OPEN overflow
        // menu is excluded: its own roving handles Escape (close + refocus the
        // select), and that bubbled event must not also yank focus away.
        if (e.key === "Escape" && e.target instanceof HTMLElement && !tabsMenu.contains(e.target)) {
            getEditorView()?.focus();
            return;
        }
        // ONLY the tab buttons. The strip also hosts the overflow select, its
        // menu, and the flip/hide controls — the select runs the menu-button
        // model instead, and this handler used to preventDefault its Enter and
        // switch to Contents, so opening the menu from the keyboard was
        // impossible (MAR-291).
        if (!(e.target instanceof HTMLElement) || !e.target.classList.contains("toc-tab")) { return; }
        const isArrow = e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End";
        const isActivate = e.key === "Enter" || e.key === " ";
        if (!isArrow && !isActivate) { return; }
        const tabs = [tabContents, tabLinks, tabNotes, tabProofread].filter((tab) => !tab.hidden);
        const cur = tabs.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();
        if (isActivate) {
            const btn = tabs[cur >= 0 ? cur : 0];
            if (btn) { setActiveTab(btn.dataset["tab"] as ReviewTab); }
            return;
        }
        const next = e.key === "Home" ? 0
            : e.key === "End" ? tabs.length - 1
            : ((cur < 0 ? 0 : cur + (e.key === "ArrowRight" ? 1 : -1)) + tabs.length) % tabs.length;
        const btn = tabs[Math.max(0, Math.min(tabs.length - 1, next))];
        if (btn) { setActiveTab(btn.dataset["tab"] as ReviewTab); btn.focus(); }
    });

    /** Reflect the active tab into the tab buttons and which view is shown. */
    function updateTabButtons(): void {
        const reflect = (btn: HTMLButtonElement, on: boolean): void => {
            btn.classList.toggle("toc-tab--active", on);
            btn.tabIndex = on ? 0 : -1; // roving: only the active tab is tabbable
            btn.setAttribute("aria-selected", String(on));
        };
        reflect(tabContents, activeTab === "contents");
        reflect(tabProofread, activeTab === "proofreading");
        reflect(tabNotes, activeTab === "notes");
        reflect(tabLinks, activeTab === "links");
        list.classList.toggle("toc-view--hidden", activeTab !== "contents");
        proofreadView.element.classList.toggle("toc-view--hidden", activeTab !== "proofreading");
        notesView.element.classList.toggle("toc-view--hidden", activeTab !== "notes");
        linksView.element.classList.toggle("toc-view--hidden", activeTab !== "links");
    }

    /** Render whichever tab is active — the only view that does any work. */
    function renderActiveView(headings?: HeadingEntry[]): void {
        // The panel is being shown/refreshed: settle any deferred tab-visibility
        // recompute (skipped while the panel was closed).
        if (tabVisibilityDirty) { scheduleTabVisibility(); }
        if (activeTab === "contents") {
            renderHeadings(headings ?? getHeadings());
        } else if (activeTab === "proofreading") {
            proofreadView.refresh(getEditorView());
        } else if (activeTab === "notes") {
            notesView.refresh(getEditorView());
        } else {
            linksView.refresh(getEditorView());
        }
    }

    /**
     * The flyout opens at the reader's place in the document, never at the
     * top: the list renders before the card's capped geometry exists, so the
     * active row can sit far below the fold. Runs once the shell has committed
     * the card's final layout (manual scroll math — scrollIntoView would also
     * scroll the window). Only the Contents tab tracks an active row; the
     * review tabs don't.
     */
    function centerActiveRowInFlyout(): void {
        const active = activeTab === "contents"
            ? list.querySelector<HTMLElement>(".toc-item--active")
            : null;
        if (active) {
            const listRect = list.getBoundingClientRect();
            const itemRect = active.getBoundingClientRect();
            list.scrollTop += itemRect.top - listRect.top - (list.clientHeight - itemRect.height) / 2;
        }
    }

    function setActiveTab(tab: ReviewTab): void {
        if (tab === activeTab) { return; }
        activeTab = tab;
        // Visibility depends on the active tab (an emptied tab is kept only
        // while the user is IN it) — recompute on switch-away.
        scheduleTabVisibility();
        updateTabButtons();
        syncTabOverflow(); // select-mode label follows the active tab
        if (shell.isVisible()) { renderActiveView(); }
    }

    /**
     * Move keyboard focus INTO the panel: the active view's first row, falling
     * back to the tab strip's own Tab stop when the view has no rows (an empty
     * state renders no focusable items). This is the inbound half of the
     * sidebar's keyboard model (MAR-294) — the outbound half already exists,
     * since Escape in every wired region returns focus to the editor.
     */
    function focusActiveRegion(): void {
        if (activeTab === "contents") { outlineRoving.focusFirst(); }
        else if (activeTab === "proofreading") { proofreadView.focusFirst(); }
        else if (activeTab === "notes") { notesView.focusFirst(); }
        else { linksView.focusFirst(); }
        if (panel.contains(document.activeElement)) { return; }
        // Empty view: land on the strip's Tab stop — the active tab button, or
        // the overflow select when the strip is collapsed. The one that is not
        // current is visibility:hidden, which refuses focus, so try in order
        // and keep whichever sticks.
        for (const el of tabStrip.querySelectorAll<HTMLElement>('[tabindex="0"]')) {
            el.focus();
            if (document.activeElement === el) { return; }
        }
    }

    /** The `Focus Review Sidebar` command (and any caller wanting the same
     *  gesture): reveal the panel if hidden — persisting the choice, exactly
     *  like the reveal tab — then move focus into it. */
    function focusPanel(): void {
        shell.hideFlyoutImmediate(); // focus wants the stable docked panel, not the transient flyout
        if (!shell.isOpen()) {
            applyVisiblePreference(true);
            notifyTocVisibility("shown");
        }
        focusActiveRegion();
    }

    /** Master proofreading switch: off hides the tab immediately (and falls back
     *  to Contents if it was active); on lets the visibility pass decide whether
     *  findings exist to show it for. */
    function applyProofreadingEnabled(enabled: boolean): void {
        proofreadingEnabled = enabled;
        if (!enabled) {
            tabProofread.hidden = true;
            if (activeTab === "proofreading") {
                setActiveTab("contents");
            }
        }
        scheduleTabVisibility();
    }

    // ── Tab visibility: a review tab exists only while it has entries ──────
    // The counts come from cached/incremental scans (links: doc-identity cache;
    // notes: the incremental scan cache; proofreading: an early-exit decoration
    // enumeration), and the pass runs ON IDLE, coalesced — never on the doc-open
    // or keystroke path. While the panel is closed the pass is skipped entirely
    // (dirty flag) and recomputed on the next show, so an unopened sidebar costs
    // nothing while typing.
    let tabVisibilityDirty = true;
    // Coalescing gate is a boolean set BEFORE requestIdle, not the returned
    // handle: a synchronous idle callback (tests; degenerate fallbacks) would
    // otherwise run before the handle assignment and leave a stale handle
    // wedging the scheduler shut. The handle exists only so dispose can cancel.
    let tabVisibilityScheduled = false;
    let tabVisibilityIdle: { cancel: () => void } | null = null;

    function scheduleTabVisibility(): void {
        tabVisibilityDirty = true;
        if (!shell.isVisible()) { return; }
        if (tabVisibilityScheduled) { return; }
        tabVisibilityScheduled = true;
        tabVisibilityIdle = requestIdle(() => {
            tabVisibilityScheduled = false;
            updateTabVisibility();
        }, 300);
    }

    function updateTabVisibility(): void {
        const view = getEditorView();
        if (!view) { return; } // stays dirty; recomputed once the editor exists
        tabVisibilityDirty = false;
        // Never yank the tab the user is IN — an emptied tab hides on switch-away.
        const show = (btn: HTMLButtonElement, tab: ReviewTab, has: boolean): void => {
            btn.hidden = !(has || activeTab === tab);
        };
        show(tabLinks, "links", linksView.count(view) > 0);
        show(tabNotes, "notes", notesView.count(view) > 0);
        show(tabProofread, "proofreading", proofreadingEnabled && hasProofreadFindings(view));
        if (!proofreadingEnabled) { tabProofread.hidden = true; }
        syncTabOverflow(); // the visible-tab set changed → remeasure the row
    }

    const flipTip = applyTooltip(flipBtn, "", { placement: "below" });
    function updateFlipTooltip(): void {
        flipTip.setText(shell.isRight() ? t("Move to left") : t("Move to right"));
    }
    updateFlipTooltip();

    /** The hide button carries the side-bar glyph whose filled edge marks the
     *  current dock side, the same one the shell draws on the reveal tab. */
    function updateHideButton(): void {
        hideBtn.innerHTML = shell.sideIcon();
    }
    updateHideButton();
    applyTooltip(hideBtn, t("Hide table of contents"), { placement: "below" });

    bindActivate(flipBtn, swapSide);

    bindActivate(hideBtn, () => {
        // Only visible while open, so this always collapses the panel.
        toggle();
    });

    let activeHeadingPos: number | null = null;
    let scrollRafId: number | null = null;

    // Drag-and-drop wiring: top-level items are drag handles, and the open
    // panel is a drop zone for document drags (see ./dnd). What a dragged
    // heading CARRIES is the destination's call — a section when it lands in
    // this panel, the heading line alone when it lands on the page. The flyout
    // counts as "open" here so internal reorder/refile behaves 1:1 with the
    // docked sidebar — otherwise the dnd measure/contains bail and the drag
    // falls through to the page (the shell's visibility is read lazily, at
    // drag time).
    const dnd = initTocDnd({
        panel,
        // Read at call time: under `tocToggleInBar` the trigger is the bar's
        // button, registered after this init (`setFlyoutTrigger`).
        flyoutTrigger: () => shell.flyoutTrigger(),
        list,
        getEditorView,
        isOpen: () => shell.isVisible(),
        getHeadings,
    });

    function setActiveHeadingPos(pos: number | null): void {
        activeHeadingPos = pos;
        let activeItem: HTMLElement | null = null;
        list.querySelectorAll<HTMLElement>(".toc-item").forEach((item) => {
            const isActive = pos !== null && item.dataset["headingPos"] === String(pos);
            item.classList.toggle("toc-item--active", isActive);
            if (isActive) {
                activeItem = item;
            }
        });
        // Mid-drag the list must never scroll under the pointer — the drag's
        // own edge auto-scroll is the only scroller then.
        if (activeItem && !document.body.classList.contains("block-dragging")) {
            (activeItem as HTMLElement).scrollIntoView({ block: "nearest" });
        }
    }

    /**
     * Re-commit the panel's whole presentation through the shell: open/docked
     * classes, the tab glyph, the outside-click listener, and (when visible)
     * the list. This is the RARE path — a toggle, a responsive flip, an edge
     * swap, or load — never a keystroke. `refreshContent` is the hot
     * counterpart.
     *
     * `headings` lets a caller that has already walked the doc hand its result
     * in; only a caller with nothing to reuse pays a walk here, and only when
     * the panel is actually visible.
     */
    function syncTocState(headings?: HeadingEntry[]): void {
        pendingHeadings = headings;
        try {
            shell.sync();
        } finally {
            pendingHeadings = undefined;
        }
    }

    // ── Extract all heading nodes from the ProseMirror document ────────
    // The doc the cached outline was computed from, and that outline. PM docs
    // are immutable persistent trees, so `outlineDoc === doc` is an O(1)
    // "unchanged" test, and diffing against the cached doc is a pointer walk
    // over shared structure — both orders cheaper than re-walking the blocks.
    let outlineDoc: PmNode | null = null;
    let outlineHeadings: HeadingEntry[] = [];

    /**
     * If every difference between prev and next lies inside ONE textblock that
     * is not a heading — the shape of ordinary typing — the outline's structure
     * and text provably did not change; only heading positions after the edit
     * shifted, all by the same amount. Returns that shift, or null when the
     * change could have touched the outline (then walk).
     *
     * The localization is the shared `singleTextblockInlineEdit` primitive (also
     * used by the Notes incremental scan); the heading REJECTION is this
     * consumer's own policy — a heading edit retitles/relevels the outline, so
     * only body-textblock typing can reuse the cache.
     */
    function inlineOnlyShift(prev: PmNode, next: PmNode): { endA: number; delta: number } | null {
        const edit = singleTextblockInlineEdit(prev, next);
        if (!edit) { return null; }
        if (edit.kind === "identical") {
            return { endA: 0, delta: 0 }; // value-identical (e.g. marks-only object churn)
        }
        if (edit.prevBlock.type.name === "heading" || edit.nextBlock.type.name === "heading") {
            return null;
        }
        return { endA: edit.endA, delta: edit.delta };
    }

    // Runs once per doc-changing FRAME (index.ts's rAF coalescer), so its cost
    // sits near the typing path. Two tiers keep it there:
    //  1. The observed-diff fast path above: ordinary body-text typing reuses
    //     the cached outline with positions shifted by the diff delta —
    //     O(headings), no doc walk at all (MAR-137's lane-1 mitigation; the
    //     walk was the biggest standalone longtask slice while typing at
    //     300 KB). Heading edits and structural changes fail the predicate and
    //     take the walk, so the outline is never stale.
    //  2. The walk itself scales with BLOCKS, not characters: returning false
    //     at every textblock prunes descent into inline content, because a
    //     heading's content is inline and can never hide inside another
    //     textblock.
    // refreshContent runs this AT MOST once per frame and skips it outright
    // when the panel is hidden and can't auto-open, and renderHeadings turns
    // the result into DOM work only when the outline's structure changed.
    function getHeadings(): HeadingEntry[] {
        const view = getEditorView();
        if (!view) {
            return [];
        }
        const doc = view.state.doc;
        if (outlineDoc === doc) {
            return outlineHeadings;
        }
        if (outlineDoc) {
            const shift = inlineOnlyShift(outlineDoc, doc);
            if (shift) {
                if (shift.delta !== 0) {
                    // New objects, not mutation: rendered rows and the drag
                    // model may still hold the previous entries.
                    outlineHeadings = outlineHeadings.map((h) =>
                        h.pos > shift.endA ? { ...h, pos: h.pos + shift.delta } : h,
                    );
                }
                outlineDoc = doc;
                return outlineHeadings;
            }
        }
        // The doc walk itself is shared with the section-link picker
        // (collectDocHeadings); only `atDocRoot` — which the TOC alone needs
        // for its drag/drop model — is derived here, on the slow path that
        // runs only when the outline's structure actually changed.
        const headings: HeadingEntry[] = collectDocHeadings(doc).map((h) => ({
            ...h,
            atDocRoot: doc.resolve(h.pos).depth === 0,
        }));
        outlineDoc = doc;
        outlineHeadings = headings;
        return headings;
    }

    function shouldAutoOpen(headings: HeadingEntry[]): boolean {
        return shell.mode() === "docked" && headings.length > tocAutoHideThreshold;
    }

    /**
     * Whether a doc change could still open the panel on its own — i.e. whether
     * `shouldAutoOpen`'s answer depends on the outline at all. It is exactly
     * that predicate's heading-INDEPENDENT half, so the two must move together.
     *
     * This is what lets a hidden panel skip the walk: once the user has taken
     * the decision (`userToggled`), or the panel is in overlay mode (where
     * auto-open never fires), the heading count cannot change anything, and
     * counting it is work with no possible effect.
     */
    function autoOpenPossible(): boolean {
        return !userToggled && shell.mode() === "docked";
    }

    function syncAutoOpenState(headings: HeadingEntry[]): void {
        if (!userToggled) {
            shell.setOpen(shouldAutoOpen(headings));
        }
    }

    // The outline STRUCTURE the rendered list currently shows. renderHeadings
    // runs on every doc-changing frame, so this decides whether that frame
    // pays a DOM rebuild. null = "nothing rendered yet / force the next
    // render".
    let renderedSignature: string | null = null;

    // Collapsed outline sections, keyed by level+text so the fold PERSISTS across
    // the structural rebuilds renderHeadings does (adding a heading elsewhere no
    // longer springs every section open). Session-only, like the group collapse.
    // Two headings with the same level+text fold together — a rare, acceptable
    // collision. Keyed with a NUL separator (via fromCharCode, never a literal).
    const collapsedHeadings = new Set<string>();
    const HEADING_KEY_SEP = String.fromCharCode(0);
    const headingKey = (level: number, text: string): string => `${level}${HEADING_KEY_SEP}${text}`;

    /**
     * What a rendered row's STRUCTURE is: rank (indent + class), top-level-ness
     * (whether the row is a drag handle at all), and text (label + tooltip).
     * A change to any of these can only reach the DOM by rebuilding the rows.
     *
     * `pos` is deliberately NOT here, though every row carries one (its nav
     * target and drag anchor). Positions shift on almost every keystroke —
     * typing anywhere above a heading renumbers every heading after it — so
     * folding pos into this signature rebuilt the ENTIRE list on almost every
     * keystroke: an innerHTML wipe, then per row an element, a tooltip, a drag
     * wiring and three listeners. Measured in the real bundle (140 headings, 20
     * keystrokes typed into the first paragraph): 2800 rows torn out and
     * rebuilt — every row, every keystroke — versus 0 now. It also made the
     * price depend on where the caret sat: typing below the last heading shifts
     * no pos and cost nothing, typing at the top cost everything.
     *
     * Positions instead sync in place onto the surviving rows (syncItemPositions),
     * which is why a row's pos is read from its `dataset.headingPos` at event
     * time and never captured in a handler's closure.
     */
    // Control characters as delimiters: heading text is arbitrary user input,
    // but a ProseMirror text node can never hold a control char, so NUL
    // between fields and SOH between entries keep the encoding injective. A
    // space-delimited signature would not: a heading titled "x3 4 y" would
    // serialize identically to the two-heading outline [h1@2 "x", h3@4 "y"],
    // and a collision silently SKIPS the rebuild — stranding exactly the
    // stale outline this short-circuit sits in front of.
    //
    // Spelled as escapes, never as literal bytes: a raw control character
    // makes the whole file read as BINARY to grep/ripgrep (searches for any
    // symbol in it silently return nothing), and every editor and code
    // review renders it as an innocent space. An invisible byte is the last
    // thing that should carry a correctness argument.
    const SIG_FIELD = "\u0000";
    const SIG_ENTRY = "\u0001";

    function outlineSignature(headings: HeadingEntry[]): string {
        return headings
            .map((h) => [h.level, h.atDocRoot ? 1 : 0, h.text].join(SIG_FIELD))
            .join(SIG_ENTRY);
    }

    // INVARIANT: any code path that mutates `list`'s children must end by
    // calling dnd.notifyRerender() — the drop model snapshots item geometry
    // per drag session, and a rebuild it never hears about leaves the
    // measured slots aimed at detached elements (drops silently misaim) —
    // and must re-apply the drag-source state via dnd.dragSourceHeadingPos()
    // so a mid-drag rebuild keeps the source ghosted and click-suppressed.
    /**
     * Carry shifted document positions onto the rows already on screen — the
     * common case, since an edit above a heading moves every later heading
     * without changing a thing the outline DISPLAYS.
     *
     * Touches no structure: no element is created, moved, or removed, so the
     * drag session's measured geometry stays valid and this must NOT call
     * notifyRerender (nothing went stale). Row order is the outline's order by
     * construction — the signature that got us here pins both the count and
     * every row's identity — so index alignment is exact.
     */
    function syncItemPositions(headings: HeadingEntry[]): void {
        const items = list.querySelectorAll<HTMLElement>(".toc-item");
        if (items.length !== headings.length) {
            return; // structure drift the signature should have caught — never rewrite blind
        }
        headings.forEach((entry, i) => {
            const item = items[i]!;
            item.dataset["headingPos"] = String(entry.pos);
            item.classList.toggle("toc-item--active", activeHeadingPos === entry.pos);
        });
    }

    function renderHeadings(headings: HeadingEntry[]): void {
        const signature = outlineSignature(headings);
        if (signature === renderedSignature) {
            // Identical structure ⇒ identical DOM, but the same edit that left
            // the outline looking unchanged has usually MOVED it: refresh the
            // rows' anchors in place rather than rebuilding to carry a number.
            syncItemPositions(headings);
            return;
        }
        renderedSignature = signature;
        list.innerHTML = "";
        if (headings.length === 0) {
            // Nothing, rather than a line saying there is nothing. An outline
            // with no rows already says the document has no headings, and the
            // sentence was the one thing in the panel that was not the
            // document's.
            dnd.notifyRerender();
            return;
        }
        headings.forEach((entry, i) => {
            // `entry.pos` is this row's anchor AS OF NOW — correct to seed the
            // DOM with, but never to capture: see the signature note above.
            const { level, text } = entry;
            const item = document.createElement("div");
            item.className = `ui-label toc-item toc-item--h${level}`;
            item.setAttribute("role", "treeitem");
            item.dataset["headingPos"] = String(entry.pos);
            item.dataset["level"] = String(level);
            item.style.paddingLeft = `${(level - 1) * 12 + 8}px`;
            // A row is a "parent" (foldable) when the next heading nests under it.
            const hasChildren = i + 1 < headings.length && headings[i + 1]!.level > level;
            item.classList.toggle("toc-item--parent", hasChildren);
            // Collapse state is keyed by level+text (see collapsedHeadings), so it
            // survives the structural rebuild this loop runs — reapply it here. The
            // key rides the dataset so setRowCollapsed (caret + keyboard) can read it.
            const key = headingKey(level, text);
            item.dataset["headingKey"] = key;
            item.classList.toggle("toc-item--collapsed", collapsedHeadings.has(key));
            if (hasChildren) { item.setAttribute("aria-expanded", String(!collapsedHeadings.has(key))); }

            // A disclosure caret in the left gutter (shown on hover for parents,
            // and while collapsed) + the heading text.
            const caret = document.createElement("span");
            caret.className = "toc-caret";
            const label = document.createElement("span");
            label.className = "toc-item__text";
            label.textContent = text || `${t("Heading")} ${level}`;
            item.append(caret, label);

            // The caret folds the section in the OUTLINE only (never the document);
            // it must not navigate or start a drag.
            caret.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
            caret.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                setRowCollapsed(item, !item.classList.contains("toc-item--collapsed"));
            });

            item.classList.toggle("toc-item--active", activeHeadingPos === entry.pos);
            applyTooltip(label, text, {
                placement: "above",
                truncatedOnly: true,
            });
            dnd.wireItemDrag(item, entry);
            // A mid-drag rebuild replaces the drag-source item: restore its
            // ghosted state (and the click-suppression flag) on the new one.
            if (dnd.dragSourceHeadingPos() === entry.pos) {
                item.classList.add("toc-item--drag-source");
                item.dataset["dragged"] = "1";
            }
            item.addEventListener("mousedown", (e) => {
                // Keep focus in the editor (and let a wired drag arm itself);
                // navigation happens on click, so a drag never also jumps.
                e.preventDefault();
                e.stopPropagation();
            });
            item.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                // The trailing click of a drag that started on this item is
                // suppressed (dnd.ts clears the flag a tick after release).
                if (item.dataset["dragged"]) {
                    return;
                }
                const view = getEditorView();
                if (!view) {
                    return;
                }
                // Read the anchor from the DOM, never from `entry`: this row
                // outlives the outline snapshot that built it (syncItemPositions
                // re-anchors it in place), so a captured pos would navigate to
                // wherever this heading USED to be.
                const pos = Number(item.dataset["headingPos"]);
                try {
                    // A heading hidden inside a collapsed ancestor fold is
                    // an explicit entry intent: unfold everything containing
                    // it first (the outline deliberately keeps collapsed
                    // headings), then reveal.
                    revealPosition(view, pos);
                    const { node } = view.domAtPos(pos + 1);
                    let el: HTMLElement | null =
                        node.nodeType === Node.TEXT_NODE
                            ? node.parentElement
                            : (node as HTMLElement);
                    while (el && !el.matches(HEADING_SELECTOR)) {
                        el = el.parentElement;
                    }
                    if (el) {
                        // Update the TOC active state immediately
                        setActiveHeadingPos(pos);
                        scrollElementBelowTopbar(el);
                    }
                } catch {
                    /* ignore when the document structure is unexpected */
                }
            });
            list.appendChild(item);
        });
        setActiveHeadingPos(activeHeadingPos);
        applyOutlineCollapse();
        outlineRoving.refresh();
        dnd.notifyRerender();
    }

    /**
     * Apply the outline accordion: hide every row nested under a collapsed
     * heading. Collapse state persists across rebuilds via collapsedHeadings
     * (reapplied as the `toc-item--collapsed` class per row), and survives the
     * position-sync that runs while typing. Visibility is derived purely from row
     * order + level, so nested collapses just work — a row inside an
     * already-collapsed region stays hidden whatever its own state.
     */
    function applyOutlineCollapse(): void {
        let collapseLevel: number | null = null;
        list.querySelectorAll<HTMLElement>(".toc-item").forEach((row) => {
            const level = Number(row.dataset["level"]);
            if (collapseLevel !== null && level > collapseLevel) {
                row.hidden = true;
                return;
            }
            row.hidden = false;
            collapseLevel = row.classList.contains("toc-item--collapsed") ? level : null;
        });
    }

    /** Fold/unfold one outline heading — the caret click and the keyboard both
     *  go through here so the persistent set, the class, the aria state, the
     *  hidden descendants, and the roving item list all stay in step. */
    function setRowCollapsed(item: HTMLElement, collapsed: boolean): void {
        const key = item.dataset["headingKey"] ?? "";
        if (collapsed) { collapsedHeadings.add(key); } else { collapsedHeadings.delete(key); }
        item.classList.toggle("toc-item--collapsed", collapsed);
        if (item.classList.contains("toc-item--parent")) {
            item.setAttribute("aria-expanded", String(!collapsed));
        }
        applyOutlineCollapse();
        outlineRoving.refresh();
    }

    /**
     * Full re-sync: presentation AND content. Load-time and any caller that
     * knows the panel's own state may have changed. One doc walk, shared.
     */
    function refresh(): void {
        const headings = getHeadings();
        syncAutoOpenState(headings);
        syncTocState(headings);
        // One of the two load-reveal commits (see initialLoad). Transitions
        // stay off until the init rAF has committed too — in either order.
        if (initialLoad && getEditorView()) {
            mountedRefreshCommitted = true;
            endInitialLoadIfSettled();
        }
    }

    /**
     * THE HOT PATH: one doc-changing frame (index.ts's rAF coalescer), so it
     * sits next to the typing path and may cost only what a doc change can
     * actually change — the outline. Everything the shell's sync commits is
     * invariant under a doc edit, and re-committing it per frame was pure
     * waste: an SVG re-parse for the tab, seven classList toggles, and a
     * listener remove/add + setTimeout, on every keystroke, panel open or
     * collapsed alike.
     *
     * What remains: at most ONE getHeadings() walk, shared by the auto-open
     * decision and the render, and `renderHeadings`' signature check drops the
     * DOM rebuild for the great majority of edits (body text leaves the
     * outline identical). Ordinary typing then genuinely costs just the walk.
     *
     * The bail is narrow on purpose. An invisible panel renders nothing, but
     * auto-open is a pure function of the heading COUNT — a docked panel whose
     * document grows past the threshold must still open itself — so a hidden
     * panel may only skip the walk once that decision can no longer swing
     * (autoOpenPossible). When the walk does flip visibility, that IS a state
     * change, and it takes the full sync.
     */
    function refreshContent(): void {
        // The doc changed: mark tab visibility stale. Costs a flag write when the
        // panel is closed; schedules one coalesced idle recompute when open.
        scheduleTabVisibility();
        if (!shell.isVisible() && !autoOpenPossible()) {
            return; // nothing to render, and nothing left to auto-decide
        }
        const headings = getHeadings();
        const wasVisible = shell.isVisible();
        syncAutoOpenState(headings);
        if (shell.isVisible() !== wasVisible) {
            syncTocState(headings); // auto-open flipped: presentation changed too
            return;
        }
        if (!shell.isVisible()) {
            return;
        }
        // The Proofreading tab is DECORATION-driven, not doc-driven: on a
        // keystroke its findings only remap (positions shift; text/tags are
        // unchanged), and the real changes — async Harper/style results,
        // ignore/learn — arrive on the proofread-findings-changed event, which
        // refreshes it. Re-reading the findings here would cost O(findings) —
        // which grows with the document (a longer doc has more findings) —
        // every frame, only to re-sync anchors the signature diff then confirms
        // unchanged. So a doc-change frame renders only the doc-driven views;
        // Contents and Notes genuinely change per keystroke and still refresh.
        if (activeTab === "proofreading") {
            return;
        }
        renderActiveView(headings);
    }

    /** Apply an explicit show/hide preference — from a local toggle or a
     *  cross-tab broadcast. Seeds the persistent decision (so it overrides
     *  auto-open) and re-syncs the panel. Does NOT persist or notify: the caller
     *  decides (a local toggle persists; a received broadcast must not echo). */
    function applyVisiblePreference(visible: boolean): void {
        userToggled = true;
        // dockedUserCollapsed is the inverse of "visible" when docked, and keeps
        // the overlay↔docked transitions honoring the last explicit choice.
        dockedUserCollapsed = !visible;
        shell.setOpen(visible);
        syncTocState();
    }

    function toggle(): void {
        // Drop any preview first. A flown-out panel carries its own classes and
        // its own inline position, and docking it open on top of that leaves a
        // panel that is `toc-open` and still drawn as a floating card halfway
        // down the window.
        //
        // Here rather than at the gesture, and that is the whole fix: the reveal
        // tab's own click path did this, so while the tab was the only trigger
        // the bug did not exist. Give the preview to a button that runs the
        // COMMAND instead (`tocToggleInBar`) and every other route to the same
        // command — the palette, a chord, the slash row — arrives without it.
        shell.hideFlyoutImmediate();
        const next = !shell.isOpen();
        applyVisiblePreference(next);
        // Report the explicit choice; the extension writes birta.tocVisibility and
        // echoes it to every open editor. A toggle only ever picks shown/hidden.
        notifyTocVisibility(next ? "shown" : "hidden");
    }

    /** External show/hide update (birta.tocVisibility changed — a toggle in this
     *  or another editor, or a settings.json edit). Applies without re-persisting.
     *  "auto" returns to the heading-count heuristic. */
    function applyVisibility(visibility: TocVisibility): void {
        if (visibility === "auto") {
            userToggled = false;
            shell.setOpen(shouldAutoOpen(getHeadings()));
            syncTocState();
            return;
        }
        const visible = visibility === "shown";
        if (shell.isOpen() === visible && userToggled) {
            return; // already in the requested state — nothing to do
        }
        shell.hideFlyoutImmediate(); // a live dock change shouldn't leave a flyout up
        applyVisiblePreference(visible);
    }

    // ── Flip the panel to the opposite edge (header button + setting echo) ──
    /** Move the panel to the other edge and persist the choice. THE one
     *  implementation: the panel's flip button and the `swapTocSide` command
     *  both call this, so the two cannot drift and the button is the command
     *  rather than a copy of it. */
    function swapSide(): void {
        const next: "left" | "right" = shell.isRight() ? "left" : "right";
        // Apply optimistically for instant feedback; the setting echo re-applies
        // the same value (idempotent) once persisted.
        setPosition(next);
        notifySetTocPosition(next);
    }

    function setPosition(position: "left" | "right"): void {
        const nextRight = position === "right";
        if (nextRight === shell.isRight()) {
            return;
        }
        // The shell moves the drawer and the tab, re-evaluates docked/overlay
        // and re-commits; the panel's own controls follow the new side.
        shell.setSide(nextRight);
        updateFlipTooltip();
        updateHideButton();
    }

    // ── TOC's own scroll detection: update the active state of the currently visible heading ──────
    function updateActiveHeadingOnScroll(): void {
        scrollRafId = null;
        const view = getEditorView();
        if (!view) {
            return;
        }

        const top = getTopbarBottom();
        // Offset the detection point 50px down, to avoid mis-detecting the previous heading before the scroll finishes
        const threshold = top + 50;
        // The TOC does not exclude collapsed/hidden headings
        const result = findActiveHeading(view, threshold, false);
        const pos = result?.pos ?? null;
        // Most scroll frames land under the same heading as the one before, and
        // re-applying it walked every row in the list and re-ran scrollIntoView
        // on the active one, per frame (MAR-316). Only the scroll path may skip
        // this: the other callers re-apply an UNCHANGED pos on purpose, to
        // restore the highlight onto rows the list has just rebuilt.
        if (pos !== activeHeadingPos) {
            setActiveHeadingPos(pos);
        }
    }

    function scheduleScrollUpdate(): void {
        if (scrollRafId !== null) {
            return;
        }
        scrollRafId = requestAnimationFrame(updateActiveHeadingOnScroll);
    }

    // Show only the initial (Contents) view; the review tabs stay hidden until
    // picked, so they scan/enumerate nothing until then.
    updateTabButtons();
    applyProofreadingEnabled(proofreadingEnabled);

    // The Proofreading tab mirrors the decoration set, and is refreshed SOLELY
    // by this event — it deliberately does NOT ride the per-frame doc-change
    // path (refreshContent skips it), because on a keystroke the findings only
    // remap and re-reading them is O(findings), which grows with the document.
    // The event fires when the findings actually change (async Harper/style
    // results, ignore/learn), and only while it's the shown tab, so a hidden tab
    // costs nothing and typing costs nothing here. (Switching TO the tab renders
    // it once via renderActiveView.)
    // Bare window binding (the event isn't in WindowEventMap, so it can't route
    // through eventManager.onWindow) — captured here so dispose() can remove it.
    const onProofreadFindingsChanged = (): void => {
        // Findings appearing/clearing is what shows/hides the Proofreading tab.
        scheduleTabVisibility();
        if (shell.isVisible() && activeTab === "proofreading") {
            proofreadView.refresh(getEditorView());
        }
    };
    window.addEventListener(PROOFREAD_FINDINGS_CHANGED, onProofreadFindingsChanged);

    // The master proofreading switch (birta.proofreading.enabled) governs whether
    // the Proofreading TAB exists at all — hidden when off. proofread-config-changed
    // fires on any config change (a toolbar toggle, or a settings echo).
    const onProofreadConfigChanged = (e: Event): void => {
        const cfg = (e as CustomEvent).detail as { proofreadingEnabled?: boolean } | undefined;
        applyProofreadingEnabled(cfg?.proofreadingEnabled ?? true);
    };
    window.addEventListener("proofread-config-changed", onProofreadConfigChanged);

    requestAnimationFrame(() => {
        const mode = shell.settleMode();
        const headings = getHeadings();
        shell.setOpen(userToggled ? mode === "docked" && !dockedUserCollapsed : shouldAutoOpen(headings));
        shell.updatePosition();
        syncTocState();
        syncTabOverflow();
        // The other half of the load reveal (see initialLoad) — transitions
        // stay off until the first mounted refresh has committed too.
        initRafCommitted = true;
        endInitialLoadIfSettled();
        // Detect the currently visible heading once on init
        updateActiveHeadingOnScroll();
        // First tab-visibility pass: on idle if the panel is showing, deferred
        // to first show otherwise — either way, off the open path.
        scheduleTabVisibility();
    });

    // Listen for scroll events to update the TOC active state independently
    // (the shell owns the resize listener).
    eventManager.onWindow("scroll", scheduleScrollUpdate, { passive: true });

    return {
        panel,
        toggle,
        refresh,
        refreshContent,
        setPosition,
        swapSide,
        applyVisibility,
        // A one-shot width change (settings edit echoed here) must also
        // re-evaluate docked↔overlay, which a new width can flip — the drag path
        // does this on mouseup, but per-move `setWidth` deliberately doesn't.
        setWidth: (width: number) => { shell.setWidth(width); shell.checkResponsiveMode(); },
        isOpen: () => shell.isOpen(),
        isRight: () => shell.isRight(),
        dockedReserve: shell.dockedReserve,
        checkResponsiveMode: shell.checkResponsiveMode,
        setNotesMarkers: (markers: string[]) => {
            notesView.setMarkers(markers);
            scheduleTabVisibility(); // a new marker set can create/clear notes
            if (shell.isVisible() && activeTab === "notes") {
                notesView.refresh(getEditorView());
            }
        },
        setReviewGroupByType: (grouped: boolean) => {
            // Settings echo: all review tabs share the one setting.
            proofreadView.setGroupByType(grouped);
            notesView.setGroupByType(grouped);
            linksView.setGroupByType(grouped);
        },
        showProofreadingTab: () => {
            // The toolbar menu item only appears while proofreading is on, but
            // guard anyway (the tab is hidden when off).
            if (!proofreadingEnabled) { return; }
            // Explicit intent overrides has-entries visibility: show the tab even
            // before findings arrive (it renders its own empty state).
            tabProofread.hidden = false;
            shell.hideFlyoutImmediate();
            setActiveTab("proofreading");
            if (!shell.isOpen()) {
                applyVisiblePreference(true); // open + remember the intent
                notifyTocVisibility("shown");
            }
            // "Show issues" means "take me to the issues": moving focus into
            // the freshly shown list makes the action keyboard-complete
            // (MAR-294) — Escape hands focus straight back to the editor.
            focusActiveRegion();
        },
        focusPanel,
        setFlyoutTrigger: (el: HTMLElement) => {
            // Only where the surface withdrew the reveal tab: the shell refuses
            // it anywhere else, since the caller knows which button it has, not
            // which triggers are already live.
            shell.setFlyoutTrigger(el);
        },
        dispose: () => {
            window.removeEventListener(PROOFREAD_FINDINGS_CHANGED, onProofreadFindingsChanged);
            window.removeEventListener("proofread-config-changed", onProofreadConfigChanged);
            tabVisibilityIdle?.cancel();
            tabVisibilityIdle = null;
            dnd.dispose();
            shell.dispose();
        },
    };
}
