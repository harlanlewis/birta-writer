import './toc.css';
import type { EditorView, Node as PmNode } from "@/pm";
import { applyTooltip, hideTooltip } from "@/ui/tooltip";
import { t } from "@/i18n";
import { notifyTocWidth, notifySetTocPosition } from "@/messaging";
import { revealPosition } from "@/editing/blockOps";
import { IconPanelLeft, IconPanelRight, IconArrowLeftRight } from "@/ui/icons";
import type { EventManager } from "@/eventManager";
import { onOutsideClick } from "@/ui/outsideClick";
import {
    getTopbarBottom,
    scrollElementBelowTopbar,
    getAllHeadings,
    findHeadingPos,
    findActiveHeading,
} from "@/utils/headingUtils";
import { initTocDnd } from "./dnd";

interface HeadingEntry {
    level: number;
    text: string;
    pos: number;
    /** At the document root (`resolve(pos).depth === 0`) — the only rows that
     *  drag/drop. Depth, NOT rank: in a flat document that is every heading,
     *  H6 included. See TocHeadingEntry in ./dropModel. */
    atDocRoot: boolean;
}

const TOC_DEFAULT_WIDTH = 220;
const TOC_MIN_WIDTH = 150;
const TOC_MAX_WIDTH = 600;
const DOCKED_MIN_CONTENT_WIDTH = 720;
const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";
// The closed reveal tab must sit exactly over the open hide button so the glyph
// doesn't shift on toggle. The floating controls are inset from the drawer's top
// trailing corner by these amounts (see `.toc-controls` top/right in toc.css);
// the reveal tab and control buttons share the same box (22px) and glyph (15px),
// so matching these insets keeps the glyph perceptually stable across the toggle.
const TAB_EDGE_INSET = 7;
// Nudged down a touch from a pure top inset so the glyph optically centers on the
// first heading row's text (lowercase-dominant, so its optical center sits low).
const TAB_TOP_INSET = 7;
const tocAutoHideThreshold = window.__i18n?.tocAutoHideThreshold ?? 3;
type TocMode = "docked" | "overlay";

