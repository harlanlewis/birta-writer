import {
    defaultValueCtx,
    Editor,
    editorViewOptionsCtx,
    nodeViewCtx,
    parserCtx,
    remarkCtx,
    rootCtx,
    serializerCtx,
} from "@milkdown/core";
import { prism, prismConfig } from "@milkdown/plugin-prism";
import { getState, getView, type EditorView } from "./pm";
import type { Node as ProseNode } from "./pm";
import { getMarkdown } from "@milkdown/utils";
import {
    applyMinimalChanges,
    computeRoundTripProtection,
    type RoundTripProtection,
} from "@birta/minimal-diff";
import { mergeVerified, mergeVerifiedWith } from "./utils/verifiedMerge";
import { verifyOracle, type VerifyOracle } from "./utils/verifyOracle";
import { fingerprintDoc } from "./plugins/fingerprints";
import { configureHeadingIds, seedHeadingIds, type HeadingIdSeed } from "./plugins/headingIdSync";
import { EXTERNAL_SYNC_META, PROGRESSIVE_APPEND_META, setProgressiveStreaming } from "./plugins/docChange";
import { foldPluginKey } from "./plugins/foldState";
import { rehydrateListNumbering } from "./plugins/listNumbering";
import { PROGRESSIVE_OPEN_MIN_CHARS, planProgressiveOpen, streamChunks, type StreamHandle } from "./progressiveOpen";
import { Fragment, Selection } from "./pm";
import { markdownFormat } from "./format/markdown";
import type { FormatModule } from "./format/types";
import { guardNodeViewFactory } from "./nodeViewBoundary";
import { refractor, ensureGrammars } from "./highlighter";
import { applyExternalSync } from "./externalSync";
import { countWork, instrumentTransactions, mark, measure } from "./perf";
import { createSyncScheduler } from "./syncScheduler";
import { isReadOnly } from "./readOnly";
import { requestIdle } from "./utils/idle";
import {
    anchorSyncPlugin,
    backtickWrapPlugin,
    calcArrowSuggestPlugin,
    calcAutoInsertPlugin,
    calcRefreshPlugin,
    calcStalePlugin,
    calcSuggestPlugin,
    caretScrollMarginPlugin,
    cellClickFixPlugin,
    codeBlockBackspacePlugin,
    contentGuardPlugin,
    codeBlockSelectAllPlugin,
    copyMarkdownPlugin,
    docChangePlugin,
    setDocChangeListener,
    footnoteNumberingPlugin,
    footnoteReferenceInputRule,
    foldRevealKeymapPlugin,
    formatKeymapPlugin,
    blockEdgeGapCursorKeymapPlugin,
    gapCursorPlugin,
    headingAbsoluteInputRule,
    headingEmptyDeletePlugin,
    headingFoldPlugin,
    headingStickyPlugin,
    historyKeymapPlugin,
    historyPlugin,
    horizontalRuleKeymapPlugin,
    horizontalRulePlugin,
    insertCalloutCommand,
    insertFootnoteCommand,
    insertHorizontalRuleCommand,
    linkInputRule,
    linkUrlCompletePlugin,
    pasteLinkPlugin,
    pasteMarkdownPlugin,
    pasteContainerFitPlugin,
    imageUploadProgressPlugin,
    agentPendingPlugin,
    applyAgentResult,
    recordsExternalInHistory,
    imagePastePlugin,
    htmlEditKeymapPlugin,
    htmlLivePairsPlugin,
    mathInlineEditPlugin,
    wikiLinkEditPlugin,
    wikiLinkCompletePlugin,
    headingLinkCompletePlugin,
    activeBlockPlugin,
    hiddenSelectionPlugin,
    imageBlocksPlugin,
    listAutoJoinPlugin,
    listEnterPlugin,
    listLiftPlugin,
    listMergeSuggestPlugin,
    listSpreadNormalizePlugin,
    noteMarkersPlugin,
    emptyLineHintPlugin,
    pendingRangePlugin,
    slashArgumentHintPlugin,
    proofreadPlugin,
    readOnlyPlugin,
    selectionPlugin,
    slashMenuPlugin,
    smartSelectKeymapPlugin,
    insertParagraphKeymapPlugin,
    tabKeymapPlugin,
    blockKeysPlugin,
    blockSourcePlugin,
    tableKeymapPlugin,
    toggleHighlightCommand,
    trailingHrParagraphPlugin,
} from "./plugins";

export { registerSelectionChangeHandler, setLogTableSel } from "./plugins";

// ── The active format ───────────────────────────────────────────────────────
// Everything format-specific the editor consumes — parsing presets, stringify
// config, NodeViews, the minimal-diff profile — comes through this one
// object (the MAR-41 seam; see format/types.ts). Selected per document:
// createEditor receives the module (markdown by default; mdx resolved lazily
// by format/loader.ts) and rebinds this before any use. A document's format
// never changes while it is open, so between createEditor calls the binding
// is stable.
let format: FormatModule = markdownFormat;

let _editor: Editor | null = null;

// The Markdown text as last saved/loaded (with the user's original
// formatting: blank lines, rule widths, ...). Used for the minimal-diff merge
// on autosave so a full re-serialization never reformats untouched regions.
let _savedMarkdown = '';

// Round-trip protection for the current file: change regions a ZERO-EDIT
// parse→serialize cycle produces on its own (dropped reference-link
// definitions, setext→ATX rewrites, escaping churn, ...). applyMinimalChanges
// pins these regions to their saved bytes so an edit elsewhere in the file can
// never silently destroy them. Constructs pasted AFTER load are not covered
// until the next reload — by then they are part of the saved baseline.
//
// On load this is DEFERRED off the launch path: a large file's zero-edit
// re-serialization can cost tens of ms, so createEditor() stashes the pristine
// document + its baseline (`_protectionSnapshot`) and precomputes during idle.
// getProtection() forces the computation on demand if the first save beats
// idle. The ProseMirror doc is immutable and the serializer pure, so the
// deferred result is byte-for-byte identical to computing it eagerly at load.
let _protection: RoundTripProtection | null = null;
let _protectionSnapshot: { baseline: string; doc: ProseNode; editor: Editor } | null = null;

// A save flush whose bytes the extension has not yet confirmed applying. The
// baseline (`_savedMarkdown`) and any canonical protection-drop advance only on
// `flushAck { applied: true }` — an unacknowledged flush is not a committed
// write, because the extension is free to discard the reply (flush timeout,
// stale version, superseded seq) and then the save has written the document as
// it stood, not these bytes (MAR-349). Any other baseline write (a sync, an
// external re-base, a new editor) supersedes the candidate wholesale.
// `docChangeCount` records how many user doc changes the candidate's serialize
// had seen, so the commit can tell whether the doc moved on while the ack was
// in flight and a re-sync against the NEW baseline is owed.
let _flushCandidate: {
    id: string;
    text: string;
    canonical: boolean;
    docChangeCount: number;
} | null = null;
let _docChangeCount = 0;

/**
 * Return the current round-trip protection, computing it from the pristine
 * snapshot on first demand (and caching it). Called before every save so an
 * edit that arrives before the idle precompute still diffs against the correct,
 * pristine-derived protection. The snapshot is bound to its editor instance, so
 * a deferred callback that fires after the editor was destroyed or replaced is a
 * no-op (guarded, since ctx access on a torn-down editor throws).
 *
 * The `rtp-start`/`rtp-end` marks bracket the whole zero-edit re-serialization,
 * and must stay wherever the work actually runs (MAR-311). This work is
 * deferred past first paint, onto frames no launch span reaches, so marks left
 * behind at an old call site would leave the harness's `rtp` span reading
 * `null` while the cost is still paid — reported as nothing, and visible only
 * as an unattributed post-paint longtask. Deferring work past the last mark
 * does not make it free.
 */
