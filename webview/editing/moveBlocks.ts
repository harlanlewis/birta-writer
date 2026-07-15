/**
 * editing/moveBlocks.ts
 *
 * THE structural block-move primitive (MAR-112, data-fidelity design §4
 * "Layer 2"). Every mover routes through `moveBlocks`: the gutter drag
 * (components/blockMenu/drag), the block menu's Move rows and `moveBlockAt`,
 * and the keyboard moves (plugins/blockKeys). Table row/column reorder stays
 * separate — it rebuilds the table from the same node objects (conservation
 * by construction) and carries its own content-guard tag.
 *
 * The hardened contract, each clause an explicit check in code:
 *
 * 1. ATOMIC + VETO-AWARE — one transaction, one undo step, tagged for the
 *    content-conservation guard (plugins/contentGuard). `view.dispatch`
 *    returns nothing, so after dispatch the doc identity is compared: on a
 *    guard veto the primitive skips the landing flash (its positions would
 *    describe a document that was never created) and returns false, so
 *    drag/menu/keyboard callers report truthfully.
 * 2. SOURCE RANGE INTEGRITY — the source must be a contiguous run of WHOLE
 *    child nodes under one resolved parent. A malformed range (the
 *    historical fe6a1fe class: section semantics applied to a nested
 *    heading produced a range ending outside its container, and deleteRange
 *    destroyed content that was never re-inserted) is refused LOUDLY — dev
 *    console.error plus a no-op — instead of trusted.
 * 3. EXPLICIT FIT — the target must be a node boundary whose parent
 *    `canReplace`s the exact fragment at that index, verified BEFORE any
 *    transaction exists. Implicit `replaceStep` fitting is never relied on:
 *    that is where silent wraps, splits (the code-block-split class the
 *    guard used to catch as the last line of defense), and silent no-ops
 *    live. The ONLY allowed normalization is `deleteRange` dissolving a
 *    parent the move emptied (a list losing its last item). Nothing else:
 *    no retyping nodes to fit, no attr drops, no dissolving non-empty
 *    containers.
 *
 *    The clause forbids IMPLICIT rewrites — content silently reshaped to
 *    make a drop fit. It does not forbid a transformation the CALLER asked
 *    for: `relevelDelta` shifts the moved headings' ranks (MAR-81's blanket
 *    "no heading re-leveling" is reversed — the TOC outline is a structural
 *    editor as well as a view, so an outline drop's position is the user's
 *    stated intent, not a fitting artifact). It is opt-in, declared at the
 *    call site, applied before the fit check, and rides the SAME transaction
 *    so a drag stays one undo step.
 * 4. TARGET LEGALITY IS STRUCTURAL — targets inside any fold-hidden range
 *    (collapsed heading sections AND collapsed callout bodies) are rejected
 *    through the same `isHiddenTargetPos` registry the drag UI's slot
 *    filter consumes, so UI slots and primitive legality cannot drift.
 * 5. SIDE-STATE RIDES ALONG — the fold plugin's move meta travels inside
 *    the primitive, so a collapsed section stays collapsed at its
 *    destination and nothing else inherits its fold.
 *
 * v1 scope: ONE contiguous source range. Non-contiguous multi-range moves
 * (a future marquee/Cmd-click extension) are explicitly out of scope.
 */
import type { EditorView } from "@milkdown/prose/view";
import { Fragment, type Node as ProseNode } from "@milkdown/prose/model";
import { TextSelection } from "@milkdown/prose/state";
import { BlockRangeSelection } from "../plugins/blockRange";
import { headingFoldPluginKey, type HeadingFoldMeta } from "../plugins/foldState";
// Runtime-only cycle (moveBlocks → headingFold → blockMenu → moveBlocks):
// isHiddenTargetPos is only called inside the function body, matching the
// established contentGuard ↔ headingFold precedent.
import { isHiddenTargetPos } from "../plugins/headingFold";
import { markerKeyOf, tagContentGuard } from "../plugins/contentGuard";
import { flashRange } from "../components/blockMenu/rangeIndicator";

