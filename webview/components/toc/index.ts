import './toc.css';
import type { EditorView } from "@milkdown/prose/view";
import { applyTooltip } from "@/ui/tooltip";
import { t } from "@/i18n";
import { notifyTocWidth, notifySetTocPosition } from "@/messaging";
import { IconPanelLeft, IconPanelRight, IconArrowLeftRight } from "@/ui/icons";
import type { EventManager } from "@/eventManager";
import {
    getTopbarBottom,
    scrollElementBelowTopbar,
    getAllHeadings,
    findHeadingPos,
    findActiveHeading,
} from "@/utils/headingUtils";

interface HeadingEntry {
    level: number;
    text: string;
    pos: number;
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
    refresh: () => void;
    setPosition: (position: "left" | "right") => void;
    /** Current open/docked-side state — drives the slash menu's dynamic toggle labels. */
    isOpen: () => boolean;
    isRight: () => boolean;
} {
    // Initial side comes from the markdownWysiwyg.tocPosition setting via a
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
    tabEl.tabIndex = -1;
    document.body.appendChild(tabEl);
    applyTooltip(tabEl, t("Show table of contents"), { placement: "below" });

    let tocMode: TocMode = "overlay";
    let isOpen = false;
    let dockedUserCollapsed = false;
    let userToggled = false;
    let activeHeadingPos: number | null = null;
    let scrollRafId: number | null = null;

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
        if (activeItem) {
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

    function syncOutsideClickHandler(): void {
        document.removeEventListener("mousedown", outsideClickHandler);
        if (isOpen && tocMode === "overlay") {
            setTimeout(() => {
                if (isOpen && tocMode === "overlay") {
                    document.addEventListener("mousedown", outsideClickHandler);
                }
            }, 0);
        }
    }

    function syncTocState(): void {
        panel.classList.toggle("toc-panel--open", isOpen);
        panel.classList.toggle("toc-panel--docked", tocMode === "docked");
        panel.classList.toggle("toc-panel--overlay", tocMode === "overlay");
        updateBodyClasses();
        updateTab();
        syncOutsideClickHandler();
        if (isOpen) {
            renderHeadings(getHeadings());
        }
    }

    // ── Extract all heading nodes from the ProseMirror document ────────
    function getHeadings(): HeadingEntry[] {
        const view = getEditorView();
        if (!view) {
            return [];
        }
        const headings: HeadingEntry[] = [];
        view.state.doc.nodesBetween(
            0,
            view.state.doc.content.size,
            (node, pos) => {
                if (node.type.name === "heading") {
                    const text = node.textContent.trim();
                    if (text) {
                        headings.push({
                            level: node.attrs["level"] as number,
                            text,
                            pos,
                        });
                    }
                }
            },
        );
        return headings;
    }

    function shouldAutoOpen(headings: HeadingEntry[]): boolean {
        return tocMode === "docked" && headings.length > tocAutoHideThreshold;
    }

    function syncAutoOpenState(headings: HeadingEntry[]): void {
        if (!userToggled) {
            isOpen = shouldAutoOpen(headings);
        }
    }

    function renderHeadings(headings: HeadingEntry[]): void {
        list.innerHTML = "";
        if (headings.length === 0) {
            const empty = document.createElement("div");
            empty.className = "toc-empty";
            empty.textContent = t("No headings");
            list.appendChild(empty);
            return;
        }
        headings.forEach(({ level, text, pos }) => {
            const item = document.createElement("div");
            item.className = `toc-item toc-item--h${level}`;
            item.dataset["headingPos"] = String(pos);
            item.style.paddingLeft = `${(level - 1) * 12 + 8}px`;
            item.textContent = text || `${t("Heading")} ${level}`;
            item.classList.toggle("toc-item--active", activeHeadingPos === pos);
            applyTooltip(item, text, {
                placement: "above",
                truncatedOnly: true,
            });
            item.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const view = getEditorView();
                if (!view) {
                    return;
                }
                try {
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
    }

    function refresh(): void {
        const headings = getHeadings();
        syncAutoOpenState(headings);
        syncTocState();
    }

    function outsideClickHandler(e: MouseEvent): void {
        if (!panel.contains(e.target as Node)) {
            close();
        }
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
        toggle();
    });

    // ── Auto-expand detection ─────────────────────────────
    function hasEnoughSpace(): boolean {
        if (document.body.classList.contains("editor-width-auto")) {
            return window.innerWidth >= tocWidth + DOCKED_MIN_CONTENT_WIDTH;
        }
        const editorEl = document.getElementById("editor");
        if (!editorEl) {
            return false;
        }
        const rect = editorEl.getBoundingClientRect();
        const sideSpace = tocRight ? window.innerWidth - rect.right : rect.left;
        return sideSpace >= tocWidth && rect.width >= DOCKED_MIN_CONTENT_WIDTH;
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
        setPosition,
        isOpen: () => isOpen,
        isRight: () => tocRight,
    };
}