function getProtection(): RoundTripProtection | null {
    if (_protection) return _protection;
    const snap = _protectionSnapshot;
    if (snap && snap.editor === _editor) {
        mark("rtp-start");
        try {
            const serialized = snap.editor.action((ctx) => ctx.get(serializerCtx)(snap.doc));
            _protection = computeRoundTripProtection(
                snap.baseline,
                serialized,
                format.formatProfile,
            );
        } catch {
            // Editor torn down before the deferred compute ran — no live save
            // path to protect, so leave protection unset.
        }
        // Stamped even when the serialize threw: the main thread was blocked
        // either way, and a span that silently vanishes on the error path is how
        // this measurement was lost the first time.
        mark("rtp-end");
        measure("rtp", "rtp-start", "rtp-end");
        _protectionSnapshot = null;
    }
    return _protection;
}

/**
 * Precompute the deferred protection during idle, off the launch path.
 *
 * Through `requestIdle` rather than a local scheduler, which is what makes the
 * deferral hold in every engine: WebKit implements no `requestIdleCallback`, so
 * the fallback is the real path on the surface Birta Writer for Mac renders in,
 * and a bare timeout scheduled during mount fires before the first paint. The
 * O(document) re-serialization this defers was being paid on the launch path in
 * exactly the engine nobody was measuring. `utils/idle.ts` holds the reason the
 * fallback clears two animation frames; `e2e/perf` asserts `rtp-start` against
 * the paint mark, and is the only place the ordering can fail.
 */
function scheduleProtection(): void {
    requestIdle(() => getProtection(), 2000);
}

// Whether the user has interacted with the editor yet (keyboard/mouse/paste/...)
// Reset to false on every createEditor() so that "just opening a file" never triggers an autosave.
let _hasUserInteracted = false;
let _interactionListenerAdded = false;

// Set once createEditor() has finished wiring an editor AND the document is
// whole. Setting the initial content during create() dispatches doc-changing
// transactions; this blocks them from reaching the sync pipeline so opening a
// file never causes a silent save. Module-scoped (like _hasUserInteracted)
// because the doc-change subscriber is registered before the editor — and
// therefore before any local would be initialized.
//
// A progressive open (progressiveOpen.ts, MAR-429) keeps it down until the
// last chunk lands: while it is down the sync pipeline is inert and the flush
// answers with the saved bytes, so no path can serialize a partial document.
// That is the whole of the truncation guard, and `progressiveOpen.test.ts`
// holds it against both paths.
let _isSettled = false;

// ── Progressive open (MAR-429) ──────────────────────────────────────────────
let _progressiveMinChars = PROGRESSIVE_OPEN_MIN_CHARS;
// The stream still appending, or null. Cancelled by a re-init or an inbound
// external sync, both of which replace the document wholesale.
let _stream: StreamHandle | null = null;
// True for the synchronous span in which a chunk is dispatched, so the
// doc-change subscriber can tell the document arriving from the user editing
// it: the latter, while the stream runs, is owed a sync once it completes.
let _appendingChunk = false;
let _editedWhileStreaming = false;

/** Test seam: lower the floor so a jsdom-sized document opens progressively. */
export function setProgressiveOpenMinCharsForTests(minChars: number | undefined): void {
    _progressiveMinChars = minChars ?? PROGRESSIVE_OPEN_MIN_CHARS;
}

/** Whether the document is whole and the pipeline live: false while a progressive open still streams. */
export function isSettled(): boolean {
    return _isSettled;
}

/**
 * One chunk of the document landing: parsed on its own, its heading ids
 * continuing the open's one assigner, appended at the end as a transaction
 * that reads as the file's content arriving (not the user's edit, not
 * history), with the selection put back where it was, because an append at
 * the end moves nothing before it and the default mapping would carry a
 * caret sitting at the old end to the new one.
 */
function appendChunk(editor: Editor, text: string, seed: HeadingIdSeed, pristine: ProseNode[]): void {
    const view = editor.action((ctx) => getView(ctx));
    const parsed = editor.action((ctx) => ctx.get(parserCtx)(text)) as ProseNode | null;
    if (!parsed) throw new Error("progressive open: a chunk did not parse");
    const seeded = editor.action((ctx) => seedHeadingIds(ctx, parsed, seed));
    seeded.forEach((block) => pristine.push(block));
    const { state } = view;
    const tr = state.tr
        .insert(state.doc.content.size, seeded.content)
        .setMeta("addToHistory", false)
        .setMeta(EXTERNAL_SYNC_META, true)
        .setMeta(PROGRESSIVE_APPEND_META, true);
    tr.setSelection(Selection.fromJSON(tr.doc, state.selection.toJSON()));
    _appendingChunk = true;
    try {
        view.dispatch(tr);
    } finally {
        _appendingChunk = false;
    }
}

/**
 * The document is whole: what a plain open does at the end of `createEditor`,
 * and what a progressive open does when its last chunk has landed. The
 * order is the invariant: everything that restores presentation onto the
 * document runs BEFORE the pipeline settles, so it reads as the open and not
 * as an edit, and the sync owed for anything the user typed meanwhile is
 * requested last, against a settled pipeline.
 */
function finishOpen(editor: Editor, initialMarkdown: string, pristine: ProseNode[] | null): void {
    setProgressiveStreaming(false);
    const live = editor.action((ctx) => getState(ctx).doc);
    if (pristine) {
        const view = editor.action((ctx) => getView(ctx));
        rehydrateListNumbering(view);
        view.dispatch(view.state.tr.setMeta(foldPluginKey, { type: "resolvePersisted" }).setMeta("addToHistory", false));
    }
    // Snapshot the pristine document and defer its round-trip protection off the
    // critical path (see _protectionSnapshot above): the zero-edit
    // re-serialization used to learn which regions the round trip cannot
    // reproduce would otherwise block first paint on large files. PRISTINE
    // is the word that matters: a progressive open's live document may
    // already hold what the user typed while it streamed, and protection
    // computed from that would read the edit as a region the round trip
    // cannot reproduce, so the streamed document is reassembled from the
    // chunks as they were parsed, which is what a whole parse gives.
    _protectionSnapshot = {
        baseline: initialMarkdown,
        doc: pristine ? live.copy(Fragment.fromArray(pristine)) : live,
        editor,
    };
    scheduleProtection();
    mark("stream-end");
    measure("stream", "stream-start", "stream-end");
    _isSettled = true;
    if (_editedWhileStreaming) {
        _editedWhileStreaming = false;
        _docChangeCount++;
        _scheduler.request();
    }
}

// True only for the synchronous span in which an INBOUND external change is
// being dispatched, read by the doc-change subscriber to keep that change from
// echoing back as a save (see _applyExternalNow).
//
// Why a flag and not the EXTERNAL_SYNC_META transaction meta (MAR-152): the
// meta answers "is this TRANSACTION part of a sync?", but this question is
// "is this doc change CAUSED BY the sync?" — plugins react to the sync by
// dispatching NEW transactions reentrantly (observed empirically: capturing
// the meta into docChange plugin state, even with appendedTransaction root
// attribution, failed savePipeline's no-echo pin on exactly such a reentrant
// fix-up). Only a span over the synchronous dispatch covers derived work.
// The synchronous assumption this relies on is itself pinned: an async
// refactor of applyExternalSync would un-suppress the echo and turn
// savePipeline's "should not even REQUEST a sync" test red.
let _applyingExternal = false;

