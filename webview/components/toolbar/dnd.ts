/**
 * webview/components/toolbar/dnd.ts
 *
 * Drag-and-drop "Customize toolbar" mode. Pointer events (not native HTML5
 * drag), no libraries.
 *
 * Why pointer events: native HTML5 drag is fragile inside a VS Code webview —
 * dragging out of the iframe/window fires a premature `dragend` that kills the
 * session (so a drop on return does nothing), and its `dataTransfer` leaks the
 * item id into ProseMirror as text on an editor drop. Pointer capture keeps
 * pointermove/up flowing even outside the window, and there is no dataTransfer
 * to leak — so both bugs are structurally gone (MAR-36).
 *
 * The shape: while active, a capture-phase listener swallows button
 * mousedown/click (so parked buttons can't fire their action), and a pointer
 * drag reorders items across three targets — the two toolbar zones plus a
 * "hidden" tray shown below the bar. A drop into a zone shows the item there; a
 * drop anywhere else (the editor, off the bar, the tray) hides it.
 * `ToolbarPlacement` models all three (`left | right | hidden`).
 */
import type { ToolbarPlacement } from "../../../shared/messages";
import { applyTooltip } from "../../ui/tooltip";

/** A single layout change produced by a drop. */
export interface ToolbarLayoutChange {
    /** Set only when the dragged item changed placement (zone, or shown/hidden). */
    item?: { id: string; placement: ToolbarPlacement };
    /** Left-to-right order of the visible item ids (excludes hidden + debug). */
    order: string[];
}

export interface EditModeDeps {
    toolbar: HTMLElement;
    /** The three drop targets: two zones + the hidden tray's item container. */
    zones: Record<ToolbarPlacement, HTMLElement>;
    /** The ⋯ wrapper; stays pinned at the end of the left zone. */
    moreWrap: HTMLElement;
    /** Force all collapsed items back into the toolbar so they are draggable. */
    expandOverflow: () => void;
    onChange: (change: ToolbarLayoutChange) => void;
    /** Called on exit (host removes the tray + re-syncs overflow). */
    onExit: () => void;
}

/**
 * Index at which a dragged item should insert among `items`, given the pointer
 * X. Returns the index of the first item whose horizontal midpoint is past the
 * pointer, or `items.length` to append. Pure for testability.
 */
export function insertionIndexFromX(items: HTMLElement[], clientX: number): number {
    for (let i = 0; i < items.length; i++) {
        const rect = items[i]!.getBoundingClientRect();
        if (clientX < rect.left + rect.width / 2) {
            return i;
        }
    }
    return items.length;
}

const PLACEMENTS: ToolbarPlacement[] = ["left", "right", "hidden"];
/** Zones that contribute to the persisted visible order (the tray does not). */
const ORDER_ZONES: ToolbarPlacement[] = ["left", "right"];

/** Movement (px) before a press becomes a drag — distinguishes a click from a drag. */
const DRAG_THRESHOLD = 4;