export interface MoveBlocksOptions {
    /** Keep the moved run selected after the drop (multi-block drags — the
     * Tiptap post-drop convention); default is a caret at the destination. */
    selectRun?: boolean;
    /**
     * Shift every heading in the moved run by this many ranks, clamped to
     * H1–H6 (see clause 3). Opt-in and caller-declared: only the TOC's
     * outline drops pass it, because only there does the drop position carry
     * structural intent. Omit / 0 for a literal move.
     */
    relevelDelta?: number;
}

/** Heading ranks a relevel may produce — markdown has no H0 or H7. */
const MIN_HEADING_LEVEL = 1;
const MAX_HEADING_LEVEL = 6;

/**
 * `nodes` with every heading's rank shifted by `delta`, clamped to H1–H6.
 * Non-heading nodes and a zero/no-op delta pass through by identity, so the
 * common (literal-move) path allocates nothing.
 *
 * Clamping is per node, so a subtree deep enough to overflow flattens at the
 * floor instead of blocking the drop. This is content-guard-invisible by
 * construction: the fingerprint counts `count:heading` and text leaves, and a
 * rank lives in an attr — so a relevel conserves the fingerprint exactly and
 * the move stays VETO-mode-safe (contentGuard.fingerprintDoc).
 */
function relevelHeadings(nodes: readonly ProseNode[], delta: number): readonly ProseNode[] {
    if (delta === 0) {
        return nodes;
    }
    return nodes.map((node) => {
        if (node.type.name !== "heading") {
            return node;
        }
        const current = typeof node.attrs["level"] === "number" ? (node.attrs["level"] as number) : 1;
        const next = Math.min(Math.max(current + delta, MIN_HEADING_LEVEL), MAX_HEADING_LEVEL);
        if (next === current) {
            return node;
        }
        // Preserve every other attr (the TOC-anchor id among them) — only the
        // rank changes, matching setHeadingLevelAt's heading→heading contract.
        return node.type.create({ ...node.attrs, level: next }, node.content, node.marks);
    });
}

/** Loud structural refusal: every caller handed us something the contract
 * forbids — a bug to report, not a user gesture to swallow silently. */
function refuse(reason: string): false {
    console.error(`[moveBlocks] refused: ${reason}`);
    return false;
}

/**
 * Move the contiguous block run `source` so it starts at boundary
 * `targetPos`, as a single guarded transaction (one undo step). Returns
 * false — with the document untouched — for no-op targets (inside/adjacent
 * to the source, the "put it back" gesture), for contract violations
 * (loudly, see the module header), and on a content-guard veto.
 */