// IME composition state, hoisted to module scope so inbound external syncs can
// defer while the user is mid-composition (see syncExternalContent). The
// outbound save pipeline reads it too, so a pinyin/kana candidate is never sent
// to the file half-formed.
let _isComposing = false;
// Latest external content that arrived DURING composition, applied on
// compositionend. Only the most recent push matters — older ones are stale.
let _pendingExternalMarkdown: string | null = null;
// Lifetime of the composition listeners bound in createEditor. The container
// is the single stable #editor element, so without an abort every re-init
// (revert / init / externalUpdate fallback) would stack another handler pair
// and one composition would run the compositionend block N times (MAR-148).
let _compositionAbort: AbortController | null = null;

// ── Outbound sync pipeline (view → document) ───────────────────────────────
// Driven by docChangePlugin, which reports every doc-changing transaction
// SYNCHRONOUSLY (see onDocChanged below). The trigger is O(1): it flags that an
// edit happened and asks the scheduler when to sync. SERIALIZATION (whole-doc
// `getMarkdown()` + `applyMinimalChanges` + round-trip protection) is expensive
// — O(document size) — so it runs ONLY in syncNow(),
// never on the keystroke path, and the scheduler keeps it off mid-burst
// (leading edge → dirty ASAP; trailing debounce → don't re-serialize while
// typing; max-wait → bound crash-safety staleness). The definitive freshest
// content is always captured at save via flushPendingEdit() regardless of where
// the debounce sits. The scheduling policy lives in webview/syncScheduler.ts
// (unit-tested there).
//
// This deliberately does NOT ride Milkdown's `listenerCtx.updated`, which wraps
// every callback in a lodash `debounce(fn, 200)` (trailing). Upstream of the
// scheduler that debounce starves it and breaks two invariants (MAR-145):
//   • #2 — the first keystroke does not dirty the TextDocument for a fifth of
//     a second, so a Cmd+S inside that window finds a clean document, never
//     fires onWillSaveTextDocument, and does not write the keystroke;
//   • #3 — being TRAILING, it resets on every keystroke, so continuous typing
//     never fires it at all: request() is never called, the scheduler's
//     max-wait can never engage, and the document stays clean for the whole
//     burst, however long it runs.
// The scheduler already implements leading edge + trailing + max-wait together;
// a second timer upstream can only starve it. Pinned by e2e/syncLatency.
let _onUpdate: ((markdown: string) => void) | null = null;

// ── Doc-change notification (view → view) ──────────────────────────────────
// Pure VIEWS of the document (the TOC outline) must track the doc itself, not a
// save/serialize cadence: riding _onUpdate made a view's latency a function of
// the user's recent edit history — near-immediate on a leading edge, up to
// idleMs mid-burst, up to maxWaitMs under continuous typing — and skipped it
// entirely whenever syncNow() found no substantive markdown change. That reads
// as an outline that updates "sometimes fast, sometimes late".
//
// This callback carries no payload (a view reads view.state.doc itself) and does
// no serialization. Subscribers own their own coalescing — see the rAF batching
// at the call site in index.ts.
let _onDocChange: (() => void) | null = null;

// ── Off-thread verification (MAR-430, tier B0) ─────────────────────────────
// A sync's verifying reparse is the one whole-document parse on the edit path
// and, on a large document, most of the sync (`pnpm perf huge-outline` prints
// the split as `sync split`). Above this many characters the reopen question
// goes to the verify worker (utils/verifyOracle.ts) and the interaction
// thread keeps only the serialize, the merge and the live fingerprint; below
// it the parse is cheaper than a round trip, and the pipeline is the
// synchronous one it always was. The floor sits above `pnpm perf large`, so
// every gated launch fixture keeps the synchronous path, and below the typing
// gate's `xlarge`, so that gate exercises the worker.
//
// The flush (`flushPendingEdit`) never waits on the worker: a save is the
// user's own gesture, its answer is due inside the host's flush timeout, and
// the main-thread check is the same function answering the same question.
// What crosses to the worker is text and a fingerprint; what comes back is a
// boolean. Which bytes reach the file is decided by `utils/verifiedMerge`
// either way, and `verifiedMerge.test.ts` holds its two forms identical.
export const OFF_THREAD_VERIFY_MIN_CHARS = 100_000;
let _offThreadMinChars = OFF_THREAD_VERIFY_MIN_CHARS;

/** Test seam: lower the floor so a jsdom-sized document takes the worker path. */
export function setOffThreadVerifyMinCharsForTests(minChars: number | undefined): void {
    _offThreadMinChars = minChars ?? OFF_THREAD_VERIFY_MIN_CHARS;
}

// Every serialization the pipeline takes, sync or flush, numbered in order.
// THE ORDERING RULE: a worker's answer commits only while no serialization
// has been taken since the one it answers. A flush taken meanwhile carried
// fresher bytes to the file, and an older answer landing after it would post
// older content under a newer seq, which the extension would apply; a later
// sync or an external re-base moved the baseline the answer was merged
// against. All three read as "not current", and a stale answer is dropped
// whole, never partially applied.
let _serialSeq = 0;
// The sync a worker is answering, or null. ONE in flight at a time: a sync
// the scheduler asks for meanwhile is owed once this one settles, never
// queued behind it, so a worker slower than the max-wait window is bounded
// to one round trip of extra staleness rather than a growing backlog.
let _inFlight: { editor: Editor; seq: number; saved: string } | null = null;
let _syncOwed = false;

/** The oracle to ask for this document, or null: the worker holds the markdown parser and no other. */
function offThreadOracle(): VerifyOracle | null {
    return format === markdownFormat ? verifyOracle() : null;
}

/**
 * The file-ready bytes for `markdown`: the minimal-diff merge into the saved
 * text, verified to reopen as the document it came from (MAR-343 —
 * `utils/verifiedMerge`). Both save paths go through here or through
 * `mergeForSaveWith` below, which is the same decision with its reparse run
 * elsewhere; neither can acquire the check without the other, and the
 * merge's damage does not care which one wrote it.
 *
 * The parser comes from the editor's own context, so this stays on the
 * FormatModule seam: the verifier is handed a parse function and a profile
 * rather than knowing markdown exists.
 *
 * Every pass stamps a `merge` work count: one pass, how many times the
 * verifier reparsed the merged bytes (zero for a file already in the
 * serializer's spelling, one or two otherwise), and how many of those ran on
 * the interaction thread. Each is a whole-document walk, so how many of them
 * a burst pays is what the nightly heavy-fixture gate holds
 * (`e2e/perf-counts.mjs`); a scheduler that fires too often, the defect #421
 * found, moves this count and no gated duration, and a worker that quietly
 * stops loading moves `mainReparses` off its ceiling of zero.
 */
function mergeForSave(editor: Editor, markdown: string): { text: string; canonical: boolean } {
    let reparses = 0;
    const result = mergeVerified(
        _savedMarkdown,
        markdown,
        format.formatProfile,
        getProtection(),
        editor.action((ctx) => getState(ctx).doc),
        (text) => {
            reparses++;
            return editor.action((ctx) => ctx.get(parserCtx)(text)) as ProseNode | null;
        },
    );
    countWork("merge", { passes: 1, reparses, mainReparses: reparses });
    return result;
}

/**
 * `mergeForSave` with the reopen question asked of `oracle`. The merge, the
 * fallback and the live fingerprint are all taken synchronously, in the task
 * that serialized, so the answer describes the document as it stood at one
 * instant; only the reparse is awaited.
 */
