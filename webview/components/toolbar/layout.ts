/**
 * Where the toolbar's items GO, as opposed to what they do: the two placement
 * zones, the responsive overflow into the ⋯ menu, the drag-and-drop customize
 * mode, and whole-bar visibility. Nothing here knows what any item is - items
 * arrive already built and wrapped, keyed by id, and this module only ever
 * re-parents them.
 *
 * Under `formattingInSecondRow` there is a SECOND holder, a row inside the bar
 * itself (dock.ts), and the placement question changes
 * shape rather than gaining a case: the partition is derived from
 * `ITEM_MUTATES`, so there is no config to resolve, nothing hidden, no overflow
 * to collapse and no customize mode to enter. Everything below that reads
 * `latestConfig` is therefore dead under that arrangement, and the render
 * branch returns before reaching it.
 *
 * That re-parenting is the load-bearing property: every item is built exactly
 * once, so a layout change moves live DOM and its listeners survive. Rebuilding
 * items on a config change would drop them.
 *
 * Hiding the bar hides it rather than destroying it, so the host hooks it owns
 * (link prompt, image panel, find) keep serving the slash menu and the command
 * palette while it is off screen.
 */
import { IconChevronDown } from "@/ui/icons";
import { t } from "@/i18n";
import { notifySetToolbarLayout, notifySetToolbarVisible } from "@/messaging";
import { createButton } from "@/ui/dom";
import { createMenuTrigger } from "./menuPrimitives";
import { wireHoverMenu } from "./hoverMenu";
import { createOverflowController } from "./overflow";
import type { OverflowController, OverflowGroup } from "./overflow";
import { computeDockPartition, computeZones, offeredItems } from "./registry";
import type { ToolbarItemId } from "./registry";
import { createFormattingDock, type FormattingDock } from "./dock";
import { hostArranges } from "../../../shared/hostProfile";
import { enterEditMode } from "./dnd";
import type { ToolbarConfig } from "../../../shared/messages";

export interface ToolbarLayoutDeps {
    /** The host bar the toolbar is appended into. */
    topbar: HTMLElement;
    /** Every built item wrapper, keyed by id. Read on every render; never rebuilt. */
    items: Partial<Record<ToolbarItemId, HTMLElement>>;
    /** The debug dropdown, pinned just before Settings; null when debug tools are off. */
    dbgItem: HTMLElement | null;
    /** The disk-drift badge, pinned at the front of the right zone. */
    syncConflictItem: HTMLElement;
    /** The Logseq status badge, pinned just after the disk-drift badge. */
    logseqItem: HTMLElement;
}

export interface ToolbarLayout {
    /** The bar element, already appended to the topbar. */
    toolbar: HTMLElement;
    /** Rebuild the zones for a changed placement config (deferred while dragging). */
    applyConfig: (config: ToolbarConfig) => void;
    /** Re-place the items after a syntax-target change (shared/syntaxSets.ts). */
    applySyntaxSets: () => void;
    /** Enter the drag-and-drop customize mode. */
    startCustomize: () => void;
    /** Show or hide the whole bar, writing the setting through. */
    setToolbarVisible: (visible: boolean) => void;
    isVisible: () => boolean;
    /** Show or hide the debug dropdown. */
    setDebugMode: (enabled: boolean) => void;
    /** Show or hide the disk-drift badge. */
    setSyncConflict: (active: boolean) => void;
    /** Show or hide the Logseq status badge. */
    setLogseq: (active: boolean) => void;
}

