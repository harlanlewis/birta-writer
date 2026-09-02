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
import type { EditorView, Node as ProseNode } from "../../pm";
import { DecorationSet, type Decoration } from "../../pm";
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
import { cachedFoldRanges, getHeadingLevel } from "./foldModel";
import { countWork } from "../../perf";
import { singleTopLevelBlockEdit, type TopLevelBlockEdit } from "../../utils/textblockEdit";

/** The fold set is rebuilt as a new object on every doc change, so equality is by members. */
function sameFoldSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
    if (a === b) return true;
    if (a.size !== b.size) return false;
    for (const pos of a) {
        if (!b.has(pos)) return false;
    }
    return true;
}

/**
 * Whether a heading at `index` owns a section: any block before the next
 * heading of its level or higher. The block right after it decides on its
 * own, because one content block is already a section and a heading of its
 * level or higher there is already the section's end, so the answer is O(1)
 * and the single-block path below can ask it per keystroke. The range it
 * returns is a stand-in whose only reader tests its truthiness (`foldable`
 * in `blockChrome`); `computeFoldRanges` is where the real extents come from.
 */
function headingSection(doc: ProseNode, index: number, level: number, headingPos: number): { from: number; to: number } | null {
    const heading = doc.child(index);
    const from = headingPos + heading.nodeSize;
    if (index + 1 >= doc.childCount) return null;
    const next = doc.child(index + 1);
    if (isHeadingNode(next) && getHeadingLevel(next) <= level) return null;
    return { from, to: from + next.nodeSize };
}

/**
 * Whether the change between two docs is confined to one top-level block
 * whose own fingerprint part is unchanged, in which case every other block's
 * chrome is exactly what it was and the structure fingerprint is the old one
 * by construction. Typing, deleting characters, marks, and the heading-id
 * restamp that follows a keystroke in a heading are all this shape; so is a
 * keystroke inside a list item, whose part is that list's item gutters. What
 * it refuses: a block that is folded on either side (its section's hidden
 * range is a document-wide fact), a heading that changed level (its
 * neighbours' sections change with it), and any edit whose block reads a
 * different part after it, such as a code block gaining its first character
 * or a paragraph gaining text beside its image.
 *
 * The part's cost is the block's own size; a heading's `foldable` flag is
 * read from its section alone rather than from a whole-document range pass.
 */
function singleBlockEditKeepsStructure(
    prev: ProseNode,
    next: ProseNode,
    folded: ReadonlySet<number>,
    enabled: boolean,
): (TopLevelBlockEdit & { section: { from: number; to: number } | null }) | null {
    const edit = singleTopLevelBlockEdit(prev, next);
    if (!edit) return null;
    const { prevBlock, nextBlock, prevBlockPos, nextBlockPos, index } = edit;
    if (folded.has(prevBlockPos) || folded.has(nextBlockPos)) return null;
    if (prevBlock.type !== nextBlock.type) return null;
    let section: { from: number; to: number } | null = null;
    let prevFoldable = false;
    let nextFoldable = false;
    if (isHeadingNode(nextBlock)) {
        if (getHeadingLevel(prevBlock) !== getHeadingLevel(nextBlock)) return null;
        const level = getHeadingLevel(nextBlock);
        prevFoldable = enabled && headingSection(prev, index, level, prevBlockPos) !== null;
        section = headingSection(next, index, level, nextBlockPos);
        nextFoldable = enabled && section !== null;
    }
    const before = blockFingerprintPart(prevBlock, prevBlockPos, folded, enabled, prevFoldable);
    const after = blockFingerprintPart(nextBlock, nextBlockPos, folded, enabled, nextFoldable);
    return before === after ? { ...edit, section } : null;
}