async function mergeForSaveWith(
    editor: Editor,
    markdown: string,
    oracle: VerifyOracle,
): Promise<{ text: string; canonical: boolean }> {
    let reparses = 0;
    const result = await mergeVerifiedWith(
        _savedMarkdown,
        markdown,
        format.formatProfile,
        getProtection(),
        () => fingerprintDoc(editor.action((ctx) => getState(ctx).doc)),
        (liveFp, text) => {
            reparses++;
            return oracle.reopens(liveFp, text);
        },
    );
    countWork("merge", { passes: 1, reparses, mainReparses: 0 });
    return result;
}

/**
 * A canonical merge means every construct protection was pinning has just been
 * written in the serializer's own spelling, so the regions describe a baseline
 * that no longer exists. Reusing them repairs the NEXT save's serialization
 * back to a spelling the file no longer has, and the file swings out on one
 * save and back on the next (MAR-344).
 *
 * Dropping rather than recomputing, because that is what a reload of these
 * bytes would compute: across every protected corpus fixture the serializer's
 * output reparses and re-serializes to itself, so its own protection is empty.
 * That is a census of the fixtures, not a theorem about the serializer — but
 * the direction is the safe one, since protection only ever restores saved
 * bytes and canonical bytes have none to restore.
 *
 * The drop must ride the same commitment as the baseline write it describes:
 * a sync commits immediately, a save flush only on `flushAck { applied: true }`
 * — dropping protection for bytes the extension then discarded would leave the
 * file's real spellings unprotected for the rest of the session (MAR-349). A
 * caller whose merge came out byte-identical to the baseline is served
 * correctly too: identical bytes mean the baseline was already canonical.
 *
 * The snapshot is cleared alongside, as _applyExternalNow does when it
 * re-baselines: getProtection consumes it before any merge returns `canonical`,
 * so the pair states the invariant rather than repairing anything.
 */
function dropCanonicalProtection(): void {
    _protection = null;
    _protectionSnapshot = null;
}

/**
 * Serialize the live document, merge it into the saved bytes with round-trip
 * protection, and ship it to the extension if it substantively changed. The
 * scheduler guarantees this is never called mid-IME-composition.
 *
 * On a document past the off-thread floor the verifying reparse is asked of
 * the worker and the commit lands when it answers; everything else about the
 * sync, the serialize included, still happens here and now. The answer is
 * committed only while it is current (see `_serialSeq`), and an oracle that
 * fails answers the same question on this thread, so the worker decides
 * where the check ran and never whether it ran.
 */
function syncNow(): void {
    if (!_editor) { return; }
    const editor = _editor;
    const oracle = offThreadOracle();
    if (oracle && _inFlight) {
        _syncOwed = true;
        return;
    }
    const markdown = editor.action(getMarkdown());
    const seq = ++_serialSeq;
    if (!oracle || markdown.length < _offThreadMinChars) {
        commitSync(mergeForSave(editor, markdown));
        return;
    }
    const flight = { editor, seq, saved: _savedMarkdown };
    _inFlight = flight;
    mergeForSaveWith(editor, markdown, oracle).then(
        (result) => settleSync(flight, result),
        // The oracle retired itself (utils/verifyOracle.ts). The same
        // question, answered here, if the answer is still wanted.
        () => settleSync(flight, isCurrent(flight) ? mergeForSave(editor, markdown) : null),
    );
}

/** Nothing the pipeline knows has moved since this sync serialized. */
function isCurrent(flight: NonNullable<typeof _inFlight>): boolean {
    return flight.editor === _editor && flight.seq === _serialSeq && flight.saved === _savedMarkdown;
}

function settleSync(flight: NonNullable<typeof _inFlight>, result: { text: string; canonical: boolean } | null): void {
    if (_inFlight === flight) { _inFlight = null; }
    if (result && isCurrent(flight)) { commitSync(result); }
    if (_syncOwed) {
        _syncOwed = false;
        _scheduler.request();
    }
}

/** The tail of a sync: advance the baseline and post, if the bytes changed. */
function commitSync({ text: toSave, canonical }: { text: string; canonical: boolean }): void {
    if (canonical) { dropCanonicalProtection(); }
    if (toSave === _savedMarkdown) { return; } // no substantive change — no save
    _savedMarkdown = toSave;
    // This baseline is fresher than any flush still awaiting its ack (the
    // serialize ran later), so the candidate is superseded, not committed.
    _flushCandidate = null;
    _onUpdate?.(toSave);
}

const _scheduler = createSyncScheduler({
    now: () => performance.now(),
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    isComposing: () => _isComposing,
    onSync: () => syncNow(),
});

/**
 * Every doc-changing transaction, reported synchronously by docChangePlugin.
 * Asks the scheduler for a sync, then notifies pure views (the TOC).
 *
 * The two skips are the ones plugin-listener used to give us for free:
 *   • before the editor has settled, create()'s own content-setting
 *     transactions would otherwise save a file merely opened;
 *   • an INBOUND external change must not echo back to the extension as a
 *     save — the content came FROM the file. _applyExternalNow re-baselines
 *     `_savedMarkdown` immediately after dispatching, which would make the
 *     echo a no-op at syncNow()'s equality check anyway, but that is a
 *     property of the diff, not a decision; suppressing the request outright
 *     keeps the intent explicit and saves a pointless O(document) serialize.
 *     `_applyingExternal` is the span-scoped mechanism for this — see its
 *     declaration for why the per-transaction meta cannot express it.
 * Views are still told about an external change — the doc really did change.
 */
function onDocChanged(): void {
    if (_isSettled && _hasUserInteracted && !_applyingExternal) {
        _docChangeCount++;
        _scheduler.request();
    } else if (_stream && _hasUserInteracted && !_applyingExternal && !_appendingChunk) {
        // The user edited a document still arriving. Nothing syncs until the
        // document is whole; this is the sync owed then (finishOpen).
        _editedWhileStreaming = true;
    }
    _onDocChange?.();
}

/**
 * Serialize immediately for a save flush and return the freshest file-ready
 * (display-space) markdown, whether or not it changed since the last sync.
 * Cancels any pending sync and returns the scheduler to its leading-ready
 * posture so the FIRST edit after this save dirties the document immediately
 * (a quick edit-then-save right after a prior save must not land in the
 * trailing window and no-op). Called from the `flushSave` handler when the
 * extension's onWillSaveTextDocument participant is about to write.
 *
 * The merge is parked as a CANDIDATE, not committed: the extension may still
 * discard this reply (flush timeout, stale version, superseded seq), and a
 * baseline advanced on a discarded flush diffs every later save against bytes
 * that never reached the file — worse, the reset above has already cancelled
 * the pending trailing sync, so with the baseline also advanced the equality
 * check in syncNow() would suppress the recovery post forever and the
 * trailing-window edits would strand in the webview behind a clean save
 * (MAR-349). `acknowledgeFlush` commits or abandons the candidate when the
 * extension's verdict arrives.
 */
export function flushPendingEdit(id: string): string {
    _scheduler.reset();
    // Unsettled means the document is not whole (a progressive open still
    // streaming, or a create in flight): the saved bytes are the only ones
    // that describe the whole file, and serializing the editor here would
    // write a truncated one.
    if (!_editor || !_isSettled) { return _savedMarkdown; }
    // A serialization of its own: any worker answer still in flight is now
    // older than the bytes about to reach the file, and is dropped when it
    // lands (see `_serialSeq`).
    ++_serialSeq;
    const { text, canonical } = mergeForSave(_editor, _editor.action(getMarkdown()));
    _flushCandidate = { id, text, canonical, docChangeCount: _docChangeCount };
    return text;
}

