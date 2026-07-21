/**
 * webview/plugins/headingFold/plugin.ts
 *
 * The fold plugin itself: the init/apply state machine (fold set + cached
 * decoration set + structural fingerprint), the fold-meta handling
 * (toggle/set/setMany/foldAll/unfoldAll/setEnabled/move/delete), the caret
 * skip-over appendTransaction, and the view layer (section hover highlight,
 * multi-block selection cover, persistence writes). Pure logic lives in
 * ./foldModel, persistence in ./foldAnchors, rendering in ./foldDecorations —
 * this module wires them to ProseMirror.
 */
import type { EditorView } from "../../pm";
import { DecorationSet } from "../../pm";
import { Plugin, Selection } from "../../pm";
import { $prose } from "@milkdown/utils";
import { foldingEnabled } from "../../utils/foldingControls";
// Menu close and marquee wiring are late-bound handles (the block-menu
// component registers them at load; see plugins/blockHandles.ts) — the
// plugin layer never imports component modules. The veil is the editing
// layer's shared range indicator, and the multi-block cover query lives in
// the fold model.
import { blockHandles } from "../blockHandles";
import { hideRangeVeil, showRangeVeil } from "../../editing/rangeIndicator";
import { foldPluginKey, type FoldMeta, type FoldPluginState } from "../foldState";
import {
    allFoldablePositions,
    cleanFoldedPositions,
    computeFoldRanges,
    findSectionHeadingPosAt,
    foldHiddenRange,
    foldedHiddenRanges,
    hiddenRangeCoversTarget,
    isFoldEntryAt,
    isHeadingNode,
    relocationChangedHiddenContent,
    selectionCoverRange,
    swallowedVisibleContent,
} from "./foldModel";
import {
    persistFoldAnchors,
    readPersistedFoldAnchors,
    resolveFoldAnchors,
    seedSyntaxFolds,
} from "./foldAnchors";
import { buildHeadingFoldDecorations, structureFingerprint } from "./foldDecorations";
import { requestIdle } from "../../utils/idle";

/**
 * MAR-189: whether we can defer the affordance decoration build off the mount
 * path. Requires a real post-paint scheduler (`requestIdleCallback`); without
 * one — jsdom under the unit tests — we build eagerly, preserving the
 * synchronous "decorations exist right after create" contract the fold tests
 * assert against.
 */