/** Whether a block span is inside the chrome windows (null means everywhere). */
function inChromeWindows(windows: ChromeWindows, from: number, to: number): boolean {
    if (windows === null) return true;
    return windows.some((w) => to > w.from && from < w.to);
}
import {
    persistFoldAnchors,
    readPersistedFoldAnchors,
    resolveFoldAnchors,
    seedSyntaxFolds,
} from "./foldAnchors";
import {
    blockChrome,
    blockFingerprintPart,
    buildHeadingFoldDecorations,
    structureFingerprint,
    type ChromeWindows,
} from "./foldDecorations";
import { blockMarkerElements } from "./foldGutter";
import { requestIdle } from "../../utils/idle";
import { observeVisibleWindow } from "../visibleRange";
import { isReadOnly } from "../../readOnly";

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

type Span = { from: number; to: number };

/**
 * MAR-215: the window(s) the decoration build materializes — the scroll window
 * plus, only when the caret has left it, the caret's own block. Null (the
 * whole document) whenever no window has been measured.
 */
function chromeWindows(scrollWindow: Span | null, pinned: Span | null): readonly Span[] | null {
    if (!scrollWindow) {
        return null;
    }
    return pinned ? [scrollWindow, pinned] : [scrollWindow];
}

/**
 * The caret's top-level block, or null when the caret sits inside the scroll
 * window already (the ordinary case — ProseMirror keeps the caret scrolled into
 * view). Only that case is tracked, so ordinary caret movement changes
 * nothing and the selection-only early-return still does zero work.
 */
function caretPin(state: { selection: { $head: any } }, scrollWindow: Span | null): Span | null {
    if (!scrollWindow) {
        return null;
    }
    const $head = state.selection.$head;
    if ($head.depth < 1) {
        return null;
    }
    const from = $head.before(1);
    const to = $head.after(1);
    return to > scrollWindow.from && from < scrollWindow.to ? null : { from, to };
}