/**
 * The extension's verdict on a flush this webview answered (`flushAck`).
 * Applied: those bytes are on the document, so the baseline advances to them
 * and a canonical merge's protection-drop lands (see dropCanonicalProtection).
 * Discarded: the baseline stays where the file is, and a sync is requested so
 * the flushed content re-posts as a normal update — re-dirtying the document
 * and un-stranding the edits the discarded flush had captured.
 *
 * An ack for a superseded candidate (a later sync or external re-base already
 * moved the baseline, or a newer flush replaced it) is dropped: the candidate's
 * serialize is older than the state it would overwrite. After an applied
 * commit, a doc change that landed while the ack was in flight owes a re-sync
 * against the NEW baseline — its own leading-edge sync may have no-opped
 * against the old one (an edit reverting to the pre-save state compares equal
 * to the old baseline and posts nothing, which would strand it now that the
 * document holds the flushed bytes).
 */
export function acknowledgeFlush(id: string, applied: boolean): void {
    const candidate = _flushCandidate;
    if (!candidate || candidate.id !== id) { return; }
    _flushCandidate = null;
    if (applied) {
        _savedMarkdown = candidate.text;
        if (candidate.canonical) { dropCanonicalProtection(); }
        if (_docChangeCount !== candidate.docChangeCount) { _scheduler.request(); }
    } else {
        _scheduler.request();
    }
}

/**
 * Lift `_hasUserInteracted` on the first real user input.
 *
 * This flag is the SOLE gate between a doc-changing transaction and a dirty
 * TextDocument (see onDocChanged): while it is down, no sync is requested, so
 * the document never dirties, so onWillSaveTextDocument never fires — a Cmd+S
 * silently writes nothing. Any input channel that can change the doc without
 * first tripping a listener here is therefore a data-loss path, not a cosmetic
 * gap. The list must stay a superset of the ways text can enter the editor.
 *
 * `beforeinput` is the broad net: it precedes every editable mutation — IME
 * commits, dictation, autofill, Android soft keyboards, virtual keyboards — many
 * of which never emit a `keydown`. `compositionstart` covers the IME case
 * explicitly and fires even earlier. Both are cheap one-way flags, so overlap
 * with keydown/mousedown costs nothing and the redundancy is deliberate: it
 * retires the whole "input method that doesn't fire keydown ⇒ Cmd+S no-ops"
 * class rather than the one instance we happened to think of.
 *
 * These fire only on genuine DOM input; programmatic transactions (loading a
 * file, plugin normalization) emit none, so opening a document still cannot
 * trigger a silent save.
 */
/**
 * Harness probes, and never on the user's path. Installed only when the perf
 * harness is driving the page (its init marker is on the window), so no
 * production webview carries a global for them, and `e2e/perf.mjs` calls
 * them after the settle marks and prints each beside the spans. Both are
 * WARM readings: the parser and serializer have already run on this text, so
 * a cold span is larger than the pieces' sum, and what each answers is which
 * piece dominates, never how long any takes cold.
 *
 * `parseSplit` (MAR-434): how `create`'s parse splits between the markdown
 * half (remark parse and run, where the callout and directive tree
 * transforms live) and the ProseMirror construction from mdast. Both happen
 * inside one `parserCtx` call, so the split is read from outside: the remark
 * processor alone gives the first half, the whole parse gives the sum, and
 * construction is the difference.
 *
 * `syncSplit` (MAR-430): what one sync costs, piece by piece, on the
 * document as it stands: the serialize, the minimal-diff merge, the live
 * fingerprint, and the verifying reparse of the merged bytes. `offThread`
 * says whether this document's syncs send that reparse to the verify worker,
 * so the reading says which pieces the interaction thread still pays. It is
 * how MAR-432 sizes its next tier.
 */
function installPerfProbes(editor: Editor, markdown: string): void {
    const host = globalThis as { __perfInit?: unknown; __birtaPerf?: unknown };
    if (host.__perfInit === undefined) return;
    host.__birtaPerf = {
        parseSplit(): { mdast: number; pm: number; chars: number } {
            const remark = editor.action((ctx) => ctx.get(remarkCtx));
            const t0 = performance.now();
            // The transforms read the source through the file, as the real
            // parser hands it to them; a bare tree throws inside the first
            // one that looks at a marker.
            remark.runSync(remark.parse(markdown), markdown);
            const t1 = performance.now();
            editor.action((ctx) => ctx.get(parserCtx)(markdown));
            const t2 = performance.now();
            const mdast = t1 - t0;
            return { mdast, pm: (t2 - t1) - mdast, chars: markdown.length };
        },
        syncSplit(): { serialize: number; merge: number; fingerprint: number; reparse: number; chars: number; offThread: boolean } {
            const t0 = performance.now();
            const serialized = editor.action(getMarkdown());
            const t1 = performance.now();
            const merged = applyMinimalChanges(_savedMarkdown, serialized, format.formatProfile, getProtection());
            const t2 = performance.now();
            fingerprintDoc(editor.action((ctx) => getState(ctx).doc));
            const t3 = performance.now();
            editor.action((ctx) => ctx.get(parserCtx)(merged));
            const t4 = performance.now();
            return {
                serialize: t1 - t0,
                merge: t2 - t1,
                fingerprint: t3 - t2,
                reparse: t4 - t3,
                chars: serialized.length,
                offThread: serialized.length >= _offThreadMinChars && offThreadOracle() !== null,
            };
        },
    };
}

function setupInteractionTracking(): void {
    if (_interactionListenerAdded) return;
    _interactionListenerAdded = true;
    const mark = () => { _hasUserInteracted = true; };
    document.addEventListener('keydown',          mark, { capture: true });
    document.addEventListener('mousedown',        mark, { capture: true });
    document.addEventListener('paste',            mark, { capture: true });
    document.addEventListener('drop',             mark, { capture: true });
    document.addEventListener('cut',              mark, { capture: true });
    document.addEventListener('compositionstart', mark, { capture: true });
    document.addEventListener('beforeinput',      mark, { capture: true });
}

/**
 * Merge a background agent's result into the live document (plugins/
 * agentPending's dirty-document path). Applied as an ordinary transaction, so
 * it enters the undo history and the sync writes it out like a user edit.
 */
export function mergeAgentResult(requestId: string, text: string): "applied" | "partial" | "conflict" | "unchanged" {
    if (!_editor) { return "conflict"; }
    const editor = _editor;
    return editor.action((ctx) => applyAgentResult(
        getView(ctx),
        requestId,
        text,
        (markdown) => ctx.get(parserCtx)(markdown) as ProseNode | null,
    ));
}

export function getEditorView(): EditorView | null {
    if (!_editor) {
        return null;
    }
    return _editor.action((ctx) => getView(ctx));
}

/**
 * Applies an inbound external document change as a cursor-preserving minimal
 * diff. Returns false when the caller must fall back to a full rebuild
 * (revert). While the user is mid-IME-composition the content is deferred and
 * applied on compositionend; a deferred call still returns true (handled, no
 * fallback).
 *
 * `newMarkdown` is DISPLAY-space content (image src already mapped to webview
 * URIs by the extension), matching the editor's own doc.
 */
export function syncExternalContent(newMarkdown: string): boolean {
    if (!_editor) {
        return false;
    }
    if (_isComposing) {
        _pendingExternalMarkdown = newMarkdown;
        return true;
    }
    return _applyExternalNow(newMarkdown);
}

