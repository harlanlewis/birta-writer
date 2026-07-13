/**
 * components/toc/dnd.ts
 *
 * The TOC panel's two drag-and-drop roles, both riding the shared pointer
 * drag session in components/blockMenu/drag:
 *
 *   - Drop zone: a DropZoneProvider covering the open panel. A document
 *     drag entering it retargets onto the outline's slots (./dropModel) — a
 *     gap line between top-level sections, or "into" a section (append at
 *     its end). The commit path stays the session's single moveBlocks call,
 *     so the panel can never invent drop semantics the primitive rejects.
 *   - Drag source: each TOP-LEVEL item is a handle for its whole section
 *     (moveRangeAt's heading semantics — a collapsed section carries its
 *     hidden body). A TOC-initiated drag offers only gap slots: a section
 *     reorders BETWEEN sections; "into" targets are for document blocks
 *     refiled from outside the panel.
 *
 * Geometry is snapshotted once per session (one getBoundingClientRect per
 * rendered item plus the list box) and re-measured lazily after a list
 * rebuild (notifyRerender) or an edge auto-scroll. Zero layout reads while
 * no drag is in flight.
 */
import type { EditorView } from "@milkdown/prose/view";
import {
    edgeScrollVelocity,
    hideDropIndicator,
    registerDropZoneProvider,
    showDropIndicatorAt,
    startPointerDragSession,
    type DropZoneProvider,
} from "../blockMenu/drag";
import { moveRangeAt } from "../blockMenu/index";
import { isHiddenTargetPos } from "../../plugins/headingFold";
import {
    tocDropSlots,
    tocDropTargetFor,
    tocPillLabel,
    type MeasuredTocSlot,
    type TocHeadingEntry,
} from "./dropModel";

export interface TocDndDeps {
    panel: HTMLElement;
    list: HTMLElement;
    getEditorView: () => EditorView | null;
    isOpen: () => boolean;
    /** The outline the panel currently renders (index.ts's getHeadings). */
    getHeadings: () => TocHeadingEntry[];
}

export interface TocDnd {
    /** Arm a rendered item as a drag handle for its section. No-op for
     * nested headings — they are landmarks, not handles. */
    wireItemDrag(item: HTMLElement, entry: TocHeadingEntry): void;
    /** Heading pos of an in-flight TOC-initiated drag, else null — lets a
     * mid-drag list rebuild restore the source item's ghosted state. */
    dragSourceHeadingPos(): number | null;
    /** The list was rebuilt: the measured geometry snapshot is stale. */
    notifyRerender(): void;
    /** Unregister the drop-zone provider. */
    dispose(): void;
}

/** List-edge band (px) inside which a hovering drag auto-scrolls the list. */
const LIST_SCROLL_ZONE = 48;

