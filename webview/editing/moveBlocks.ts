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
 * 3. EXPLICIT FIT, ON BOTH SIDES — the target must be a node boundary whose
 *    parent `canReplace`s the exact fragment at that index, AND the source's
 *    parent must still be valid once the run leaves it; both verified BEFORE
 *    any transaction exists. Implicit `replaceStep` fitting is never relied
 *    on: that is where silent wraps, splits (the code-block-split class the
 *    guard used to catch as the last line of defense), silent no-ops, and
 *    filler nodes live. The ONLY allowed normalization is `deleteRange`
 *    dissolving a parent the move emptied (a list losing its last item).
 *    Nothing else: no retyping nodes to fit, no attr drops, no dissolving
 *    non-empty containers, no re-heading a stranded parent with a filler.
 *
 *    The source side is the mirror of the target side and was the later
 *    lesson: `replaceStep` repairs a parent whose remainder stops matching
 *    its content expression by INJECTING a node, rather than refusing. That
 *    escapes both other defenses — the result is schema-valid and conserves
 *    content — and only shows up as corruption after save+reopen. See
 *    `resolveMove`'s source-side clause.
 *
 *    The clause forbids IMPLICIT rewrites — content silently reshaped to
 *    make a drop fit. It does not forbid a transformation the CALLER asked
 *    for: `relevelDelta` shifts the moved headings' ranks. The TOC outline is
 *    a structural editor as well as a view, so an outline drop's position is
 *    the user's stated intent, not a fitting artifact. It is opt-in, declared
 *    at the call site, applied before the fit check, and rides the SAME
 *    transaction so a drag stays one undo step.
 * 4. TARGET LEGALITY IS STRUCTURAL — targets inside any fold-hidden range
 *    (collapsed heading sections AND collapsed callout bodies) are rejected
 *    through the same `isHiddenTargetPos` registry the drag UI's slot
 *    filter consumes, so UI slots and primitive legality cannot drift.
 *    A target AT a collapsed section's END is the one case that is legal yet
 *    still swallows its landing — the boundary is visible (it renders at the
 *    next heading's line) but sits inside the section, because fold extents
 *    derive from heading ranks. That slot is one the user aimed at, so the
 *    fold is REVEALED rather than the landing refused or hidden (MAR-146).
 *    The reveal is not this module's job: the fold plugin sees the section's
 *    end grow over the landing and expands it, in this very transaction
 *    (swallowedVisibleContent; MAR-149).
 * 5. SIDE-STATE RIDES ALONG — the fold plugin's move meta travels inside
 *    the primitive, so a collapsed section stays collapsed at its
 *    destination and nothing else inherits its fold.
 *
 * v1 scope: ONE contiguous source range. Non-contiguous multi-range moves
 * (a future marquee/Cmd-click extension) are explicitly out of scope.
 */
import type { EditorView } from "@milkdown/prose/view";
import { Fragment, type Node as ProseNode } from "@milkdown/prose/model";
import { TextSelection, type EditorState } from "@milkdown/prose/state";
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

/** resolveMove's verdict: a refusal reason, or the derived move payload. */
type MoveResolution =
    | { reason: string }
    | {
        reason: null;
        content: Fragment;
        coveredFrom: number;
        coveredTo: number;
    };

/**
 * The structural verdict on a move, decided on the document alone — clauses
 * 2/3/4 of the contract, and the SINGLE place they are decided. `moveBlocks`
 * refuses on a reason; the UI asks the same question through `moveFits` to
 * DISABLE a gesture rather than offer one that silently no-ops. Sharing the
 * verdict is the point: a menu row that predicts legality with its own copy
 * of these rules drifts from the primitive the moment either side changes
 * (the same reason the drag's slot filter and clause 4 share one registry).
 */
function resolveMove(
    state: EditorState,
    source: { from: number; to: number },
    targetPos: number,
    relevelDelta: number,
): MoveResolution {
    const { doc } = state;
    if (source.from < 0 || source.to > doc.content.size || targetPos < 0 || targetPos > doc.content.size) {
        return { reason: `range [${source.from}, ${source.to}) or target ${targetPos} is outside the document` };
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
        return {
            reason: `source range start ${source.from} resolves inside a ${parent.type.name}, not at a block boundary`,
        };
    }
    const base = $from.depth === 0 ? 0 : $from.start();
    const moved: ProseNode[] = [];
    let firstIndex = -1;
    let coveredFrom = -1;
    let coveredTo = -1;
    parent.forEach((child: ProseNode, offset: number, index: number) => {
        const childPos = base + offset;
        if (childPos >= source.from && childPos < source.to) {
            if (moved.length === 0) {
                coveredFrom = childPos;
                firstIndex = index;
            }
            moved.push(child);
            coveredTo = childPos + child.nodeSize;
        }
    });
    if (moved.length === 0) {
        return { reason: `source range [${source.from}, ${source.to}) covers no children of its parent` };
    }
    if (coveredFrom !== source.from || coveredTo !== source.to) {
        // The fe6a1fe malformed-range class: a range that does not cleanly
        // tile whole children would DELETE [from, to) but re-insert only the
        // children it happened to cover — data loss. Refuse it up front.
        return {
            reason:
                `source range [${source.from}, ${source.to}) does not cleanly cover whole children of ` +
                `${parent.type.name} (whole-child cover is [${coveredFrom}, ${coveredTo}))`,
        };
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
    // (A target AT a section's end is visible and legal, but the landing may
    // still fall inside the fold — revealed, not refused, by the caller.)
    if (isHiddenTargetPos(state, targetPos)) {
        return { reason: `target ${targetPos} is inside fold-hidden content` };
    }

    // ── 3. Explicit fit, before any transaction exists ──
    const $target = doc.resolve(targetPos);
    if ($target.textOffset !== 0) {
        return { reason: `target ${targetPos} is inside a text node, not at a node boundary` };
    }
    const targetIndex = $target.index();
    if (!$target.parent.canReplace(targetIndex, targetIndex, content)) {
        // The code-block-split class: tr.insert's replaceStep would "fit"
        // the fragment by splitting the target (or silently no-op). The
        // primitive refuses instead — structurally, before the guard would.
        return {
            reason:
                `target parent ${$target.parent.type.name} cannot hold the moved ` +
                `${moved.map((n) => n.type.name).join("+")} at index ${targetIndex}`,
        };
    }

    // ── 3, source side: the vacated parent must survive the removal ──
    // Clause 3 forbids IMPLICIT fitting on BOTH sides, but only the target
    // side was ever checked. The delete has the mirror-image failure: when
    // the remainder no longer matches the parent's content expression,
    // replaceStep does not refuse — it silently injects a FILLER node to
    // repair the parent. `list_item` is `paragraph block*`, so moving an
    // item's leading paragraph down leaves `[blockquote, paragraph]`, and
    // ProseMirror re-heads the item with an EMPTY paragraph. That doc is
    // schema-valid (doc.check passes) and conserves content (the guard's
    // fingerprint ignores empty paragraphs — MAR-123), so BOTH existing
    // defenses pass it. It serializes to a bare `-` marker line, which on
    // reparse splits the list: silent corruption at save+reopen.
    //
    // The one allowed normalization stays allowed: a removal that empties
    // the parent entirely is the declared dissolution deleteRange performs
    // (a list losing its last item), so it is exempt — this clause is only
    // about a parent left non-empty AND invalid.
    const survivors = parent.childCount - moved.length;
    if (survivors > 0 && !parent.canReplace(firstIndex, firstIndex + moved.length)) {
        return {
            reason:
                `removing ${moved.map((n) => n.type.name).join("+")} at index ${firstIndex} would strand ` +
                `${parent.type.name} (its remaining content no longer fits "${parent.type.spec.content ?? ""}")`,
        };
    }
    return { reason: null, content, coveredFrom, coveredTo };
}

/**
 * Whether `moveBlocks` would structurally accept this move. The block menu's
 * Move rows disable on `false` instead of rendering live and no-opping on
 * click. Answers the STRUCTURAL question only: a target inside the source
 * range fits here but is moveBlocks' quiet "put it back" no-op, so callers
 * that can produce one must exclude it themselves (the Move rows cannot — a
 * sibling hop always lands outside the run).
 */
export function moveFits(
    state: EditorState,
    source: { from: number; to: number },
    targetPos: number,
): boolean {
    return resolveMove(state, source, targetPos, 0).reason === null;
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

    // ── 2/3/4. Structural legality — decided by resolveMove, the shared
    // verdict the UI also consults (so a live-looking row and the primitive
    // can never disagree about what is possible).
    const resolution = resolveMove(view.state, source, targetPos, relevelDelta);
    if (resolution.reason !== null) {
        return refuse(resolution.reason);
    }
    const { content, coveredFrom, coveredTo } = resolution;

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
    // The move landed. A landing that came to rest inside a collapsed section
    // (the END-boundary case in clause 4) is revealed by the fold plugin
    // itself, in this same transaction: its "no edit may hide visible content"
    // rule sees the section grow over the landing and expands it (MAR-149).
    // This site used to reveal explicitly (MAR-146); that became unreachable
    // once the general rule landed, and a second dispatch could only re-do
    // what the move transaction already carries.
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