export function initToc(eventManager: EventManager, getEditorView: () => EditorView | null): {
    panel: HTMLElement;
    toggle: () => void;
    /** Full re-sync (presentation + content) — load time, and any caller whose
     *  own state may have changed. Not for doc changes: see refreshContent. */
    refresh: () => void;
    /** THE HOT PATH: the outline tracks a changed document. Costs at most one
     *  heading walk, and touches the DOM only when the outline really moved. */
    refreshContent: () => void;
    setPosition: (position: "left" | "right") => void;
    /** Current open/docked-side state — drives the slash menu's dynamic toggle labels. */
    isOpen: () => boolean;
    isRight: () => boolean;
    /** Unregister the panel's drop-zone provider (teardown/tests). */
    dispose: () => void;
} {
    // Initial side comes from the birta.tocPosition setting via a
    // server-rendered body class; the header flip button mutates it live.
    let tocRight = document.body.classList.contains("toc-right");

    const panel = document.createElement("div");
    panel.className = "toc-panel";
    panel.classList.toggle("toc-panel--right", tocRight);

    // Controls float in the drawer's top trailing corner, layered above the list
    // which scrolls underneath them. No header row/title — the panel blends with
    // the editor background, so the drawer reads as an unadorned overlay. They are
    // only visible while the panel is open, which is exactly when a side-switch or
    // hide action makes sense.
    const controls = document.createElement("div");
    controls.className = "toc-controls";

    // Side-switch: moves the panel to the opposite edge. Two-way arrows read as
    // "swap sides"; the tooltip names the destination.
    const flipBtn = document.createElement("button");
    flipBtn.className = "toc-control-btn toc-flip-btn";
    flipBtn.tabIndex = -1;
    flipBtn.innerHTML = IconArrowLeftRight;
    controls.appendChild(flipBtn);

    // Hide button: collapses the panel. Carries the VS Code side-bar glyph (the
    // filled edge marks the docked side) — the same icon the reveal tab uses, so
    // the two read as one persistent control as the panel slides away.
    const hideBtn = document.createElement("button");
    hideBtn.className = "toc-control-btn toc-hide-btn";
    hideBtn.tabIndex = -1;
    controls.appendChild(hideBtn);

    const list = document.createElement("div");
    list.className = "toc-list";

    panel.appendChild(controls);
    panel.appendChild(list);

    /** The side-bar glyph whose filled edge marks the current dock side. */
    function sidebarIcon(): string {
        return tocRight ? IconPanelRight : IconPanelLeft;
    }

    const flipTip = applyTooltip(flipBtn, "", { placement: "below" });
    function updateFlipTooltip(): void {
        flipTip.setText(tocRight ? t("Move to left") : t("Move to right"));
    }
    updateFlipTooltip();

    function updateHideButton(): void {
        hideBtn.innerHTML = sidebarIcon();
    }
    updateHideButton();
    applyTooltip(hideBtn, t("Hide table of contents"), { placement: "below" });

    flipBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next: "left" | "right" = tocRight ? "left" : "right";
        // Apply optimistically for instant feedback; the setting echo re-applies
        // the same value (idempotent) once persisted.
        setPosition(next);
        notifySetTocPosition(next);
    });

    hideBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Only visible while open, so this always collapses the panel.
        toggle();
    });

    // ── Drag-to-resize handle on the panel's inner edge (VS Code sash style) ──
    const resizeCursor = (window.__i18n?.isMac ?? false) ? "col-resize" : "ew-resize";
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "toc-resize-handle";
    resizeHandle.style.cursor = resizeCursor;
    panel.appendChild(resizeHandle);

    function clampWidth(width: number): number {
        return Math.min(TOC_MAX_WIDTH, Math.max(TOC_MIN_WIDTH, Math.round(width)));
    }

    function readInitialWidth(): number {
        // Injected by the extension as --toc-width on :root (persisted value or the 220px default)
        const raw = getComputedStyle(document.documentElement).getPropertyValue("--toc-width");
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) ? clampWidth(parsed) : TOC_DEFAULT_WIDTH;
    }

    let tocWidth = readInitialWidth();

    function setTocWidth(width: number): void {
        tocWidth = clampWidth(width);
        document.documentElement.style.setProperty("--toc-width", `${tocWidth}px`);
        updateTab();
    }

    resizeHandle.addEventListener("mousedown", (e) => {
        if (e.button !== 0) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startWidth = tocWidth;
        resizeHandle.classList.add("toc-resize-handle--active");
        document.body.classList.add("toc-resizing");
        document.body.style.cursor = resizeCursor;
        const onMove = (ev: MouseEvent): void => {
            const delta = tocRight ? startX - ev.clientX : ev.clientX - startX;
            setTocWidth(startWidth + delta);
        };
        const onUp = (): void => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            resizeHandle.classList.remove("toc-resize-handle--active");
            document.body.classList.remove("toc-resizing");
            document.body.style.cursor = "";
            if (tocWidth !== startWidth) {
                notifyTocWidth(tocWidth);
            }
            checkResponsiveMode();
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });

    // Double-click resets to the default width
    resizeHandle.addEventListener("dblclick", () => {
        // Suppress the tab's slide transition so it snaps with the panel; the forced
        // style flush commits the new position while the suppression is still active
        document.body.classList.add("toc-resizing");
        setTocWidth(TOC_DEFAULT_WIDTH);
        void tabEl.offsetWidth;
        document.body.classList.remove("toc-resizing");
        notifyTocWidth(TOC_DEFAULT_WIDTH);
        checkResponsiveMode();
    });

    // ── Reveal tab: a standalone fixed button at the docked outer corner, shown
    // only while the panel is closed. It carries the same side-bar glyph as the
    // header's hide button and sits at the same corner, so hiding the panel
    // reads as the control staying put while the panel slides away behind it.
    const tabEl = document.createElement("button");
    tabEl.className = "toc-toggle-tab";
    // Keyboard-reachable: Tab focuses it (flying the panel out as a preview via
    // the focus listener below), Enter/Space docks it open. Without tabIndex 0 —
    // and because the mousedown handler preventDefaults click-focus — the focus
    // path would be dead and the flyout pointer-only.
    tabEl.tabIndex = 0;
    document.body.appendChild(tabEl);
    applyTooltip(tabEl, t("Show table of contents"), { placement: "below" });

    let tocMode: TocMode = "overlay";
    let isOpen = false;
    let dockedUserCollapsed = false;
    let userToggled = false;
    let activeHeadingPos: number | null = null;
    let scrollRafId: number | null = null;
    // The initial auto-open on load should snap into place, not slide/fade in —
    // the switch into the rendered editor shouldn't draw attention to itself.
    // While this is true, syncTocState() commits state with transitions off; it
    // is cleared once the first content-driven refresh (with the editor mounted)
    // has run, so every later user toggle / resize animates normally. Note the
    // panel is first opened by refresh() *after* the editor mounts, not by the
    // init rAF below (which runs before getEditorView() exists), so the guard
    // has to live in syncTocState rather than around any single caller.
    let initialLoad = true;

    // Drag-and-drop wiring: top-level items drag their whole sections, and
    // the open panel is a drop zone for document drags (see ./dnd). The flyout
    // counts as "open" here so internal reorder/refile behaves 1:1 with the
    // docked sidebar — otherwise the dnd measure/contains bail and the drag
    // falls through to the page (`flyoutOpen` is read lazily, at drag time).
    const dnd = initTocDnd({
        panel,
        list,
        getEditorView,
        isOpen: () => isOpen || flyoutOpen,
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

    function updateTab(): void {
        // Pinned to the docked outer edge, carrying the dock-side glyph. CSS
        // hides it while the panel is open (the header's hide button rules then).
        tabEl.innerHTML = sidebarIcon();
        if (tocRight) {
            tabEl.style.left = "auto";
            tabEl.style.right = `${TAB_EDGE_INSET}px`;
        } else {
            tabEl.style.right = "auto";
            tabEl.style.left = `${TAB_EDGE_INSET}px`;
        }
    }

    function updateBodyClasses(): void {
        document.body.classList.toggle("toc-docked", tocMode === "docked");
        document.body.classList.toggle("toc-overlay", tocMode === "overlay");
        document.body.classList.toggle("toc-open", isOpen && tocMode === "docked");
        document.body.classList.toggle("toc-overlay-open", isOpen && tocMode === "overlay");
    }

    /** Outside-click detach handle (null while the overlay dismissal is off). */
    let outsideOff: (() => void) | null = null;

    function syncOutsideClickHandler(): void {
        outsideOff?.();
        outsideOff = null;
        if (isOpen && tocMode === "overlay") {
            // Deferred one tick so the opening click can't instantly close the
            // overlay; the state is re-checked (and any listener a racing sync
            // already attached is detached first) when the timeout fires.
            setTimeout(() => {
                if (isOpen && tocMode === "overlay") {
                    outsideOff?.();
                    // Bubble phase (`capture: false`), matching the
                    // hand-rolled original.
                    outsideOff = onOutsideClick([panel], (e) => {
                        // A gutter-handle drag must be able to travel into an
                        // overlay TOC: the grab's mousedown lands outside the
                        // panel but must not close it.
                        if (e.target instanceof Element && e.target.closest(".heading-fold-marker")) {
                            return;
                        }
                        close();
                    }, { capture: false });
                }
            }, 0);
        }
    }

    /** Whether the panel is on screen in ANY form — docked/overlay open, or
     *  transiently flown out from the collapsed tab. The render/measure gate:
     *  a visible outline must track the document regardless of which of the
     *  two states is showing it. (`flyoutOpen` is declared below and read
     *  lazily — every caller runs after module init.) */
    function isPanelVisible(): boolean {
        return isOpen || flyoutOpen;
    }

    /**
     * Re-commit the panel's whole presentation: open/docked classes, the tab
     * glyph, the outside-click listener, and (when visible) the list. This is
     * the RARE path — a toggle, a responsive flip, an edge swap, or load —
     * never a keystroke: `updateTab` re-parses an SVG and
     * `syncOutsideClickHandler` cycles a document listener, neither of which
     * any doc change can affect. `refreshContent` is the hot counterpart.
     *
     * `headings` lets a caller that has already walked the doc hand its result
     * in; only a caller with nothing to reuse pays a walk here, and only when
     * the panel is actually visible.
     */
    function syncTocState(headings?: HeadingEntry[]): void {
        // Suppress the slide/fade only for the initial load reveal (see initialLoad).
        if (initialLoad) {
            document.body.classList.add("toc-initial");
        }
        panel.classList.toggle("toc-panel--open", isOpen);
        panel.classList.toggle("toc-panel--docked", tocMode === "docked");
        panel.classList.toggle("toc-panel--overlay", tocMode === "overlay");
        updateBodyClasses();
        updateTab();
        syncOutsideClickHandler();
        // Render whenever the panel is VISIBLE — docked/overlay open OR flown
        // out. `isOpen` alone excluded the flyout (which shows the panel with
        // isOpen === false), so a flyout list never rebuilt after an edit: it
        // showed a stale outline, and its stale data-headingPos values then
        // armed the NEXT drag against positions the doc had moved past.
        if (isPanelVisible()) {
            renderHeadings(headings ?? getHeadings());
        }
        if (initialLoad) {
            // Flush the no-transition state, then re-enable transitions with no
            // pending change so nothing animates from this commit.
            void panel.offsetWidth;
            document.body.classList.remove("toc-initial");
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
     * is not a heading — the shape of ordinary typing — the outline's
     * structure and text provably did not change; only heading positions after
     * the edit shifted, all by the same amount. Returns that shift, or null
     * when the change could have touched the outline (then walk).
     *
     * This observes the two REAL docs rather than predicting from steps:
     * findDiffStart/findDiffEnd bound ALL differences, so outside the returned
     * range the trees are value-identical — no heading appeared, vanished,
     * retitled, releveled, or changed depth there — and no block boundary sits
     * inside the range, so no heading position needs more than the flat delta.
     */
    function inlineOnlyShift(prev: PmNode, next: PmNode): { endA: number; delta: number } | null {
        const start = prev.content.findDiffStart(next.content);
        if (start == null) {
            return { endA: 0, delta: 0 }; // value-identical (e.g. marks-only object churn)
        }
        const diff = prev.content.findDiffEnd(next.content);
        if (!diff) {
            return { endA: 0, delta: 0 };
        }
        let { a: endA, b: endB } = diff;
        // Repeated content ("aa" → "aaa") makes the end scan overrun the start;
        // clamp to a consistent placement (readDOMChange's normalization). Any
        // placement inside the repeated run resolves to the same parent, so the
        // textblock test below is placement-independent.
        if (endA < start) { endB += start - endA; endA = start; }
        if (endB < start) { endA += start - endB; endB = start; }
        const inOneBodyTextblock = (doc: PmNode, from: number, to: number): boolean => {
            const $from = doc.resolve(from);
            return $from.sameParent(doc.resolve(to))
                && $from.parent.isTextblock
                && $from.parent.type.name !== "heading";
        };
        return inOneBodyTextblock(prev, start, endA) && inOneBodyTextblock(next, start, endB)
            ? { endA, delta: endB - endA }
            : null;
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
        const headings: HeadingEntry[] = [];
        doc.nodesBetween(
            0,
            doc.content.size,
            (node, pos) => {
                if (!node.isTextblock) {
                    return true; // a container — keep descending
                }
                if (node.type.name === "heading") {
                    const text = node.textContent.trim();
                    if (text) {
                        headings.push({
                            level: node.attrs["level"] as number,
                            text,
                            pos,
                            atDocRoot: doc.resolve(pos).depth === 0,
                        });
                    }
                }
                return false; // never walk a textblock's inline content
            },
        );
        outlineDoc = doc;
        outlineHeadings = headings;
        return headings;
    }

    function shouldAutoOpen(headings: HeadingEntry[]): boolean {
        return tocMode === "docked" && headings.length > tocAutoHideThreshold;
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
        return !userToggled && tocMode === "docked";
    }

    function syncAutoOpenState(headings: HeadingEntry[]): void {
        if (!userToggled) {
            isOpen = shouldAutoOpen(headings);
        }
    }

    // The outline STRUCTURE the rendered list currently shows. renderHeadings
    // runs on every doc-changing frame, so this decides whether that frame
    // pays a DOM rebuild. null = "nothing rendered yet / force the next
    // render".
    let renderedSignature: string | null = null;

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
            const empty = document.createElement("div");
            empty.className = "toc-empty";
            empty.textContent = t("No headings");
            list.appendChild(empty);
            dnd.notifyRerender();
            return;
        }
        headings.forEach((entry) => {
            // `entry.pos` is this row's anchor AS OF NOW — correct to seed the
            // DOM with, but never to capture: see the signature note above.
            const { level, text } = entry;
            const item = document.createElement("div");
            item.className = `toc-item toc-item--h${level}`;
            item.dataset["headingPos"] = String(entry.pos);
            item.style.paddingLeft = `${(level - 1) * 12 + 8}px`;
            item.textContent = text || `${t("Heading")} ${level}`;
            item.classList.toggle("toc-item--active", activeHeadingPos === entry.pos);
            applyTooltip(item, text, {
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
        dnd.notifyRerender();
    }

    /**
     * Full re-sync: presentation AND content. Load-time and any caller that
     * knows the panel's own state may have changed. One doc walk, shared.
     */
    function refresh(): void {
        const headings = getHeadings();
        syncAutoOpenState(headings);
        syncTocState(headings);
        // The first refresh with a mounted editor is the load-time reveal — once
        // it has committed (instantly, above), later syncs animate as usual.
        if (initialLoad && getEditorView()) {
            initialLoad = false;
        }
    }

    /**
     * THE HOT PATH: one doc-changing frame (index.ts's rAF coalescer), so it
     * sits next to the typing path and may cost only what a doc change can
     * actually change — the outline. Everything `syncTocState` commits is
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
        if (!isPanelVisible() && !autoOpenPossible()) {
            return; // nothing to render, and nothing left to auto-decide
        }
        const headings = getHeadings();
        const wasVisible = isPanelVisible();
        syncAutoOpenState(headings);
        if (isPanelVisible() !== wasVisible) {
            syncTocState(headings); // auto-open flipped: presentation changed too
            return;
        }
        if (!isPanelVisible()) {
            return;
        }
        renderHeadings(headings);
    }

    function close(): void {
        isOpen = false;
        syncTocState();
    }

    function openPanel(): void {
        isOpen = true;
        syncTocState();
    }

    function toggle(): void {
        userToggled = true;
        if (tocMode === "docked") {
            dockedUserCollapsed = isOpen;
            isOpen = !isOpen;
            syncTocState();
        } else {
            if (isOpen) {
                close();
            } else {
                openPanel();
            }
        }
    }


    // Tab click: always call toggle
    tabEl.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideFlyoutImmediate(); // a click opens persistently; drop the flyout now
        toggle();
    });

    // Keyboard activation: Enter/Space docks the panel open (the mousedown
    // handler above never fires for the keyboard, since a button synthesizes a
    // click, not a mousedown). Space is prevented so it doesn't scroll.
    tabEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            hideFlyoutImmediate();
            toggle();
        }
    });

    // ── Flyout: while the collapsed tab is hovered or focused, reveal the panel
    // transiently as a floating overlay (the Claude-desktop sidebar pattern),
    // retracting when the pointer/focus leaves both the tab and the panel. A
    // click still opens it persistently (toggle above). The flyout floats OVER
    // the content (never pushes it) and never fights the persistent open state:
    // showFlyout bails when the panel is already open. ──
    let flyoutOpen = false;
    let flyoutHideTimer: ReturnType<typeof setTimeout> | null = null;
    let flyoutCleanupTimer: ReturnType<typeof setTimeout> | null = null;
    // Must match the exit transition in toc.css (.toc-panel--flyout).
    const FLYOUT_EXIT_MS = 150;
    // Standard flyout width — a fixed dropdown width, independent of the docked
    // sidebar's (possibly dragged) --toc-width. Kept in sync with toc.css.
    const FLYOUT_WIDTH = 260;
    const FLYOUT_GAP = 6;

    function cancelFlyoutHide(): void {
        if (flyoutHideTimer) { clearTimeout(flyoutHideTimer); flyoutHideTimer = null; }
    }
    function cancelFlyoutCleanup(): void {
        if (flyoutCleanupTimer) { clearTimeout(flyoutCleanupTimer); flyoutCleanupTimer = null; }
    }
    /** Anchor the flyout as a dropdown directly BELOW the reveal tab, aligned to
     *  the tab's docked side — the tab itself never moves, so the cursor stays
     *  over it (no moving target). Positioned inline; CSS gives it card chrome. */
    function positionFlyout(): void {
        const r = tabEl.getBoundingClientRect();
        const flyoutTop = Math.round(r.bottom + FLYOUT_GAP);
        panel.style.top = `${flyoutTop}px`;
        panel.style.left = tocRight
            ? `${Math.round(Math.max(8, r.right - FLYOUT_WIDTH))}px`
            : `${Math.round(r.left)}px`;
        // The invisible hover band above the panel spans the whole gap up to the
        // content-area top (the toolbar's bottom), so the flyout stays open while
        // the pointer is anywhere in that column — no hyper-precise mousing down.
        const bandHeight = Math.max(FLYOUT_GAP, flyoutTop - getTopbarBottom());
        panel.style.setProperty("--toc-flyout-band-h", `${bandHeight}px`);
    }
    /** Fully remove the flyout box (after the exit transition, or immediately for
     *  the dock-open path) and restore the docked drawer's CSS positioning. */
    function teardownFlyout(): void {
        cancelFlyoutCleanup();
        panel.classList.remove("toc-panel--flyout", "toc-panel--flyout-in");
        document.body.classList.remove("toc-flyout-open");
        panel.style.top = "";
        panel.style.left = "";
        panel.style.removeProperty("--toc-flyout-band-h");
    }
    function showFlyout(): void {
        cancelFlyoutHide();
        cancelFlyoutCleanup(); // interrupt a pending exit teardown, if any
        if (isOpen) { return; }
        if (flyoutOpen) {
            // Re-entered mid-exit-fade: just re-assert the shown state.
            panel.classList.add("toc-panel--flyout-in");
            return;
        }
        flyoutOpen = true;
        // The flyout shows the ToC itself, so the tab's "Show table of contents"
        // tooltip is redundant (and would overlap the panel) — dismiss it.
        hideTooltip();
        renderHeadings(getHeadings());
        panel.classList.add("toc-panel--flyout");
        document.body.classList.add("toc-flyout-open");
        positionFlyout();
        // Commit the initial (down + faded) state, then transition to shown, so
        // the reveal is a slight slide-DOWN + fade-in (not the drawer's slide).
        void panel.offsetWidth;
        panel.classList.add("toc-panel--flyout-in");
        // Open at the reader's place in the document, never at the top: the
        // list renders before the card's capped geometry exists, so the active
        // row can sit far below the fold. Center it now that the final layout
        // is committed (manual scroll math — scrollIntoView would also scroll
        // the window). The enter transition is transform/opacity only, so the
        // geometry is already final here.
        const active = list.querySelector<HTMLElement>(".toc-item--active");
        if (active) {
            const listRect = list.getBoundingClientRect();
            const itemRect = active.getBoundingClientRect();
            list.scrollTop += itemRect.top - listRect.top - (list.clientHeight - itemRect.height) / 2;
        }
    }
    /** Retract with a fade + slight slide-UP, tearing the box down only once the
     *  exit transition finishes — so it never animates back through the full
     *  drawer (the visible "shrink to hidden full size" artifact). */
    function hideFlyout(): void {
        cancelFlyoutHide();
        if (!flyoutOpen) { return; }
        flyoutOpen = false;
        panel.classList.remove("toc-panel--flyout-in"); // start the exit transition
        cancelFlyoutCleanup();
        flyoutCleanupTimer = setTimeout(teardownFlyout, FLYOUT_EXIT_MS + 20);
    }
    /** Drop the flyout with no exit transition — for the click/keyboard path that
     *  docks the panel open, so the flyout box never overlaps the opening drawer. */
    function hideFlyoutImmediate(): void {
        cancelFlyoutHide();
        if (!flyoutOpen && !flyoutCleanupTimer) { return; }
        flyoutOpen = false;
        teardownFlyout();
    }
    function scheduleFlyoutHide(): void {
        cancelFlyoutHide();
        // Never retract mid-drag: a reorder/refile drag moves the pointer around
        // (and off the tab), which must not yank the panel out from under it. The
        // drag end restores normal hover via the next pointer move.
        if (document.body.classList.contains("block-dragging")) { return; }
        // A short grace period lets the pointer cross the gap from tab to panel.
        flyoutHideTimer = setTimeout(hideFlyout, 220);
    }

    tabEl.addEventListener("mouseenter", showFlyout);
    tabEl.addEventListener("mouseleave", scheduleFlyoutHide);
    tabEl.addEventListener("focus", showFlyout);
    tabEl.addEventListener("blur", scheduleFlyoutHide);
    // Moving onto the flown-out panel keeps it; leaving it retracts (unless a
    // click already promoted it to a persistent open, when flyoutOpen is false).
    panel.addEventListener("mouseenter", () => { if (flyoutOpen) { cancelFlyoutHide(); } });
    panel.addEventListener("mouseleave", () => { if (flyoutOpen) { scheduleFlyoutHide(); } });
    panel.addEventListener("focusout", (e) => {
        if (flyoutOpen && !panel.contains(e.relatedTarget as Node | null)) {
            scheduleFlyoutHide();
        }
    });
    // A drag holds the flyout open (scheduleFlyoutHide bails while block-dragging),
    // but drag-end fires no mouseleave — so on mouseup, once the drag has settled,
    // retract if the pointer no longer rests on the tab/panel/band. Without this
    // the flyout is stuck open after a drag that ends off the panel.
    document.addEventListener("mouseup", () => {
        if (!flyoutOpen) { return; }
        requestAnimationFrame(() => {
            if (flyoutOpen && !panel.matches(":hover") && !tabEl.matches(":hover")) {
                scheduleFlyoutHide();
            }
        });
    }, true);

    // ── Auto-expand detection ─────────────────────────────
    // Docked when the viewport can hold the drawer plus a comfortable content
    // column beside it — a pure viewport measure, identical in fixed and
    // full-width mode. Fixed mode used to key off the editor's measured left/right
    // gap, but the content now recenters into the space beside a docked drawer
    // (see style.css `body:not(.editor-width-auto)`), so its position depends on
    // the drawer state: measuring it would be circular and could oscillate.
    function hasEnoughSpace(): boolean {
        return window.innerWidth >= tocWidth + DOCKED_MIN_CONTENT_WIDTH;
    }

    function resolveMode(): TocMode {
        return hasEnoughSpace() ? "docked" : "overlay";
    }

    function checkResponsiveMode(): void {
        const nextMode = resolveMode();
        if (nextMode === tocMode) {
            return;
        }

        tocMode = nextMode;
        if (tocMode === "docked") {
            const headings = getHeadings();
            isOpen = userToggled ? !dockedUserCollapsed : shouldAutoOpen(headings);
        } else {
            isOpen = false;
        }
        syncTocState();
    }

    // ── Flip the panel to the opposite edge (header button + setting echo) ──
    function setPosition(position: "left" | "right"): void {
        const nextRight = position === "right";
        if (nextRight === tocRight) {
            return;
        }
        tocRight = nextRight;
        document.body.classList.toggle("toc-right", tocRight);
        panel.classList.toggle("toc-panel--right", tocRight);
        updateFlipTooltip();
        updateHideButton();
        // The available side-space changed, so re-evaluate docked/overlay, then
        // re-sync classes and the tab's side/position (syncTocState → updateTab).
        updatePanelPosition();
        checkResponsiveMode();
        syncTocState();
    }

    // ── Dynamically align to the bottom of the topbar and sync the tab's vertical position ──────────
    function updatePanelPosition(): void {
        const topbarBottom = getTopbarBottom();
        panel.style.top = `${topbarBottom}px`;
        panel.style.height = `calc(100vh - ${topbarBottom}px)`;
        // Land the reveal tab exactly where the header hide button was, so the
        // glyph doesn't shift on toggle (header padding-top offset from the top).
        tabEl.style.top = `${topbarBottom + TAB_TOP_INSET}px`;
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
        setActiveHeadingPos(result?.pos ?? null);
    }

    function scheduleScrollUpdate(): void {
        if (scrollRafId !== null) {
            return;
        }
        scrollRafId = requestAnimationFrame(updateActiveHeadingOnScroll);
    }

    requestAnimationFrame(() => {
        tocMode = resolveMode();
        const headings = getHeadings();
        isOpen = userToggled ? tocMode === "docked" && !dockedUserCollapsed : shouldAutoOpen(headings);
        updatePanelPosition();
        syncTocState();
        // Detect the currently visible heading once on init
        updateActiveHeadingOnScroll();
    });

    eventManager.onWindow("resize", () => {
        updatePanelPosition();
        checkResponsiveMode();
    });
    // Listen for scroll events to update the TOC active state independently
    eventManager.onWindow("scroll", scheduleScrollUpdate, { passive: true });

    return {
        panel,
        toggle,
        refresh,
        refreshContent,
        setPosition,
        isOpen: () => isOpen,
        isRight: () => tocRight,
        dispose: dnd.dispose,
    };
}