/** Enter customize mode. Returns a function that exits it. */
export function enterEditMode(deps: EditModeDeps): () => void {
    const { toolbar, zones, moreWrap, expandOverflow, onChange, onExit } = deps;

    expandOverflow();
    toolbar.classList.add("toolbar--editing");

    /** `.tb-item` wrappers across the given targets (excludes debug). */
    function items(targets: ToolbarPlacement[] = PLACEMENTS): HTMLElement[] {
        const out: HTMLElement[] = [];
        for (const name of targets) {
            for (const el of Array.from(zones[name].children)) {
                if (
                    el instanceof HTMLElement &&
                    el.classList.contains("tb-item") &&
                    el.dataset["itemId"] !== "debug"
                ) {
                    out.push(el);
                }
            }
        }
        return out;
    }

    // Swallow button actions while editing (stopPropagation only — pointer drags
    // still start). Capture phase so it beats the buttons' own handlers.
    const swallow = (e: Event): void => {
        e.stopPropagation();
    };
    toolbar.addEventListener("mousedown", swallow, true);
    toolbar.addEventListener("click", swallow, true);

    // Customize mode disables the inner controls' pointer-events (so a parked
    // button can't fire its action), which also kills their own tooltips. Bind
    // a simple NAME tooltip to each `.tb-item` wrapper across all three targets
    // — the wrapper keeps pointer-events — reading the inner control's clean
    // aria-label. Torn down on exit so normal-mode tooltips resume without a
    // duplicate binding.
    const nameTooltips = items().map((el) =>
        applyTooltip(
            el,
            el.querySelector("[aria-label]")?.getAttribute("aria-label") ?? "",
            { placement: "below" },
        ),
    );

    const indicator = document.createElement("div");
    indicator.className = "tb-drop-indicator";

    let dragging: HTMLElement | null = null;
    let sourceZone: ToolbarPlacement | null = null;
    let ghost: HTMLElement | null = null;
    let pointerId = -1;
    let grabDX = 0;
    let grabDY = 0;
    let startX = 0;
    let startY = 0;
    let moved = false;

    /** `.tb-item` children of a target (excludes ⋯ and the indicator). */
    function zoneItems(zone: HTMLElement): HTMLElement[] {
        return Array.from(zone.children).filter(
            (el): el is HTMLElement =>
                el instanceof HTMLElement && el.classList.contains("tb-item"),
        );
    }

    function placementOf(el: HTMLElement | null): ToolbarPlacement | null {
        return el ? (PLACEMENTS.find((n) => zones[n] === el) ?? null) : null;
    }

    /** End-of-target reference node (before ⋯ in the left zone). */
    function endRef(zone: HTMLElement): Node | null {
        return zone === zones.left ? moreWrap : null;
    }

    function clearIndicator(): void {
        indicator.remove();
    }

    /** Highlight the tray as a drop target (it has no per-slot ordering). */
    function setTrayHighlight(on: boolean): void {
        zones.hidden.classList.toggle("tb-tray-drop-active", on);
    }

    /** The drop-target zone under the pointer, or null (editor / off-bar). */
    function zoneAtPoint(x: number, y: number): ToolbarPlacement | null {
        const hit = document.elementFromPoint(x, y);
        if (!hit) {
            return null;
        }
        return PLACEMENTS.find((n) => zones[n] === hit || zones[n].contains(hit)) ?? null;
    }

    /** Insert `node` into `zone` at the slot for pointer X (before ⋯ on the left). */
    function insertAtX(zone: HTMLElement, node: Node, x: number): void {
        const others = zoneItems(zone).filter((el) => el !== dragging);
        const idx = insertionIndexFromX(others, x);
        zone.insertBefore(node, idx >= others.length ? endRef(zone) : others[idx]!);
    }

    function positionGhost(x: number, y: number): void {
        if (ghost) {
            ghost.style.left = `${x - grabDX}px`;
            ghost.style.top = `${y - grabDY}px`;
        }
    }

    function beginGhost(): void {
        if (!dragging) {
            return;
        }
        const rect = dragging.getBoundingClientRect();
        ghost = dragging.cloneNode(true) as HTMLElement;
        ghost.classList.add("tb-drag-ghost");
        ghost.style.width = `${rect.width}px`;
        ghost.style.height = `${rect.height}px`;
        document.body.appendChild(ghost);
        dragging.classList.add("tb-item--dragging");
    }

    function onPointerDown(e: PointerEvent): void {
        if (e.button !== 0) {
            return;
        }
        if (dragging) {
            return; // a drag is already in flight; ignore a second pointer
        }
        const item = (e.target as HTMLElement)?.closest?.(".tb-item") as HTMLElement | null;
        if (!item || item.dataset["itemId"] === "debug") {
            return;
        }
        const zone = placementOf(item.parentElement as HTMLElement);
        if (!zone) {
            return; // not one of our draggable items
        }
        e.preventDefault();
        dragging = item;
        sourceZone = zone;
        pointerId = e.pointerId;
        const rect = item.getBoundingClientRect();
        grabDX = e.clientX - rect.left;
        grabDY = e.clientY - rect.top;
        startX = e.clientX;
        startY = e.clientY;
        moved = false;
        // Capture keeps move/up flowing even if the pointer leaves the window.
        try { item.setPointerCapture(e.pointerId); } catch { /* not supported */ }
    }

    function onPointerMove(e: PointerEvent): void {
        if (!dragging || e.pointerId !== pointerId) {
            return;
        }
        if (!moved) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) {
                return; // still just a press, not yet a drag
            }
            moved = true;
            beginGhost();
        }
        positionGhost(e.clientX, e.clientY);
        const zoneName = zoneAtPoint(e.clientX, e.clientY);
        // The tray has no per-slot order (it isn't persisted and re-opens in
        // canonical order), so don't show a positional indicator there — just
        // highlight it as "drop to hide". Real zones get the insertion line.
        if (zoneName === "hidden") {
            clearIndicator();
            setTrayHighlight(true);
        } else if (zoneName) {
            setTrayHighlight(false);
            insertAtX(zones[zoneName], indicator, e.clientX);
        } else {
            setTrayHighlight(false);
            clearIndicator();
        }
    }

    function onPointerUp(e: PointerEvent): void {
        if (!dragging || e.pointerId !== pointerId) {
            return;
        }
        if (!moved) {
            cancelDrag(); // a click, not a drag — no reorder, no commit
            return;
        }
        const zoneName = zoneAtPoint(e.clientX, e.clientY);
        const targetZone = zoneName ? zones[zoneName] : zones.hidden;
        clearIndicator(); // remove before measuring so its width can't skew the slot
        if (targetZone === zones.hidden) {
            // No per-slot order in the tray — drop to its default (end) spot.
            zones.hidden.appendChild(dragging);
        } else {
            insertAtX(targetZone, dragging, e.clientX);
        }
        teardownDrag();
        commit(targetZone);
    }

    function onPointerCancel(e: PointerEvent): void {
        if (dragging && e.pointerId === pointerId) {
            cancelDrag();
        }
    }

    /** Remove the ghost + release capture; leaves `dragging`/indicator to callers. */
    function teardownDrag(): void {
        ghost?.remove();
        ghost = null;
        setTrayHighlight(false);
        try { dragging?.releasePointerCapture(pointerId); } catch { /* already released */ }
        pointerId = -1;
        moved = false;
    }

    /** Abort the drag, leaving the item where it started. */
    function cancelDrag(): void {
        teardownDrag();
        clearIndicator();
        dragging?.classList.remove("tb-item--dragging");
        dragging = null;
        sourceZone = null;
    }

    function commit(targetZone: HTMLElement): void {
        clearIndicator();
        dragging?.classList.remove("tb-item--dragging");
        const dragged = dragging;
        const targetName = placementOf(targetZone);
        dragging = null;

        // Persisted order is the visible items only (left → right).
        const order = items(ORDER_ZONES)
            .map((el) => el.dataset["itemId"] ?? "")
            .filter(Boolean);

        const change: ToolbarLayoutChange = { order };
        if (dragged && targetName && targetName !== sourceZone) {
            change.item = { id: dragged.dataset["itemId"] ?? "", placement: targetName };
        }
        sourceZone = null;
        onChange(change);
    }

    // Pointer events on `document`: pointerdown in capture so it beats the
    // buttons; captured move/up dispatch to the item and bubble to document.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);

    // Escape cancels an in-flight drag, else leaves customize mode.
    function onKeyDown(e: KeyboardEvent): void {
        if (e.key !== "Escape") {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (dragging) {
            cancelDrag();
        } else {
            exit();
        }
    }
    document.addEventListener("keydown", onKeyDown, true);

    function exit(): void {
        if (dragging) {
            cancelDrag();
        }
        for (const tip of nameTooltips) { tip.dispose(); }
        toolbar.classList.remove("toolbar--editing");
        toolbar.removeEventListener("mousedown", swallow, true);
        toolbar.removeEventListener("click", swallow, true);
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);
        document.removeEventListener("pointercancel", onPointerCancel);
        document.removeEventListener("keydown", onKeyDown, true);
        clearIndicator();
        onExit();
    }

    return exit;
}