/** Applies the external content now and re-baselines the save state. */
function _applyExternalNow(newMarkdown: string): boolean {
    if (!_editor) {
        return false;
    }
    // Scoped across the dispatch so the doc-change subscriber can tell this
    // transaction — and everything plugins reentrantly derive from it — from
    // a user edit and not echo it back as a save. ProseMirror dispatches
    // synchronously, so the flag is down again before this returns (an
    // assumption pinned by savePipeline's no-echo test; see the flag's
    // declaration).
    let applied: boolean;
    _applyingExternal = true;
    try {
        // An agent's answer to a request made here is the user's own edit
        // and undoes like one; every other inbound change stays out of history.
        const view = _editor.action((ctx) => getView(ctx));
        applied = applyExternalSync(_editor, newMarkdown, { intoHistory: recordsExternalInHistory(view) });
    } finally {
        _applyingExternal = false;
    }
    if (!applied) {
        return false;
    }
    // The file's content has replaced the document wholesale, so a stream
    // still appending the old content is stopped (its chunks land only on
    // idle slices, so none can land between the apply and this), and the
    // pipeline settles on the whole document that is now on screen.
    if (_stream) {
        _stream.cancel();
        _stream = null;
        setProgressiveStreaming(false);
        _editedWhileStreaming = false;
        mark("stream-end");
        measure("stream", "stream-start", "stream-end");
        _isSettled = true;
    }
    // Re-baseline against the freshly applied content so the NEXT genuine user
    // edit diffs against the right bytes (and the debounced listener never
    // echoes the external change back to the extension as a save). Protection
    // is recomputed because a different file may have different round-trip
    // trouble spots (reference links, setext headings, ...).
    _savedMarkdown = newMarkdown;
    // The host's document now holds exactly this content, which is the clean
    // posture a save flush leaves: the next user edit is a leading edge again
    // (webview/syncScheduler.ts), so it dirties the document before a Cmd+S
    // can reach it. A sync still pending from before the apply is cancelled
    // with it; it would serialize the applied content and post nothing.
    _scheduler.reset();
    // An authoritative re-base supersedes any flush still awaiting its ack.
    _flushCandidate = null;
    // Recompute eagerly here (not a launch path) and drop any deferred load
    // snapshot so getProtection() returns this fresh, authoritative protection.
    _protectionSnapshot = null;
    _protection = computeRoundTripProtection(
        newMarkdown,
        _editor.action(getMarkdown()),
        format.formatProfile,
    );
    return true;
}