export function moveBlocks(
    view: EditorView,
    source: { from: number; to: number },
    targetPos: number,
    opts?: MoveBlocksOptions,
): boolean {
    const relevelDelta = opts?.relevelDelta ?? 0;
    // Put-it-back gesture — a quiet no-op, never an error. The exception is a
    // drop AT the source's own start that also relevels: the run does not
    // move, but its headings' ranks change, so it is a real edit (the TOC's
    // "make this section a child of the one above it" gesture). Anything
    // deeper inside the range stays a no-op: a run cannot land within itself.
    const inPlaceRelevel = targetPos === source.from && relevelDelta !== 0;
    if (!inPlaceRelevel && targetPos >= source.from && targetPos <= source.to) {
        return false;
    }
    const { doc } = view.state;
    // The pre-move selection, captured before the transaction so a single
    // move can restore the caret at its offset WITHIN the moved block (below).
    const preMoveSel = view.state.selection;
    if (source.from < 0 || source.to > doc.content.size || targetPos < 0 || targetPos > doc.content.size) {
        return refuse(`range [${source.from}, ${source.to}) or target ${targetPos} is outside the document`);
    }

    // ── 2. Source range integrity ──
    // Collect the moved children directly from their common parent — a
    // doc.slice through a LIST would wrap the items in a phantom list node
    // (open slice), nesting a list inside the drop target. Works uniformly
    // for top-level blocks (parent = doc) and nested children (list items,
    // container children).
    const $from = doc.resolve(source.from);
    const parent = $from.depth === 0 ? doc : $from.parent;
    if (parent.isTextblock) {
        return refuse(
            `source range start ${source.from} resolves inside a ${parent.type.name}, not at a block boundary`,
        );
    }
    const base = $from.depth === 0 ? 0 : $from.start();
    const moved: ProseNode[] = [];
    let coveredFrom = -1;
    let coveredTo = -1;
    parent.forEach((child: ProseNode, offset: number) => {
        const childPos = base + offset;
        if (childPos >= source.from && childPos < source.to) {
            if (moved.length === 0) {
                coveredFrom = childPos;
            }
            moved.push(child);
            coveredTo = childPos + child.nodeSize;
        }
    });
    if (moved.length === 0) {
        return refuse(`source range [${source.from}, ${source.to}) covers no children of its parent`);
    }
    if (coveredFrom !== source.from || coveredTo !== source.to) {
        // The fe6a1fe malformed-range class: a range that does not cleanly
        // tile whole children would DELETE [from, to) but re-insert only the
        // children it happened to cover — data loss. Refuse it up front.
        return refuse(
            `source range [${source.from}, ${source.to}) does not cleanly cover whole children of ` +
            `${parent.type.name} (whole-child cover is [${coveredFrom}, ${coveredTo}))`,
        );
    }
    // Clause 3's declared exception: an opt-in, caller-requested rank shift.
    // Applied BEFORE the fit check so `canReplace` verifies the fragment that
    // actually lands (a relevel keeps the node type, so the answer is the
    // same — checking the real fragment is the point, not a formality).
    const content = Fragment.from(relevelHeadings(moved, relevelDelta));

    // ── 4. Target legality: never land inside fold-hidden content ──
    // Same registry as the drag UI's slot filter (visibleBoundaryPositions):
    // collapsed heading sections are half-open at `to`, collapsed callout
    // bodies inclusive. A hidden target here means a caller drifted from the
    // registry — content committed into display:none reads as deletion.
    if (isHiddenTargetPos(view.state, targetPos)) {
        return refuse(`target ${targetPos} is inside fold-hidden content`);
    }

    // ── 3. Explicit fit, before any transaction exists ──
    const $target = doc.resolve(targetPos);
    if ($target.textOffset !== 0) {
        return refuse(`target ${targetPos} is inside a text node, not at a node boundary`);
    }
    const targetIndex = $target.index();
    if (!$target.parent.canReplace(targetIndex, targetIndex, content)) {
        // The code-block-split class: tr.insert's replaceStep would "fit"
        // the fragment by splitting the target (or silently no-op). The
        // primitive refuses instead — structurally, before the guard would.
        return refuse(
            `target parent ${$target.parent.type.name} cannot hold the moved ` +
            `${moved.map((n) => n.type.name).join("+")} at index ${targetIndex}`,
        );
    }

    // ── Declared dissolution: which marker-bearing containers this move
    // empties ── deleteRange dissolves an emptied parent (and any ancestor
    // it in turn empties), marker line included — legitimate even when the
    // marker carries a title. Declare those markers so the content guard
    // can exempt exactly them and still veto the buggy-unwrap shape.
    const dissolvedMarkers = dissolvedMarkersFor(doc, { from: coveredFrom, to: coveredTo });

    // ── The move: delete + insert in one transaction ──
    // deleteRange (not delete): removing a list's last item must dissolve
    // the emptied list instead of leaving a schema-invalid empty node — the
    // single allowed normalization.
    const tr = view.state.tr.deleteRange(source.from, source.to);
    const sizeAfterDelete = tr.doc.content.size;
    const insertAt = tr.mapping.map(targetPos);
    tr.insert(insertAt, content);
    if (tr.doc.content.size < sizeAfterDelete + content.size) {
        // Backstop for the pre-checked fit (B2): tr.insert silently no-ops
        // when the slice can't fit (replaceStep returns null — no throw).
        // Dispatching would commit the DELETE half alone: a failed move must
        // be a no-op, never a deletion.
        return refuse("insert no-opped after the delete — refusing the half-committed move");
    }

    // ── 5. Side-state rides along ──
    // The fold-preserving move meta: a collapsed section stays collapsed at
    // its destination, and nothing else inherits its fold.
    tr.setMeta(headingFoldPluginKey, {
        type: "move",
        from: source.from,
        to: source.to,
        insertAt,
    } satisfies HeadingFoldMeta);

    // The selection rides the moved content — redo then restores it (and the
    // scroll) at the destination instead of jumping to a stale spot. Multi-
    // block drops keep the whole run selected (the Tiptap post-drop
    // convention) so it stays grabbable for another drag; single moves get a
    // plain caret.
    if (opts?.selectRun) {
        const runEnd = insertAt + content.size;
        // Top-level runs stay selected as a real block range (leaf blocks
        // included); item-level ranges (inside a list) would snap outward
        // to the whole list, so they keep the text-span fallback.
        const runRange = tr.doc.resolve(insertAt).depth === 0
            ? BlockRangeSelection.tryCreate(tr.doc, insertAt, runEnd)
            : null;
        tr.setSelection(
            runRange ??
            TextSelection.between(
                tr.doc.resolve(Math.min(insertAt + 1, tr.doc.content.size)),
                tr.doc.resolve(Math.max(0, Math.min(runEnd - 1, tr.doc.content.size))),
            ),
        );
    } else {
        // A single move keeps the caret at its offset WITHIN the moved block,
        // not snapped to the block's start. A start-of-block caret sits on the
        // boundary with the block above, so the next keyboard move (Alt+↑/↓)
        // would resolve to THAT block and escalate scope (MAR-144); a stable
        // caret keeps repeated moves acting on the same block. When the
        // pre-move selection isn't a caret inside the moved range — a drag or
        // menu move driven from elsewhere — fall back to just inside the block.
        const rel =
            preMoveSel.empty && preMoveSel.from >= source.from && preMoveSel.from <= source.to
                ? Math.max(preMoveSel.from - source.from, 1)
                : 1;
        tr.setSelection(
            TextSelection.near(tr.doc.resolve(Math.min(insertAt + rel, tr.doc.content.size))),
        );
    }

    // ── 1. Atomic + veto-aware dispatch ──
    // Content-guard contract (MAR-108): a move conserves content exactly
    // (modulo dissolving a parent it emptied).
    tagContentGuard(
        tr,
        dissolvedMarkers.length > 0
            ? { kind: "move", dissolvedMarkers }
            : { kind: "move" },
    );
    const docBefore = view.state.doc;
    view.dispatch(tr);
    if (view.state.doc === docBefore) {
        // Guard veto — view.dispatch returns nothing, so this doc-identity
        // check is how the primitive learns the transaction never applied.
        // Skip the flash (its positions describe the never-created doc) and
        // return false so drag/menu/keyboard callers report truthfully.
        return false;
    }
    view.focus();
    // Landing flash at the destination — positions are valid in the new doc.
    flashRange(view, insertAt, insertAt + content.size);
    return true;
}

/**
 * The `marker:` fingerprint keys (via `markerKeyOf`) of every container a
 * move of `[source.from, source.to)` legitimately EMPTIES: the range's
 * resolved parent when the range covers its entire content, plus each
 * ancestor that in turn empties because its dissolving child was its only
 * one. `deleteRange` dissolves this chain, marker lines included — even a
 * titled callout's — so the primitive declares these keys on the guard tag,
 * and the generative suites use the same function as their oracle so the
 * declaration and the check can never drift.
 */
export function dissolvedMarkersFor(
    doc: ProseNode,
    source: { from: number; to: number },
): string[] {
    const $from = doc.resolve(source.from);
    if ($from.depth === 0) {
        return [];
    }
    if (source.from !== $from.start() || source.to !== $from.end()) {
        return []; // the move does not empty its parent — nothing dissolves
    }
    const keys: string[] = [];
    for (let depth = $from.depth; depth >= 1; depth--) {
        const key = markerKeyOf($from.node(depth));
        if (key) {
            keys.push(key);
        }
        // The chain continues only while the dissolving node is its own
        // parent's sole child (so that parent empties too).
        if (depth === 1 || $from.node(depth - 1).childCount !== 1) {
            break;
        }
    }
    return keys;
}