export function initTocDnd(deps: TocDndDeps): TocDnd {
    // Heading pos of this module's own in-flight drag (set on the handle's
    // mousedown, cleared by the session's onStop). Non-null also flips
    // allowInto off for the session it starts — see the header comment.
    let ownDragPos: number | null = null;

    // Per-session snapshot (sessionStart/measure), dropped at sessionEnd.
    let sessionView: EditorView | null = null;
    let sessionKind: "block" | "item" = "block";
    let allowInto = false;
    let measured: MeasuredTocSlot[] = [];
    let intoItems = new Map<number, HTMLElement>();
    let stale = false;

    // Chrome this provider currently draws. The indicator line is the
    // session-wide singleton, so hide it only when THIS zone drew it.
    let indicatorShown = false;
    let dropIntoItem: HTMLElement | null = null;

    function hideOwnIndicator(): void {
        if (indicatorShown) {
            hideDropIndicator();
            indicatorShown = false;
        }
    }

    function clearDropInto(): void {
        dropIntoItem?.classList.remove("toc-item--drop-into");
        dropIntoItem = null;
    }

    /** Snapshot the outline's slots paired with viewport geometry. Gap
     * slots anchor to their heading's item top (terminal end-of-doc slot:
     * the last rendered item's bottom); into slots take the item's band. */
    function measure(): void {
        stale = false;
        measured = [];
        intoItems = new Map();
        const view = sessionView;
        // A list-item drag has no legal top-level boundary, and a closed
        // panel can never contain the pointer — skip the layout reads.
        if (!view || sessionKind !== "block" || !deps.isOpen()) {
            return;
        }
        const slots = tocDropSlots(
            deps.getHeadings(),
            view.state.doc,
            (pos) => isHiddenTargetPos(view.state, pos),
        );
        if (slots.length === 0) {
            return;
        }
        const items = Array.from(deps.list.querySelectorAll<HTMLElement>(".toc-item"));
        const itemByPos = new Map<string, HTMLElement>();
        for (const el of items) {
            const pos = el.dataset["headingPos"];
            if (pos !== undefined) {
                itemByPos.set(pos, el);
            }
        }
        const listRect = deps.list.getBoundingClientRect();
        const lastItem = items[items.length - 1];
        for (const slot of slots) {
            if (slot.kind === "into") {
                const el = itemByPos.get(String(slot.headingPos));
                if (!el) {
                    continue; // outline/DOM drift — skip rather than misaim
                }
                const rect = el.getBoundingClientRect();
                measured.push({
                    ...slot,
                    y: rect.top + rect.height / 2,
                    top: rect.top,
                    height: rect.height,
                    left: listRect.left,
                    width: listRect.width,
                });
                intoItems.set(slot.headingPos!, el);
                continue;
            }
            // A gap's pos IS its anchor heading's pos — except the terminal
            // end-of-doc slot, which sits under the last rendered item.
            const anchor = itemByPos.get(String(slot.pos));
            const y = anchor
                ? anchor.getBoundingClientRect().top
                : lastItem && slot.pos === view.state.doc.content.size
                    ? lastItem.getBoundingClientRect().bottom
                    : null;
            if (y === null) {
                continue;
            }
            measured.push({ ...slot, y, left: listRect.left, width: listRect.width });
        }
    }

    const provider: DropZoneProvider = {
        contains(x, y) {
            if (!deps.isOpen()) {
                return false;
            }
            const rect = deps.panel.getBoundingClientRect();
            return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        },
        sessionStart(view, _range, kind) {
            sessionView = view;
            sessionKind = kind;
            allowInto = ownDragPos === null;
            measure();
        },
        target(_x, y, range) {
            if (stale) {
                measure();
            }
            const slot = tocDropTargetFor(measured, y, range, { allowInto });
            if (!slot) {
                hideOwnIndicator();
                clearDropInto();
                return null;
            }
            if (slot.kind === "into") {
                const item = intoItems.get(slot.headingPos!) ?? null;
                if (item !== dropIntoItem) {
                    clearDropInto();
                    item?.classList.add("toc-item--drop-into");
                    dropIntoItem = item;
                }
                // Honest cue: an into-slot's commit pos always equals some
                // measured gap's pos (the section's end boundary — the next
                // same-or-higher heading's gap, or the terminal gap), so draw
                // the shared line THERE alongside the item wash: the wash
                // says "into this section", the line says exactly where the
                // blocks will land. A gap scrolled out of the list keeps the
                // wash but no line (same visibility rule as the gap branch).
                const gapTwin = measured.find((s) => s.kind === "gap" && s.pos === slot.pos);
                const listRect = deps.list.getBoundingClientRect();
                if (gapTwin && gapTwin.y >= listRect.top && gapTwin.y <= listRect.bottom) {
                    showDropIndicatorAt({ left: gapTwin.left, width: gapTwin.width, y: gapTwin.y });
                    indicatorShown = true;
                } else {
                    hideOwnIndicator();
                }
                return { pos: slot.pos };
            }
            clearDropInto();
            // A gap line scrolled out of the list's viewport (or under the
            // panel's top controls) is not a visible target: no chrome and
            // no commit, rather than a line floating over unrelated rows.
            const listRect = deps.list.getBoundingClientRect();
            if (slot.y < listRect.top || slot.y > listRect.bottom) {
                hideOwnIndicator();
                return null;
            }
            showDropIndicatorAt({ left: slot.left, width: slot.width, y: slot.y });
            indicatorShown = true;
            return { pos: slot.pos };
        },
        clear() {
            hideOwnIndicator();
            clearDropInto();
        },
        autoScroll(y) {
            const list = deps.list;
            const rect = list.getBoundingClientRect();
            // Clamp the zones on a short list so a dead band always exists.
            const zone = Math.min(LIST_SCROLL_ZONE, Math.floor(rect.height / 3));
            const topDepth = rect.top + zone - y;
            const bottomDepth = y - (rect.bottom - zone);
            const speed = edgeScrollVelocity(Math.max(topDepth, bottomDepth), zone);
            if (speed === 0) {
                return false;
            }
            const before = list.scrollTop;
            list.scrollTop = before + (topDepth > bottomDepth ? -speed : speed);
            if (list.scrollTop === before) {
                return false; // already at the end — geometry didn't move
            }
            // The scroll moved the list's CONTENTS by exactly the clamped
            // delta (the list box itself is fixed), so translate the cached
            // snapshot instead of re-running measure() — this runs once per
            // scrolled frame, and a full re-measure is O(items) rect reads
            // plus a doc walk. The stale path (list rebuild) keeps measure().
            const dy = before - list.scrollTop;
            for (const slot of measured) {
                slot.y += dy;
                if (slot.top !== undefined) {
                    slot.top += dy;
                }
            }
            return true;
        },
        sessionEnd() {
            sessionView = null;
            measured = [];
            intoItems = new Map();
            stale = false;
            hideOwnIndicator();
            clearDropInto();
        },
    };

    const unregister = registerDropZoneProvider(provider);

    function wireItemDrag(item: HTMLElement, entry: TocHeadingEntry): void {
        if (!entry.topLevel) {
            return;
        }
        // Only wired items advertise the grab (nested rows keep the plain
        // navigation pointer) — the cursor is the drag affordance here.
        item.classList.add("toc-item--draggable");
        item.addEventListener("mousedown", (event: MouseEvent) => {
            if (event.button !== 0) {
                return;
            }
            const view = deps.getEditorView();
            if (!view) {
                return;
            }
            // Stale outline entry (the doc moved on since the last render):
            // never arm a session against a pos that isn't a heading.
            if (view.state.doc.nodeAt(entry.pos)?.type.name !== "heading") {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            ownDragPos = entry.pos;
            // A 5px jittery click crosses the 4px drag threshold but never
            // leaves the item — a self-targeted "drag" whose target stays
            // null. Track whether the pointer ever escapes the source item's
            // mousedown-time rect so onStop can tell that micro-drag (a
            // click; navigation must survive) from a real released-in-place
            // drag (whose trailing click must stay suppressed).
            const sourceRect = item.getBoundingClientRect();
            let leftSource = false;
            const trackLeave = (move: MouseEvent): void => {
                if (
                    move.clientX < sourceRect.left || move.clientX > sourceRect.right ||
                    move.clientY < sourceRect.top || move.clientY > sourceRect.bottom
                ) {
                    leftSource = true;
                }
            };
            // Registered NOW, not in onStart: a capture listener added while
            // the threshold-crossing mousemove is already dispatching on
            // `document` would miss that very move — the one that may
            // already sit outside the item. onStop (which the session fires
            // even for a never-started drag) removes it.
            document.addEventListener("mousemove", trackLeave, true);
            startPointerDragSession(view, {
                startX: event.clientX,
                startY: event.clientY,
                resolveRange: () => {
                    const range = moveRangeAt(view, entry.pos);
                    return range
                        ? {
                            range,
                            kind: "block" as const,
                            multi: false,
                            label: tocPillLabel(entry.text),
                        }
                        : null;
                },
                onStart: () => {
                    item.dataset["dragged"] = "1";
                    item.classList.add("toc-item--drag-source");
                },
                onStop: () => {
                    document.removeEventListener("mousemove", trackLeave, true);
                    ownDragPos = null;
                    // The list may have been rebuilt mid-drag — the ghosted
                    // state lives on whichever element carries it NOW.
                    const source =
                        deps.list.querySelector<HTMLElement>(".toc-item--drag-source") ?? item;
                    source.classList.remove("toc-item--drag-source");
                    const flagged =
                        deps.list.querySelector<HTMLElement>(".toc-item[data-dragged]") ?? item;
                    if (flagged.dataset["dragged"]) {
                        if (!leftSource) {
                            // In-place micro-drag: the pointer never left the
                            // item, so the gesture IS a click — clear the flag
                            // synchronously so the trailing click navigates
                            // instead of being swallowed.
                            delete flagged.dataset["dragged"];
                        } else {
                            // Real drag: the click-suppression flag must
                            // survive until the mouse button's actual release
                            // (an Escape-cancel leaves it held), then clear
                            // one tick after the click that release produces
                            // — the wireMarkerDrag pattern in drag.ts.
                            document.addEventListener(
                                "mouseup",
                                () => setTimeout(() => {
                                    delete flagged.dataset["dragged"];
                                }, 0),
                                { once: true },
                            );
                        }
                    }
                },
            });
        });
    }

    return {
        wireItemDrag,
        dragSourceHeadingPos: () => ownDragPos,
        notifyRerender: () => {
            stale = true;
        },
        dispose: unregister,
    };
}