export async function createEditor(
    container: HTMLElement,
    initialMarkdown: string,
    onUpdate: (markdown: string) => void,
    onDocChange?: () => void,
    formatModule: FormatModule = markdownFormat,
): Promise<Editor> {
    // Rebind the active format FIRST: everything below (mergeForSave,
    // protection, the .use() chain) reads the module-level binding.
    format = formatModule;
    // Plugins normalize the freshly loaded document asynchronously (RAF/
    // microtask) after create() returns, by which point _isSettled is already
    // true — and those are real doc changes, so the doc-change hook reports
    // them. _hasUserInteracted is what keeps merely OPENING a file from
    // serializing and posting a save; only real user input lifts it.
    _hasUserInteracted = false;
    _isSettled = false;
    _applyingExternal = false;
    // Disown the previous editor NOW, not when the new one lands: initEditor
    // has already destroyed it, so from here until create() completes the old
    // reference is a torn-down editor whose ctx access throws. Nulling it (and
    // the protection derived from it) sends every downstream guard — syncNow,
    // flushPendingEdit, getEditorView, syncExternalContent — down its safe
    // branch for the whole create window, and a FAILED create simply leaves
    // this inert state in place instead of resurrecting the stale reference
    // (MAR-148).
    _editor = null;
    _protection = null;
    _protectionSnapshot = null;
    setupInteractionTracking();

    // Reset the outbound sync pipeline for this editor instance.
    _onUpdate = onUpdate;
    _onDocChange = onDocChange ?? null;
    // Re-pointed per editor instance, so a destroyed editor's subscriber never
    // outlives its replacement (initEditor destroys before it recreates).
    setDocChangeListener(onDocChanged);
    _scheduler.reset();
    _isComposing = false;
    _pendingExternalMarkdown = null;
    // Re-baseline the saved bytes BEFORE the first await, not inside create()'s
    // config callback: flushSave answers with _savedMarkdown unconditionally,
    // so if create fails partway a flush must return THIS document's bytes —
    // leaving the predecessor's here would let a Cmd+S after a failed re-init
    // write the previous content back over the file (MAR-148).
    _savedMarkdown = initialMarkdown;
    _flushCandidate = null;
    // A worker answer for the previous editor settles against this one and
    // reads as stale; it must not hold this editor's first sync back.
    _inFlight = null;
    _syncOwed = false;
    // A stream still appending the previous document would append it to this one.
    _stream?.cancel();
    _stream = null;
    setProgressiveStreaming(false);
    _appendingChunk = false;
    _editedWhileStreaming = false;
    // How this document opens: whole, or on its first screen with the rest
    // streamed in (progressiveOpen.ts). Decided once, here, so the frame in
    // index.ts, the initial value below and the stream after create agree.
    const plan = planProgressiveOpen(initialMarkdown, format, _progressiveMinChars);
    const headingIds: HeadingIdSeed = {};

    // One live listener pair per editor instance (see _compositionAbort).
    _compositionAbort?.abort();
    _compositionAbort = new AbortController();
    const { signal } = _compositionAbort;

    container.addEventListener('compositionstart', () => {
        _isComposing = true;
    }, { signal });
    container.addEventListener('compositionend', () => {
        _isComposing = false;
        // Apply any inbound external sync that arrived mid-composition first, so
        // the file's authoritative state wins; a now-stale outbound sync below
        // is harmless (the extension's version check drops and re-pushes it).
        if (_pendingExternalMarkdown !== null) {
            const md = _pendingExternalMarkdown;
            _pendingExternalMarkdown = null;
            _applyExternalNow(md);
        }
        // Ship any edit that landed during composition, now that it's committed.
        _scheduler.compositionEnded();
    }, { signal });

    // Register syntax grammars before create when the document already contains a
    // fenced code block, so the prism plugin highlights it on the first paint. A
    // document with no code skips the grammar chunk entirely; a code
    // block added later loads it via the code-block NodeView.
    if (/(^|\n)[ \t]{0,3}(```|~~~)/.test(initialMarkdown)) {
        await ensureGrammars();
    }

    mark("create-start");
    // ── Format-agnostic chrome, pre-preset ──────────────────────────────────
    // Keymap plugins that must register BEFORE the format's presets so they
    // win over the preset defaults. They are chrome, not format: each one
    // no-ops when the schema lacks its target node, so they are safe (if
    // idle) under any format. The judgment call: block-specific keymaps and
    // commands (table, callout, footnote, hr) — and the fold/callout plugins
    // below — stay chrome for now rather than moving into the format module;
    // they migrate only when a second format actually needs to vary them.
    let builder = Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, container);
            ctx.set(defaultValueCtx, plan ? plan.first : initialMarkdown);
            // Layer 1 of the read-only lock (MAR-53; see webview/readOnly.ts).
            // A PREDICATE, not a constant: ProseMirror re-reads it on every
            // view update, so the toolbar toggle is live and needs only the
            // empty setProps the read-only plugin's view() issues. Reading the
            // mode at config time instead would bake the launch value in and
            // make the toggle reload-only.
            ctx.update(editorViewOptionsCtx, (prev) => ({
                ...prev,
                editable: () => !isReadOnly(),
            }));
            // Heading ids onto the parsed document before the state is built,
            // so the view never has to redraw every heading to receive them.
            // See plugins/headingIdSync. The seed is shared with the chunks a
            // progressive open appends, so their ids continue this count.
            configureHeadingIds(ctx, headingIds);
            // Format-supplied stringify options that keep serializer output
            // close to the original file formatting (bullets, rules, table
            // widths).
            format.configureSerialization(ctx);
            // Configure prism: use our refractor instance with the languages we registered
            ctx.set(prismConfig.key, {
                configureRefractor: () => refractor,
            });
            // Format-supplied NodeViews (code-block chrome, callouts,
            // directives, footnotes, math, tables, inline HTML, images),
            // each behind the per-node crash boundary: a NodeView that
            // throws degrades ITS node to default rendering instead of
            // failing the mount or unwinding a keystroke's dispatch.
            ctx.set(
                nodeViewCtx,
                format.nodeViews.map(([nodeId, factory]) =>
                    [nodeId, guardNodeViewFactory(nodeId, factory)] as [string, typeof factory]),
            );
        })
        // Registered BEFORE the commonmark/base keymap so table Tab/Enter/Delete
        // win over the defaults (e.g. base Backspace only clears cell contents).
        // mathInlineEdit is even earlier: its boundary keys (arrow into / backspace
        // against a formula) are narrowly guarded and must beat every other handler.
        .use(mathInlineEditPlugin)
        // wikiLinkEdit is the same shape over `wiki_link` (MAR-74), and shares
        // the reason: its boundary keys must beat the base keymap. The two
        // never contend — each returns false unless the caret is in its own
        // node type.
        .use(wikiLinkEditPlugin)
        // Live inline HTML pairs + the Mod-Enter source-panel opener. Early
        // for the same reason as mathInlineEdit: Mod-Enter on an html
        // NodeSelection must beat insertParagraph's Mod-Enter.
        .use(htmlLivePairsPlugin)
        .use(htmlEditKeymapPlugin)
        // Backtick-over-a-selection wraps in inline code. Ahead of the presets
        // for the same reason: it shares handleTextInput with the input-rule
        // runner, and the first prop to return true wins.
        .use(backtickWrapPlugin)
        .use(tableKeymapPlugin)
        // Smart-select chords beat native contenteditable selection keys;
        // insertParagraph's Mod-Enter beats the preset's (its commands return
        // false inside code blocks/tables so the preset's exit-block Mod-Enter
        // keeps working).
        .use(smartSelectKeymapPlugin)
        // Fold-boundary reveals (Backspace/Delete/Enter at a fold edge expand
        // instead of editing hidden or invisible content). Before
        // insertParagraphKeymapPlugin and the presets: revealOnEnter must
        // dispatch its unfold (it never consumes the key) before the default
        // Enter / Mod-Enter handlers act, so the new block lands visibly.
        .use(foldRevealKeymapPlugin)
        .use(insertParagraphKeymapPlugin)
        // A vertical arrow at the first/last position of a block (or of a
        // table) whose other side is a gap cursor. Must be registered here, in
        // front of the presets: prosemirror-tables (GFM preset, below) resolves
        // a table-edge arrow with a gap-cursor-unaware `Selection.near` and so
        // lands the caret inside the NEXT table. Every other arrow declines.
        // See plugins/gapCursor.ts.
        .use(blockEdgeGapCursorKeymapPlugin);
    // ── The format ──────────────────────────────────────────────────────────
    // The presets that define the format's schema, parser, and serializer
    // (markdown: pureCommonmark then gfmFidelity — order per their charters
    // in serialization.ts, MAR-143).
    for (const preset of format.presets) {
        builder = builder.use(preset);
    }
    // ── Format-agnostic chrome, post-preset ─────────────────────────────────
    builder = builder
        // Synchronous doc-change reporting: drives BOTH the outbound save
        // pipeline and pure views (the TOC) — see plugins/docChange. Milkdown's
        // plugin-listener is deliberately not registered: its unconditional
        // 200ms debounce is what MAR-145 removed from the save path, and it has
        // no other consumer.
        .use(docChangePlugin)
        // `prismPlugin` used to be filtered out here and replaced by ours: it
        // ran two whole-document `findChildren` walks on EVERY transaction,
        // selection-only ones included, which was 71% of a selection-only
        // `state.apply` on the 300 KB fixture (MAR-137). That fix went
        // upstream and shipped in 7.22.0 (Milkdown #2436), together with a
        // correctness fix ours never had — a language change on any but the
        // FIRST code block now re-highlights (#2440).
        .use(prism)
        .use(historyPlugin)
        .use(historyKeymapPlugin)
        .use(listLiftPlugin)
        .use(listEnterPlugin)
        .use(horizontalRulePlugin)
        .use(horizontalRuleKeymapPlugin)
        .use(insertHorizontalRuleCommand)
        .use(codeBlockBackspacePlugin)
        .use(codeBlockSelectAllPlugin)
        .use(headingEmptyDeletePlugin)
        .use(headingAbsoluteInputRule)
        .use(selectionPlugin)
        .use(pendingRangePlugin)
        .use(slashArgumentHintPlugin)
        .use(emptyLineHintPlugin)
        .use(headingFoldPlugin)
        .use(headingStickyPlugin)
        .use(caretScrollMarginPlugin)
        .use(formatKeymapPlugin)
        .use(insertCalloutCommand)
        .use(toggleHighlightCommand)
        .use(insertFootnoteCommand)
        .use(footnoteReferenceInputRule)
        .use(footnoteNumberingPlugin)
        .use(linkInputRule)
        .use(linkUrlCompletePlugin)
        // Pasting a URL over a selection links the selection instead of
        // replacing it (handlePaste; no other plugin registers one).
        .use(pasteLinkPlugin)
        // Native copy/cut put the selection's Markdown source on the
        // clipboard's plain-text flavor (clipboardTextSerializer; gated on
        // birta.copyFormat).
        .use(copyMarkdownPlugin)
        // ...and the other direction: a plain-text paste is parsed as Markdown
        // rather than inserted as literal, later-escaped text
        // (clipboardTextParser; gated on birta.pasteFormat, and on the
        // Shift+Cmd+V plain-paste flag).
        .use(pasteMarkdownPlugin)
        // A GFM cell is inline-only: whatever either paste path produced,
        // flatten it to inline content when it lands in one, so the table
        // keeps its shape instead of gaining columns or splitting apart.
        .use(pasteContainerFitPlugin)
        // A pasted/dropped image saves through the extension host; show that
        // it is running (and any failure) as decoration at the paste
        // position, so the document is never touched by a save that fails.
        .use(imageUploadProgressPlugin)
        // An `/ai` request's marker in the gutter while its agent runs, and
        // the undo policy for the edit it brings back (see the plugin header).
        .use(agentPendingPlugin)
        // Must be a PM prop, not a DOM listener: a pasted image carries an
        // HTML <img> flavor too, and PM would insert that first.
        .use(imagePastePlugin)
        .use(wikiLinkCompletePlugin)
        // Typing `#` mid-prose (or the Section Link command) offers the
        // document's headings; picking inserts a plain [title](#slug) link.
        .use(headingLinkCompletePlugin)
        // Adjacent-list handling (two halves of one policy): edit-created
        // adjacency joins automatically; a split the SOURCE already carries
        // (a `-`→`*` marker change) is only offered — the caret advisory
        // here, plus the block menu's Merge rows. See editing/listMerge.
        .use(listAutoJoinPlugin)
        .use(listMergeSuggestPlugin)
        // Marks top-level image-only paragraphs (`img-block`) so CSS can
        // center standalone images and scope the per-block width breakout —
        // bare text siblings are invisible to :has(), so the class must come
        // from the model. Armed on idle; O(top-level) walk on doc changes.
        .use(imageBlocksPlugin)
        // Keeps the control column of the block holding the selection
        // visible (caret in a table cell / code block) — `bc-active` on
        // whitelisted NodeView hosts, O(1) per selection change.
        .use(activeBlockPlugin)
        // Scopes the native highlight/caret suppression of an INVISIBLE
        // selection (block range, node selection, cell selection) to the
        // blocks it touches — the rules it replaces were keyed to a class on
        // the editor root and re-styled the whole document on every toggle
        // (MAR-258). O(blocks in the selection), and nothing at all for the
        // visible selections typing and caret moves produce.
        .use(hiddenSelectionPlugin);

    // Inline calc-on-`=` (MAR-177): advisory suggestion by default, or an input
    // rule when birta.calc.autoInsert is on. Composed ONLY when the feature is
    // enabled — a disabled feature must cost nothing (design principle: "A
    // disabled feature costs nothing"). Left composed unconditionally, the
    // caret-suggest controller would still run its plugin-view update on every
    // transaction, allocating a 500-char match window per keystroke even though
    // every match short-circuits to null. __i18n is baked into the HTML before
    // this script runs, so calcEnabled is readable synchronously here (like
    // smartLinks). The internal autoInsert flag still decides which of the two
    // composed plugins actually fires.
    if (window.__i18n?.calcEnabled ?? true) {
        builder = builder
            .use(calcSuggestPlugin)
            .use(calcArrowSuggestPlugin)
            .use(calcAutoInsertPlugin)
            .use(calcRefreshPlugin)
            .use(calcStalePlugin);
    }

    // URL embeds (MAR-56/MAR-186): render a bare provider link (YouTube, Loom,
    // Figma, GitHub) as an inline card via a view-only decoration — the source
    // stays a plain link and round-trips byte-identically.
    //
    // Composed UNCONDITIONALLY, unlike the gates above it. A Milkdown plugin
    // cannot be composed after creation, so gating composition on the network
    // switch meant flipping that switch did nothing until the file was reopened
    // — the feature read as broken. The plugin is inert when gated off: its
    // decoration function returns DecorationSet.empty on the first read and its
    // view() schedules no idle pass, so "a disabled feature costs nothing"
    // still holds for the work, and only the plugin's own bytes are paid —
    // negligible against the eager baseline (`pnpm perf:bundle`). The card
    // builder and the
    // thumbnail are still lazy, so nothing reaches the network while off.
    // Re-gating is live in both directions via regateEmbeds (messageHandlers).
    try {
        // A failed chunk load degrades to "no embed cards" — it must not
        // reject createEditor and take the whole editor down with it. The
        // keymap (select/enter/delete around cards) composes beside the
        // decoration plugin: it is inert while the plugin state is empty, and
        // ordering is safe this late because Milkdown appends the base keymap
        // after user plugins (see blockKeys.ts).
        const { embedPlugin, embedKeymapPlugin } = await import("./plugins/embed");
        builder = builder.use(embedPlugin).use(embedKeymapPlugin);
    } catch (e) {
        console.error("[birta] embed plugin failed to load; continuing without embeds", e);
    }

    // Auto-update in-note anchor links on heading rename (MAR-180): when a
    // heading is renamed its slug changes, and every `[…](#old-slug)` pointing
    // at it is rewritten to the new slug in the SAME undo step. Composed ONLY
    // when enabled so a cautious user (birta.autoUpdateAnchors = false) pays
    // nothing — no appendTransaction registered, so not even the perf guard
    // runs (the plugin also self-gates for defense in depth). __i18n is baked
    // into the HTML before this script runs, so the flag reads synchronously
    // here (like calc/embeds).
    if (window.__i18n?.autoUpdateAnchors ?? true) {
        builder = builder.use(anchorSyncPlugin);
    }

    _editor = await builder
        .use(slashMenuPlugin)
        .use(tabKeymapPlugin)
        .use(blockKeysPlugin)
        .use(blockSourcePlugin)
        // The gap cursor itself: the caret widget, click-to-gap, and arrow
        // handling for every case blockEdgeGapCursorKeymapPlugin (above)
        // declines. Registered LAST among key handlers on purpose — each
        // narrowly-guarded arrow handler before it (math boundaries, table nav,
        // fold reveals, block keys, embed cards) answers a specific question
        // and declines otherwise, while this is the general "there is nowhere
        // else to go" fallback. It still beats prosemirror-view's built-in
        // arrow handling, which is what used to drop the caret inside the
        // neighbouring leaf. See plugins/gapCursor.ts.
        .use(gapCursorPlugin)
        // Content-conservation guard (MAR-108): filterTransaction is
        // consulted for every plugin regardless of registration order, so
        // the guard sees the final transaction wherever it sits in the list.
        .use(contentGuardPlugin)
        // Read-only lock (MAR-53), beside contentGuard because it is the same
        // shape and relies on the same property of filterTransaction. Composed
        // unconditionally: the mode is toggled per session from the toolbar, so
        // gating composition on the launch value would make the toggle
        // reload-only (the lesson the embed plugin's comment above records).
        // It costs one `tr.docChanged` read per transaction while off.
        .use(readOnlyPlugin)
        .use(cellClickFixPlugin)
        .use(listSpreadNormalizePlugin)
        .use(trailingHrParagraphPlugin)
        // Editor-note chips ([TK], TODO:, …). Beside proofreadPlugin because it
        // is the same kind of thing: a view-only decoration layer that settles
        // in after first paint and never reaches the serialized markdown.
        .use(noteMarkersPlugin)
        .use(proofreadPlugin)
        .create();
    mark("create-end");
    measure("create", "create-start", "create-end");

    // Per-transaction cost marks (mdw:tx-apply) — read by e2e/perf-typing.mjs
    // and available in devtools against any real document. Installed once per
    // editor instance; initEditor destroys before it recreates.
    instrumentTransactions(_editor.action((ctx) => getView(ctx)));
    installPerfProbes(_editor, initialMarkdown);

    // A document past the off-thread floor starts its verify worker now, in
    // idle time after the mount, and runs the worker's parser over the text
    // once so the first sync's question is answered warm. The main thread
    // pays a Blob and a constructor; the parse is the worker's.
    if (initialMarkdown.length >= _offThreadMinChars) {
        requestIdle(() => offThreadOracle()?.warm(initialMarkdown), 5000);
    }

    // The rest of the document, or the whole of it already: either way the
    // pipeline settles in finishOpen, and `stream` measures the gap. A
    // stream that cannot finish (a chunk the parser refused, which markdown
    // never does) leaves the pipeline unsettled rather than settling on a
    // partial document, and reports through the crash boundary.
    mark("stream-start");
    if (plan) {
        const editor = _editor;
        // The document as parsed, chunk by chunk, for the protection
        // snapshot: the first chunk is the state's own document before
        // anything could touch it, and every later chunk adds its blocks as
        // it lands.
        const pristine: ProseNode[] = [];
        editor.action((ctx) => getState(ctx).doc).forEach((block) => pristine.push(block));
        setProgressiveStreaming(true);
        const stream = streamChunks(plan.rest, (text) => appendChunk(editor, text, headingIds, pristine));
        _stream = stream;
        stream.done.then(
            (complete) => {
                if (_stream !== stream) return; // superseded by a re-init or an external sync
                _stream = null;
                if (complete) finishOpen(editor, initialMarkdown, pristine);
            },
            (e: unknown) => {
                if (_stream === stream) _stream = null;
                throw e;
            },
        );
    } else {
        finishOpen(_editor, initialMarkdown, null);
    }
    return _editor;
}