export function createToolbarLayout(deps: ToolbarLayoutDeps): ToolbarLayout {
    const { topbar, items, dbgItem, syncConflictItem, logseqItem } = deps;
    let syncConflictVisible = false;
    let logseqVisible = false;

    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";

    // ── Placement zones ──
    // Items are assigned to a zone (or hidden) by the per-item
    // `toolbar.items.*` settings and ordered within a zone by `toolbar.order`
    // (see computeZones). The ⋯ overflow menu collapses the left zone's
    // tail on narrow panes (see setupOverflow).
    const leftZone = document.createElement("div");
    leftZone.className = "tb-zone tb-zone--left";
    const rightZone = document.createElement("div");
    rightZone.className = "tb-zone tb-zone--right";
    toolbar.append(leftZone, rightZone);
    // ── Overflow (⋯) menu for the left zone on narrow panes ──
    // Reuses the tb-fmt-wrap hover/positioning pattern; collapsed items are
    // physically reparented into the panel so listeners survive.
    const moreWrap = document.createElement("div");
    moreWrap.className = "tb-fmt-wrap tb-more-wrap";
    moreWrap.style.display = "none";

    const moreBtn = createMenuTrigger({
        text: "⋯",
        className: "ui-btn tb-btn tb-more-btn",
        ariaLabel: t("More"),
    });

    const moreMenu = document.createElement("div");
    moreMenu.className = "tb-more-menu";
    moreMenu.style.display = "none";

    wireHoverMenu(moreWrap, moreBtn, moreMenu);

    moreWrap.appendChild(moreBtn);
    moreWrap.appendChild(moreMenu);
    leftZone.appendChild(moreWrap);

    topbar.appendChild(toolbar);

    // ── Render + responsive overflow ──────────────────────
    let overflow: OverflowController | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let debugVisible = !!window.__i18n?.debugMode;
    // The last placement config we know about, and whether the user is in the
    // drag-and-drop customize mode. While editing, the DOM is the source of
    // truth and incoming config echoes (from our own writes) are deferred so
    // they don't tear down the drag state mid-session.
    let latestConfig: ToolbarConfig | undefined = window.__i18n?.toolbar;
    let editing = false;
    // The items to place: what this host can carry (shared/hostProfile.ts),
    // minus what the reader's syntax target does not spell
    // (shared/syntaxSets.ts). NOT read once, unlike the two facts below it: the
    // host declaration is baked at panel load, and the target is a setting the
    // reader changes with the editor open, so `applySyntaxSets` recomputes this
    // and re-renders rather than leaving the bar on the target the document was
    // opened under.
    let available = offeredItems();
    // Whether a syntax-target change arrived while the customize tray was open,
    // so it can be applied on exit. The tray's own exit deliberately keeps the
    // DOM rather than rebuilding, because the config echo can lag the drags;
    // that reasoning does not cover a withdrawn item, which would be left on
    // the bar as a control the target has made inert, and a live-looking button
    // that does nothing is the one outcome the read-only mode and every other
    // gate in this editor are written to avoid.
    let syntaxChangedWhileEditing = false;
    // The second holder, or null on a surface that keeps everything in the bar.
    // Read once because the arrangement is baked at panel load, and null is the
    // fact every branch below asks about, so no call site re-reads the
    // declaration.
    const dock: FormattingDock | null = hostArranges("formattingInSecondRow")
        ? createFormattingDock({ items })
        : null;
    if (dock) {
        // The bar holds both rows, so the bar is what turns into a column and
        // what every height consumer goes on measuring.
        topbar.classList.add("editor-topbar--stacked");
        topbar.appendChild(dock.el);
    }
    // Whether the arrangement is the user's to change. Read once, and the two
    // things it withdraws are withdrawn HERE as well as at the menus that offer
    // them: `hostHasCommand` already keeps the gear row, the slash row and the
    // palette from reaching these, so this is the layer that makes them inert
    // rather than the layer that hides them.
    const layoutIsFixed = hostArranges("fixedToolbarLayout");

    // ── Whole-bar visibility (birta.toolbar.visible) ──
    // Hiding slides the fixed topbar up (a body class the CSS keys off) and
    // shows a slim expand tab at the top edge (the TOC toggle tab, rotated to
    // the horizontal axis). The bar is hidden, not destroyed, so its host
    // hooks (link prompt, image panel, find) keep serving the slash menu and
    // command palette while it is off screen.
    let toolbarVisible = layoutIsFixed || latestConfig?.visible !== false;

    // The reveal tab exists only where the bar can go away. Under a fixed
    // layout it is the one route to search and settings, so it never hides and
    // a tab to bring it back would be chrome for a state nothing reaches.
    if (!layoutIsFixed) {
        const showTab = createButton({
            className: "ui-btn toolbar-toggle-tab",
            icon: IconChevronDown,
            title: t("Show toolbar"),
            onClick: () => setToolbarVisible(true),
        });
        // The tab carries its own context section so its right-click menu offers
        // exactly "Show Toolbar" — the hidden state must never read "Hide Toolbar".
        showTab.dataset["vscodeContext"] = JSON.stringify({
            webviewSection: "toolbarTab",
            preventDefaultContextMenuItems: true,
        });
        document.body.appendChild(showTab);
    }

    function applyVisibility(visible: boolean): void {
        toolbarVisible = visible;
        topbar.classList.toggle("editor-topbar--hidden", !visible);
        document.body.classList.toggle("toolbar-hidden", !visible);
        // The TOC anchors its panel and tab to the topbar's bottom edge;
        // nudge it (and anything else geometry-bound) to re-measure.
        window.dispatchEvent(new Event("resize"));
    }

    /** Optimistic write-through; the setting echo arrives as a toolbarConfig. */
    function setToolbarVisible(visible: boolean): void {
        if (layoutIsFixed || visible === toolbarVisible) {
            return;
        }
        applyVisibility(visible);
        notifySetToolbarVisible(visible);
    }


    function startCustomize(): void {
        if (layoutIsFixed || editing) {
            return;
        }
        editing = true;

        // Hidden tray: a bar below the toolbar holding every off item, plus the
        // Done button. Dragging between it and the zones shows/hides items.
        const tray = document.createElement("div");
        tray.className = "tb-hidden-tray";

        const label = document.createElement("span");
        label.className = "tb-hidden-tray-label";
        label.textContent = t("Drag to add and remove:");

        const trayItems = document.createElement("div");
        trayItems.className = "tb-hidden-tray-items tb-zone";

        const doneBtn = document.createElement("button");
        doneBtn.className = "ui-btn ui-btn--primary tb-edit-done";
        doneBtn.textContent = t("Done");

        tray.append(label, trayItems, doneBtn);

        for (const id of computeZones(latestConfig, available).hidden) {
            const el = items[id];
            if (el) { trayItems.appendChild(el); }
        }
        document.body.appendChild(tray);

        const exit = enterEditMode({
            toolbar,
            zones: { left: leftZone, right: rightZone, hidden: trayItems },
            moreWrap,
            expandOverflow: () => overflow?.update(Number.MAX_SAFE_INTEGER),
            onChange: (change) => notifySetToolbarLayout(change.item, change.order),
            onExit: () => {
                editing = false;
                // The DOM already reflects every drag; don't rebuild from config
                // (which may lag behind the write echo). Detach the tray (drops
                // any still-hidden items) and re-sync overflow to the live DOM.
                tray.remove();
                if (syntaxChangedWhileEditing) {
                    syntaxChangedWhileEditing = false;
                    // Rebuild rather than resync: an item the target withdrew
                    // has to leave, and only a render decides placement. The
                    // config this renders from can be a drag behind, and that
                    // is the cheaper wrong: every drag was written through, so
                    // its echo arrives as a `toolbarConfig` and renders again.
                    render(latestConfig);
                    return;
                }
                resyncOverflow();
            },
        });
        doneBtn.addEventListener("click", exit);
    }

    function resyncOverflow(): void {
        resizeObserver?.disconnect();
        resizeObserver = null;
        overflow = null;
        setupOverflow();
    }

    // Width available to the collapsible (left-zone) items = toolbar minus
    // the right zone's CONTENT. The zones fill their flex tracks, so
    // scrollWidth/clientWidth report the (large) track width, not the
    // content — using those made a lone item look like it overflowed. Sum
    // the right items' own widths instead; the left items are the overflow
    // groups themselves, so the controller already accounts for them. The
    // slack absorbs the inter-zone gaps.
    const ZONE_GAP_SLACK = 8;
    function measureContentWidth(zone: HTMLElement): number {
        let total = 0;
        let count = 0;
        for (const el of Array.from(zone.children)) {
            if (el instanceof HTMLElement && el.classList.contains("tb-item")) {
                total += el.getBoundingClientRect().width;
                count++;
            }
        }
        if (count > 1) {
            total += 2 * (count - 1); // inter-item flex gaps (2px each)
        }
        return total;
    }
    function availableWidth(): number {
        return Math.max(
            0,
            toolbar.clientWidth - measureContentWidth(rightZone) - ZONE_GAP_SLACK,
        );
    }

    function setupOverflow(): void {
        // The left zone holds every collapsible item (the right zone's
        // utilities never collapse); each group's comment marker remembers
        // its home slot.
        const wrappers = Array.from(leftZone.children).filter(
            (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("tb-item"),
        );
        const groups: OverflowGroup[] = wrappers.map((el) => ({
            name: el.dataset["itemId"] ?? "",
            el,
            sepBefore: null,
        }));
        // Collapse from the end of the left zone; never collapse the format
        // (text-level) dropdown — it is the toolbar's anchor control.
        const collapseOrder = groups
            .map((_, i) => i)
            .filter((i) => groups[i]!.name !== "format")
            .reverse();
        overflow = createOverflowController({
            groups,
            collapseOrder,
            moreWrap,
            panel: moreMenu,
        });
        overflow.update(availableWidth());
        if (typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(() => overflow?.update(availableWidth()));
            resizeObserver.observe(toolbar);
        }
    }

    function render(config: ToolbarConfig | undefined): void {
        resizeObserver?.disconnect();
        resizeObserver = null;
        overflow = null;

        if (dock) {
            // Two holders, one partition, no config: every item this host can
            // carry goes to the dock if it edits the document and to the top
            // bar's right zone if it does not. The left zone stays empty, which
            // is what leaves the titlebar row to the window (a file name beside
            // the traffic lights, on the surface that has them).
            const { dock: docked, topBar } = computeDockPartition(available);
            leftZone.replaceChildren();
            rightZone.replaceChildren();
            moreMenu.replaceChildren();
            dock.render(docked);
            // The row's toggle leads the top bar, ahead of every item the
            // partition placed. It is not one of them: it belongs to the row
            // below rather than to the set of controls that read the document,
            // so it sits at the head of the group instead of somewhere inside
            // an order that is the partition's to decide.
            rightZone.appendChild(dock.toggle);
            for (const id of topBar) {
                const el = items[id];
                if (el) { rightZone.appendChild(el); }
            }
            renderPinned();
            return;
        }
        // Detach every item wrapper (from its zone or the ⋯ panel) plus any
        // stale overflow markers; the persistent moreWrap is re-homed below.
        moreWrap.remove();
        leftZone.replaceChildren();
        rightZone.replaceChildren();
        moreMenu.replaceChildren();

        const zones = computeZones(config, available);
        for (const id of zones.left) {
            const el = items[id];
            if (el) { leftZone.appendChild(el); }
        }
        for (const id of zones.right) {
            const el = items[id];
            if (el) { rightZone.appendChild(el); }
        }
        // The ⋯ button sits at the end of the left zone, after the
        // collapsible tail.
        leftZone.appendChild(moreWrap);

        renderPinned();

        setupOverflow();
    }

    /**
     * The three items that are pinned rather than placed: the debug dropdown
     * just before Settings, and the two status badges at the front of the right
     * zone. None is user-placeable, so both render paths want them and neither
     * consults the config for them.
     */
    function renderPinned(): void {
        // Debug dropdown: pinned just before Settings in the right zone.
        if (dbgItem) {
            const settingsEl = items.settings;
            if (settingsEl && settingsEl.parentElement === rightZone) {
                rightZone.insertBefore(dbgItem, settingsEl);
            } else {
                rightZone.appendChild(dbgItem);
            }
            dbgItem.style.display = debugVisible ? "" : "none";
        }

        // Status badges: pinned at the front of the right zone, drift first.
        // Both are inserted before the current first child in reverse order, so
        // the drift badge ends up ahead of the Logseq one — a warning outranks
        // a mode indicator.
        rightZone.insertBefore(logseqItem, rightZone.firstChild);
        logseqItem.style.display = logseqVisible ? "" : "none";
        rightZone.insertBefore(syncConflictItem, rightZone.firstChild);
        syncConflictItem.style.display = syncConflictVisible ? "" : "none";
    }

    render(window.__i18n?.toolbar);
    if (!toolbarVisible) {
        applyVisibility(false);
    }

    return {
        toolbar,
        startCustomize,
        setToolbarVisible,
        isVisible: () => toolbarVisible,
        setDebugMode(enabled: boolean): void {
            debugVisible = enabled;
            if (dbgItem) {
                dbgItem.style.display = enabled ? "" : "none";
            }
            // Toggling debug changes the right zone's width, which changes
            // the space available to the collapsible left zone.
            overflow?.update(availableWidth());
        },
        setSyncConflict(active: boolean): void {
            syncConflictVisible = active;
            syncConflictItem.style.display = active ? "" : "none";
            // Body-level flag: with the toolbar hidden, the badge would be
            // invisible — the collapsed bar's expand tab tints instead, so drift
            // is never a state the UI silently sits in.
            document.body.classList.toggle("has-sync-conflict", active);
            // Same as debug: the right zone's width changed.
            overflow?.update(availableWidth());
        },
        setLogseq(active: boolean): void {
            logseqVisible = active;
            logseqItem.style.display = active ? "" : "none";
            // Same as debug: the right zone's width changed.
            overflow?.update(availableWidth());
        },
        applySyntaxSets(): void {
            // The set of items the target spells has changed. Everything is
            // already built (the build-time question is the host's, and that
            // has not moved), so this is a re-placement: recompute which of
            // them may be placed and render, under a fixed layout too, where
            // there is no config to apply but there are still items to withdraw.
            available = offeredItems();
            if (editing) {
                syntaxChangedWhileEditing = true;
                return;
            }
            render(latestConfig);
        },
        applyConfig(config: ToolbarConfig): void {
            // A fixed layout has no config to apply: placements are derived and
            // visibility is settled. Taking the echo would let a stale stored
            // `visible: false` blank a bar the surface says is permanent.
            if (layoutIsFixed) { return; }
            latestConfig = config;
            const visible = config.visible !== false;
            if (visible !== toolbarVisible) {
                applyVisibility(visible);
            }
            // Defer while dragging: the DOM already reflects the change, and a
            // rebuild would drop the edit-mode decorations. Applied on exit.
            if (!editing) {
                render(config);
            }
        },
    };
}