function canDeferAffordance(): boolean {
    return typeof (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback === "function";
}

function isHeadingElement(element: Element | null): element is HTMLElement {
    return element instanceof HTMLElement && element.matches("h1,h2,h3,h4,h5,h6");
}

function getHeadingGutter(heading: HTMLElement | null): HTMLElement | null {
    return heading?.querySelector<HTMLElement>(".heading-fold-gutter--foldable") ?? null;
}

function getHeadingElementAtPos(view: EditorView, pos: number): HTMLElement | null {
    const dom = view.nodeDOM(pos);
    return isHeadingElement(dom as Element | null) ? dom as HTMLElement : null;
}

export const headingFoldPlugin = $prose(() =>
    new Plugin<FoldPluginState>({
        key: foldPluginKey,
        state: {
            init: (_config, state) => {
                // `editor.folding: false` disables the layer wholesale: no
                // seeds, no restore, zero fold chrome in the decorations.
                const enabled = foldingEnabled();
                let folded: Set<number> = new Set();
                if (enabled) {
                    // Persisted view state wins when present (it is the full
                    // fold state, including "user expanded a [!kind]- callout");
                    // a first open seeds from the syntax defaults (T1).
                    const persisted = readPersistedFoldAnchors();
                    folded = persisted
                        ? resolveFoldAnchors(state.doc, persisted)
                        : seedSyntaxFolds(state.doc);
                }
                // MAR-189: with nothing folded the decorations are PURE
                // affordance (per-heading chevrons; no content hidden), so keep
                // their O(blocks) build — the dominant slice of `create` on
                // heading-heavy docs — off the mount path; view() builds it after
                // first paint. When folds ARE present the content-hiding
                // decorations must exist at first paint or folded content would
                // flash, so build synchronously.
                const deferAffordance = enabled && folded.size === 0 && canDeferAffordance();
                return {
                    folded,
                    enabled,
                    decorations: deferAffordance
                        ? DecorationSet.empty
                        : buildHeadingFoldDecorations(state.doc, folded, enabled),
                    fingerprint: structureFingerprint(state.doc, folded, computeFoldRanges(state.doc), enabled),
                };
            },
            apply(tr, value, oldState, newState) {
                const meta = tr.getMeta(foldPluginKey) as FoldMeta | undefined;

                // MAR-189: the deferred post-paint affordance build. No fold/doc
                // state change — just materialize the decorations init skipped.
                // Handled before the selection-only early-return below (which
                // would otherwise drop this no-op transaction and never build).
                if (meta?.type === "buildAffordance") {
                    return {
                        ...value,
                        decorations: buildHeadingFoldDecorations(newState.doc, value.folded, value.enabled),
                    };
                }
                let folded: ReadonlySet<number> = value.folded;
                let enabled = value.enabled;

                if (tr.docChanged) {
                    const move = meta?.type === "move" ? meta : null;
                    const del = meta?.type === "delete" ? meta : null;
                    const next = new Set<number>();
                    for (const pos of value.folded) {
                        // Entries inside a moved range travel with the
                        // content to its new location — unless the fold
                        // hides DIFFERENT content there than it did before
                        // (MAR-156).
                        if (move && pos >= move.from && pos < move.to) {
                            const relocated = move.insertAt + (pos - move.from);
                            if (
                                isFoldEntryAt(newState.doc, relocated) &&
                                !relocationChangedHiddenContent(oldState.doc, newState.doc, pos, relocated)
                            ) {
                                next.add(relocated);
                            }
                            continue;
                        }
                        // Entries inside a deleted block die with it.
                        if (del && pos >= del.from && pos < del.to) {
                            continue;
                        }
                        // Forward assoc: an entry must FOLLOW its block when
                        // content is inserted exactly at the block's start
                        // (duplicating the block above, dropping a section
                        // there). Backward assoc left the entry at the old
                        // offset — the newly inserted block inherited the
                        // collapse while the real block expanded.
                        // DELETED positions never survive the map: plain
                        // map() lands them at the replacement's end, where a
                        // DIFFERENT foldable can sit — Tab-sinking a folded
                        // item rebuilds it via replaceWith and the stale
                        // entry silently collapsed the NEXT sibling. Edits
                        // that rebuild a folded block therefore CLEAR its
                        // fold; a move that should preserve it must say so
                        // through the move meta above.
                        const mapped = tr.mapping.mapResult(pos);
                        if (!mapped.deleted && isFoldEntryAt(newState.doc, mapped.pos)) {
                            // An edit that grew this section over content it
                            // didn't hide before expands it, rather than
                            // burying blocks the user never touched.
                            if (swallowedVisibleContent(tr, oldState.doc, newState.doc, pos, mapped.pos)) {
                                continue;
                            }
                            next.add(mapped.pos);
                        }
                    }
                    folded = cleanFoldedPositions(newState.doc, next);
                }

                switch (meta?.type) {
                    case "toggle": {
                        const next = new Set<number>(folded);
                        if (next.has(meta.pos)) {
                            next.delete(meta.pos);
                        } else if (enabled && foldHiddenRange(newState.doc, meta.pos)) {
                            next.add(meta.pos);
                        }
                        folded = next;
                        break;
                    }
                    case "set":
                    case "setMany": {
                        const positions = meta.type === "set" ? [meta.pos] : meta.positions;
                        const next = new Set<number>(folded);
                        for (const pos of positions) {
                            if (!meta.folded) {
                                next.delete(pos);
                            } else if (enabled && foldHiddenRange(newState.doc, pos)) {
                                next.add(pos);
                            }
                        }
                        folded = next;
                        break;
                    }
                    case "foldAll":
                        if (enabled) {
                            folded = new Set(allFoldablePositions(newState.doc));
                        }
                        break;
                    case "unfoldAll":
                        folded = new Set();
                        break;
                    case "setEnabled":
                        enabled = meta.enabled;
                        if (!enabled) {
                            // The layer going off expands every UI-only fold.
                            folded = new Set();
                        }
                        break;
                }

                // Selection-only transaction, nothing folded/unfolded: the
                // state is untouched — zero decoration work per caret move.
                if (!tr.docChanged && folded === value.folded && enabled === value.enabled) {
                    return value;
                }

                const fingerprint = structureFingerprint(
                    newState.doc,
                    folded,
                    computeFoldRanges(newState.doc),
                    enabled,
                );
                if (fingerprint === value.fingerprint) {
                    if (!tr.docChanged) {
                        return { folded, enabled, fingerprint, decorations: value.decorations };
                    }
                    // Structure (and therefore every rendered gutter) is
                    // unchanged — just map positions; widget DOM survives.
                    // CAVEAT: mapping DESTROYS decorations on a replaced node
                    // even when the replacement is structure-neutral (e.g.
                    // headingIds stamping an id attr via setNodeMarkup), so
                    // fall back to a rebuild whenever the map lost any —
                    // identical structure implies an identical count.
                    const mapped = value.decorations.map(tr.mapping, newState.doc);
                    if (mapped.find().length === value.decorations.find().length) {
                        return { folded, enabled, fingerprint, decorations: mapped };
                    }
                }
                return {
                    folded,
                    enabled,
                    fingerprint,
                    decorations: buildHeadingFoldDecorations(newState.doc, folded, enabled),
                };
            },
        },
        /**
         * Caret skip-over (VS Code semantics): a bare caret must never rest
         * inside a hidden range — vertical motion, Home/End, or programmatic
         * selection landing there is mapped just past the fold, in the
         * direction of travel. Explicit entry intents unfold FIRST
         * (revealPosition), so this only catches accidental entries.
         */
        appendTransaction(_trs, oldState, newState) {
            const pluginState = foldPluginKey.getState(newState);
            if (!pluginState?.enabled || pluginState.folded.size === 0) {
                return null;
            }
            const sel = newState.selection;
            if (!sel.empty) {
                return null;
            }
            const pos = sel.from;
            // Kind-aware coverage (hiddenRangeCoversTarget): interior-hiding
            // kinds are INCLUSIVE at `to` — for a folded code block `to` is
            // the fence text's last position, a spot ArrowLeft from below
            // lands on, and half-open `pos < r.to` let the caret rest (and
            // type) there invisibly.
            const doc = newState.doc;
            const containing = foldedHiddenRanges(newState).filter(
                (r) => hiddenRangeCoversTarget(doc, r, pos),
            );
            if (containing.length === 0) {
                return null;
            }
            // Eject targets come from the OWNING node's edges, not the raw
            // hidden range: an interior kind's `from`/`to` are positions
            // INSIDE the collapsed node, and inside a code block
            // Selection.near returns them unchanged — the "escape" would
            // land back in hidden content. A heading hides FOLLOWING
            // siblings, so its range ends are already visible boundaries.
            const edges = containing.map((r) =>
                isHeadingNode(doc.nodeAt(r.pos))
                    ? { before: r.from, after: r.to }
                    : { before: r.pos, after: r.pos + doc.nodeAt(r.pos)!.nodeSize });
            const before = Math.min(...edges.map((e) => e.before));
            const after = Math.max(...edges.map((e) => e.after));
            const forward = pos >= oldState.selection.from;
            const target =
                forward && after < doc.content.size
                    ? Selection.near(doc.resolve(after), 1)
                    : Selection.near(doc.resolve(before), -1);
            if (target.eq(sel)) {
                return null;
            }
            return newState.tr.setSelection(target).setMeta("addToHistory", false);
        },
        props: {
            decorations(state) {
                return foldPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
            },
        },
        view(view) {
            let hoveredGutter: HTMLElement | null = null;

            // MAR-189: materialize the affordance decorations init deferred, in
            // an idle window after first paint (never synchronously in create).
            // Re-derive the deferred signature from live state rather than a
            // one-shot init flag: Milkdown runs setup transactions between the
            // plugin's state.init and this view(), and a plain flag would already
            // have been dropped by then (the apply paths don't carry it),
            // leaving the build unscheduled — chevrons that never appear.
            let disposed = false;
            let deferredBuild: { cancel: () => void } | null = null;
            const st = foldPluginKey.getState(view.state);
            const deferredPending =
                !!st && st.enabled && st.folded.size === 0 &&
                st.decorations.find().length === 0 && canDeferAffordance();
            if (deferredPending) {
                deferredBuild = requestIdle(() => {
                    if (disposed) { return; }
                    view.dispatch(
                        view.state.tr
                            .setMeta(foldPluginKey, { type: "buildAffordance" })
                            .setMeta("addToHistory", false),
                    );
                }, 500);
            }

            // Multi-block selection discoverability: while the selection
            // spans several top-level blocks, their markers surface at
            // resting contrast — "drag any of these and they all move".
            // Classes go on the MARKER (widget DOM — invisible to PM's
            // observer); mutating the block elements would redraw them.
            let coveredMarkers: HTMLElement[] = [];
            let coverKey = "";
            const syncSelectionCover = (): void => {
                // A drag in flight owns the singleton indicator (drag-mode
                // veil); an external-sync transaction mid-drag must not
                // repaint it as the selection tint — stop() reconciles.
                if (document.body.classList.contains("block-dragging")) {
                    return;
                }
                const cover = selectionCoverRange(view);
                const key = cover ? `${cover.from}:${cover.to}` : "";
                if (key === coverKey && coveredMarkers.every((m) => m.isConnected)) {
                    return;
                }
                coverKey = key;
                coveredMarkers.forEach((m) => m.classList.remove("heading-fold-marker--covered"));
                coveredMarkers = [];
                // One visual language for "these blocks are included": the
                // same veil the drag uses dims the covered range live while
                // the multi-block selection exists (MAR-85).
                if (cover) {
                    showRangeVeil(view, cover, "select");
                } else {
                    hideRangeVeil();
                }
                if (!cover) {
                    return;
                }
                view.state.doc.forEach((node: any, offset: number) => {
                    if (offset < cover.from || offset >= cover.to) {
                        return;
                    }
                    const dom = view.nodeDOM(offset);
                    if (dom instanceof HTMLElement) {
                        // querySelectorAll: a covered LIST carries one marker
                        // per item — every one must surface, not just the
                        // first, or "all of these move together" undersells.
                        // Container CHILDREN stay quiet though: the
                        // container's own marker is the "this moves" cue,
                        // and child markers now drag their own block, not
                        // the cover.
                        for (const markerEl of dom.querySelectorAll<HTMLElement>(".heading-fold-marker")) {
                            if (markerEl.closest(".block-gutter-host--child")) {
                                continue;
                            }
                            markerEl.classList.add("heading-fold-marker--covered");
                            coveredMarkers.push(markerEl);
                        }
                    }
                });
            };

            const clearHoveredGutter = () => {
                hoveredGutter?.classList.remove("heading-fold-gutter--section-hover");
                hoveredGutter = null;
            };

            const setHoveredGutter = (gutter: HTMLElement | null) => {
                if (gutter === hoveredGutter) {
                    return;
                }
                clearHoveredGutter();
                hoveredGutter = gutter;
                hoveredGutter?.classList.add("heading-fold-gutter--section-hover");
            };

            // Quiet-while-typing (the BlockNote/Tiptap/Crepe convention): any
            // keydown in the editor suppresses the hover-revealed block
            // handles so the gutter never flickers alongside the caret; the
            // next mouse motion brings them back.
            const handleKeyDown = () => {
                document.body.classList.add("handles-quiet");
            };

            const handleMouseMove = (event: MouseEvent) => {
                document.body.classList.remove("handles-quiet");
                const target = event.target as Element | null;
                const directHeading = target?.closest("h1,h2,h3,h4,h5,h6") ?? null;
                if (directHeading && view.dom.contains(directHeading)) {
                    setHoveredGutter(getHeadingGutter(isHeadingElement(directHeading) ? directHeading : null));
                    return;
                }

                const coords = view.posAtCoords({
                    left: event.clientX,
                    top: event.clientY,
                });
                const headingPos = coords ? findSectionHeadingPosAt(view, coords.pos) : null;
                setHoveredGutter(headingPos === null ? null : getHeadingGutter(getHeadingElementAtPos(view, headingPos)));
            };

            view.dom.addEventListener("mousemove", handleMouseMove);
            view.dom.addEventListener("mouseleave", clearHoveredGutter);
            view.dom.addEventListener("keydown", handleKeyDown);
            const disposeMarquee = blockHandles().wireMarquee(view);

            return {
                update(updatedView, prevState) {
                    // Any document change invalidates an open block menu's
                    // captured position (and may destroy its anchor marker) —
                    // close it. Selection-only transactions keep the same doc
                    // node, so this never fires for caret movement.
                    if (updatedView.state.doc !== prevState.doc) {
                        blockHandles().closeBlockMenu();
                    }
                    // T2 persistence: write structural anchors into the
                    // webview state bag whenever the fold set changes (or a
                    // doc edit shifts what existing anchors point at) — the
                    // same bag as scrollY/fmCollapsed, so folds survive the
                    // tab-hide webview teardown.
                    const foldState = foldPluginKey.getState(updatedView.state);
                    const prevFoldState = foldPluginKey.getState(prevState);
                    if (
                        foldState && prevFoldState && foldState.enabled &&
                        (foldState.folded !== prevFoldState.folded ||
                            (updatedView.state.doc !== prevState.doc && foldState.folded.size > 0))
                    ) {
                        persistFoldAnchors(updatedView.state);
                    }
                    syncSelectionCover();
                    if (hoveredGutter && !view.dom.contains(hoveredGutter)) {
                        hoveredGutter = null;
                    }
                },
                destroy() {
                    disposed = true;
                    deferredBuild?.cancel();
                    view.dom.removeEventListener("mousemove", handleMouseMove);
                    view.dom.removeEventListener("mouseleave", clearHoveredGutter);
                    view.dom.removeEventListener("keydown", handleKeyDown);
                    document.body.classList.remove("handles-quiet");
                    disposeMarquee();
                    // A selection-cover veil must not outlive its editor
                    // (revert/reload recreates the view; the fresh plugin's
                    // first sync would otherwise early-return and leave the
                    // stale veil painted over the new document).
                    hideRangeVeil();
                    clearHoveredGutter();
                },
            };
        },
    }),
);