function sameSpan(a: Span | null, b: Span | null): boolean {
    return a === b || (!!a && !!b && a.from === b.from && a.to === b.to);
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
                // Nothing folded is the deferrable case — including the whole
                // layer being OFF, where the chrome is pure block gutter and
                // there is by definition nothing to hide (the `enabled &&`
                // this once read made `editor.folding: false` the one
                // configuration that paid the full build synchronously).
                const deferAffordance = folded.size === 0 && canDeferAffordance();
                return {
                    folded,
                    enabled,
                    // The window is measured after first paint (see view()), so
                    // any build before that is document-wide, exactly as it was
                    // before MAR-215.
                    window: null,
                    pinned: null,
                    decorations: deferAffordance
                        ? DecorationSet.empty
                        : buildHeadingFoldDecorations(state.doc, folded, enabled),
                    fingerprint: structureFingerprint(state.doc, folded, cachedFoldRanges(state.doc), enabled),
                };
            },
            apply(tr, value, oldState, newState) {
                const meta = tr.getMeta(foldPluginKey) as FoldMeta | undefined;

                // MAR-215: the scroll window moved. Rebuild for the new window
                // (the build is windowed too, so this is O(visible blocks));
                // handled before the early-return, which would otherwise drop
                // this no-op transaction.
                if (meta?.type === "window") {
                    const nextWindow = meta.window;
                    const pinned = caretPin(newState, nextWindow);
                    if (sameSpan(nextWindow, value.window) && sameSpan(pinned, value.pinned)) {
                        return value;
                    }
                    const windows = chromeWindows(nextWindow, pinned);
                    return {
                        ...value,
                        window: nextWindow,
                        pinned,
                        decorations: buildHeadingFoldDecorations(newState.doc, value.folded, value.enabled, windows),
                        fingerprint: structureFingerprint(
                            newState.doc, value.folded, cachedFoldRanges(newState.doc), value.enabled, windows,
                        ),
                    };
                }

                // MAR-189: the deferred post-paint affordance build. No fold/doc
                // state change — just materialize the decorations init skipped.
                // Handled before the selection-only early-return below (which
                // would otherwise drop this no-op transaction and never build).
                if (meta?.type === "buildAffordance") {
                    const windows = chromeWindows(value.window, value.pinned);
                    return {
                        ...value,
                        decorations: buildHeadingFoldDecorations(
                            newState.doc, value.folded, value.enabled, windows,
                        ),
                        fingerprint: structureFingerprint(
                            newState.doc, value.folded, cachedFoldRanges(newState.doc), value.enabled, windows,
                        ),
                    };
                }
                let folded: ReadonlySet<number> = value.folded;
                let enabled = value.enabled;
                // The window is measured in layout coordinates but stored in
                // DOCUMENT coordinates, so it must travel with the content it
                // was measured against — otherwise an insertion above the
                // viewport slides the decorated band off the reader's screen
                // until the next scroll recommit.
                const scrollWindow = tr.docChanged && value.window
                    ? { from: tr.mapping.map(value.window.from, -1), to: tr.mapping.map(value.window.to, 1) }
                    : value.window;

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

                // MAR-215: the keyboard block menu opens against a rendered
                // marker at the caret, so a caret that has left the scroll
                // window pins its own block into the build. Tracked only while
                // it IS outside — on screen (the ordinary case) this stays
                // null, so the early-return below still fires for every
                // ordinary caret move.
                const pinned = caretPin(newState, scrollWindow);

                // Selection-only transaction, nothing folded/unfolded, caret
                // still inside the materialized region: the state is untouched
                // — zero decoration work per caret move.
                if (
                    !tr.docChanged && folded === value.folded && enabled === value.enabled &&
                    sameSpan(pinned, value.pinned)
                ) {
                    return value;
                }

                const windows = chromeWindows(scrollWindow, pinned);
                // An edit confined to one textblock's inline content (typing,
                // deleting characters, marks) changes no block boundary, no
                // heading level and no fold range, so the fingerprint is the
                // old one by construction and computing it would walk every
                // top-level block for a known answer (MAR-431). The mapped set
                // stands, under the same count check the equal-fingerprint
                // path below applies; a mapping that lost a decoration falls
                // through to the rebuild.
                const leafEdit = tr.docChanged && enabled === value.enabled && sameSpan(pinned, value.pinned) &&
                    sameFoldSet(folded, value.folded)
                    ? singleBlockEditKeepsStructure(oldState.doc, newState.doc, folded, enabled)
                    : null;
                if (leafEdit) {
                    countWork("fold-structure", { blocks: 1 });
                    const mapped = value.decorations.map(tr.mapping, newState.doc);
                    if (mapped.find().length === value.decorations.find().length) {
                        return { ...value, window: scrollWindow, pinned, decorations: mapped };
                    }
                    // The mapping caveat below, for the one block this edit
                    // replaced (the heading-id restamp is the everyday case):
                    // its chrome is rebuilt alone into the mapped set. Only
                    // for a block in the window and not hidden inside a
                    // collapsed section (its hidden class is a document-wide
                    // fact this rebuild does not know), so the chrome it
                    // gets is exactly what the full build would give it;
                    // anything else falls through to that build.
                    const { nextBlockPos: pos, nextBlock: node, prevBlockPos, prevBlock, section } = leafEdit;
                    const end = pos + node.nodeSize;
                    const wasHidden = value.decorations
                        .find(prevBlockPos + 1, prevBlockPos + prevBlock.nodeSize - 1)
                        .some((d) => String((d as unknown as { type: { attrs?: { class?: string } } }).type.attrs?.class ?? "").includes("heading-fold-hidden"));
                    if (!wasHidden && inChromeWindows(windows, pos, end)) {
                        const cleaned = mapped.remove(mapped.find(pos + 1, end - 1));
                        const fresh: Decoration[] = [];
                        const ranges = new Map([[pos, section]]);
                        blockChrome(node, pos, fresh, folded, enabled, ranges);
                        countWork("fold-build", { blocks: 1 });
                        return {
                            ...value,
                            window: scrollWindow,
                            pinned,
                            decorations: fresh.length ? cleaned.add(newState.doc, fresh) : cleaned,
                        };
                    }
                }
                const fingerprint = structureFingerprint(
                    newState.doc,
                    folded,
                    cachedFoldRanges(newState.doc),
                    enabled,
                    windows,
                );
                if (fingerprint === value.fingerprint && sameSpan(pinned, value.pinned)) {
                    if (!tr.docChanged) {
                        return { ...value, folded, enabled, window: scrollWindow, pinned, fingerprint };
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
                        return { folded, enabled, window: scrollWindow, pinned, fingerprint, decorations: mapped };
                    }
                }
                return {
                    folded,
                    enabled,
                    window: scrollWindow,
                    pinned,
                    fingerprint,
                    decorations: buildHeadingFoldDecorations(newState.doc, folded, enabled, windows),
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
            const st = foldPluginKey.getState(view.state);
            const deferredPending =
                !!st && st.folded.size === 0 &&
                st.decorations.find().length === 0 && canDeferAffordance();

            // MAR-215: keep the gutter chrome scoped to what is (nearly) on
            // screen. The observer is inert until start() — see its header for
            // why. Both it and MAR-189's deferred build run in ONE post-paint
            // idle callback, in that order, so the window is already known when
            // the affordance is built: one windowed build, and not a single
            // decoration rendered before `editor-painted`.
            //
            // Do NOT schedule the observer independently, on its own animation
            // frame: measuring and rebuilding are cheap, but doing so moves the
            // chrome's DOM insertion and paint in FRONT of the paint mark. That
            // is a launch regression the CI gate catches, and it lands entirely
            // in the create-end → editor-painted gap (the `paint` span in
            // e2e/perf/verdict.mjs).
            let windowCommitted = false;
            const visibleWindow = observeVisibleWindow(view, (next) => {
                if (disposed || view.isDestroyed) { return; }
                windowCommitted = true;
                view.dispatch(
                    view.state.tr
                        .setMeta(foldPluginKey, { type: "window", window: next })
                        .setMeta("addToHistory", false),
                );
            });
            const deferredBuild = requestIdle(() => {
                if (disposed || view.isDestroyed) { return; }
                // A committed window rebuilds the decorations itself, so it IS
                // the deferred affordance build; the explicit meta is only
                // needed when no window could be measured (no layout engine).
                visibleWindow.start();
                if (deferredPending && !windowCommitted) {
                    view.dispatch(
                        view.state.tr
                            .setMeta(foldPluginKey, { type: "buildAffordance" })
                            .setMeta("addToHistory", false),
                    );
                }
            }, 500);

            // Multi-block selection discoverability: while the selection
            // spans several top-level blocks, their markers surface at
            // resting contrast — "drag any of these and they all move".
            // Classes go on the MARKER (widget DOM — invisible to PM's
            // observer); mutating the block elements would redraw them.
            //
            // Incremental: the covered markers are held PER BLOCK OFFSET, so
            // a selection change touches only the blocks that entered or
            // left the cover — a marquee or Shift+Arrow changes the cover on
            // every event, and reading every covered block each time scaled
            // with the selection. A doc change invalidates the held entries
            // wholesale (the offsets are doc positions). A new decoration
            // set invalidates only the entries it could have changed: a
            // rebuild keeps same-key widget DOM, so a block whose markers
            // are all still connected is left alone, and a block that held
            // none (off the chrome window until now) or whose marker was
            // swapped is re-read — that is how a covered block scrolling
            // into the window surfaces its marker.
            let coveredByBlock = new Map<number, HTMLElement[]>();
            let coverDoc: unknown = null;
            let coverDecorations: unknown = null;
            let coverKey = "";
            const uncover = (markers: HTMLElement[]): void => {
                markers.forEach((m) => m.classList.remove("heading-fold-marker--covered"));
            };
            const clearCover = (): void => {
                for (const markers of coveredByBlock.values()) {
                    uncover(markers);
                }
                coveredByBlock = new Map();
            };
            /** Surface (and hold) the markers of the top-level block at `offset`. */
            const coverBlock = (offset: number): void => {
                const markers: HTMLElement[] = [];
                const dom = view.nodeDOM(offset);
                if (dom instanceof HTMLElement) {
                    // querySelectorAll: a covered LIST carries one marker
                    // per item — every one must surface, not just the
                    // first, or "all of these move together" undersells.
                    // Container CHILDREN stay quiet though: the
                    // container's own marker is the "this moves" cue,
                    // and child markers now drag their own block, not
                    // the cover. A leaf atom's marker is its next
                    // sibling, which blockMarkerElements knows; a NESTED
                    // leaf's sits beside its --child host rather than
                    // inside it, so the child test also reads the gutter's
                    // own --nested class.
                    for (const markerEl of blockMarkerElements(dom)) {
                        if (markerEl.closest(".block-gutter-host--child, .heading-fold-gutter--nested")) {
                            continue;
                        }
                        markerEl.classList.add("heading-fold-marker--covered");
                        markers.push(markerEl);
                    }
                }
                coveredByBlock.set(offset, markers);
            };
            const syncSelectionCover = (): void => {
                // A drag in flight owns the singleton indicator (drag-mode
                // veil); an external-sync transaction mid-drag must not
                // repaint it as the selection tint — stop() reconciles.
                if (document.body.classList.contains("block-dragging")) {
                    return;
                }
                // Read-only shows no block-range tint and reveals no covered
                // markers: both advertise a move that the mode refuses.
                const cover = isReadOnly() ? null : selectionCoverRange(view);
                const key = cover ? `${cover.from}:${cover.to}` : "";
                const { doc } = view.state;
                const decorations = foldPluginKey.getState(view.state)?.decorations ?? null;
                if (doc !== coverDoc) {
                    clearCover();
                    coverDoc = doc;
                }
                if (decorations !== coverDecorations) {
                    coverDecorations = decorations;
                    for (const [offset, markers] of coveredByBlock) {
                        if (markers.length === 0 || markers.some((m) => !m.isConnected)) {
                            uncover(markers);
                            coveredByBlock.delete(offset);
                        }
                    }
                }
                if (key !== coverKey) {
                    coverKey = key;
                    // One visual language for "these blocks are included":
                    // the same veil the drag uses dims the covered range live
                    // while the multi-block selection exists (MAR-85).
                    if (cover) {
                        showRangeVeil(view, cover, "select");
                    } else {
                        hideRangeVeil();
                    }
                }
                if (!cover) {
                    if (coveredByBlock.size > 0) {
                        clearCover();
                    }
                    return;
                }
                // Blocks that left the cover.
                for (const [offset, markers] of coveredByBlock) {
                    if (offset < cover.from || offset >= cover.to) {
                        uncover(markers);
                        coveredByBlock.delete(offset);
                    }
                }
                // Blocks that entered it; the held ones cost no DOM read.
                // Walked from the cover's own start, never from the top of
                // the document: this runs on every selection change.
                let { index, offset } = doc.childAfter(Math.min(cover.from, doc.content.size));
                let blocks = 0;
                for (; index < doc.childCount && offset < cover.to; index++) {
                    blocks++;
                    if (offset >= cover.from && !coveredByBlock.has(offset)) {
                        coverBlock(offset);
                    }
                    offset += doc.child(index).nodeSize;
                }
                countWork("fold-cover", { blocks });
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
                // Check before writing: classList.add re-writes the class
                // attribute even when the class is already present, and every
                // body-class MutationObserver wakes on that write — one of them
                // measures the topbar, which forces a layout. This is the
                // hottest handler in the editor (every keydown), so the write
                // has to be conditional, not just idempotent (MAR-266).
                if (!document.body.classList.contains("handles-quiet")) {
                    document.body.classList.add("handles-quiet");
                }
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
                    visibleWindow.destroy();
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
