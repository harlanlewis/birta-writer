import {
    defaultValueCtx,
    Editor,
    editorViewCtx,
    nodeViewCtx,
    rootCtx,
    serializerCtx,
} from "@milkdown/core";
import { prism, prismConfig } from "@milkdown/plugin-prism";
import type { EditorView } from "@milkdown/prose/view";
import type { Node as ProseNode } from "@milkdown/prose/model";
import DOMPurify from "dompurify";
import { createCalloutView, createNotionCalloutView } from "./components/callout";
import { createCodeBlockView } from "./components/codeBlock";
import { createDirectiveView } from "./components/directive";
import {
    createFootnoteDefinitionView,
    createFootnoteReferenceView,
} from "./components/footnote";
import { createImageView } from "./components/imageView";
import { createMathInlineView } from "./components/math";
import { createTableView } from "./components/table/tableView";
import { getMarkdown } from "@milkdown/utils";
import { refractor, ensureGrammars } from "./highlighter";
import { applyExternalSync } from "./externalSync";
import { instrumentTransactions, mark, measure } from "./perf";
import { configureSerialization, gfmFidelity, pureCommonmark } from "./serialization";
import { createSyncScheduler } from "./syncScheduler";
import {
    applyMinimalChanges,
    computeRoundTripProtection,
    type RoundTripProtection,
} from "./utils/minimalDiff";
import {
    caretScrollMarginPlugin,
    cellClickFixPlugin,
    codeBlockBackspacePlugin,
    contentGuardPlugin,
    codeBlockSelectAllPlugin,
    docChangePlugin,
    setDocChangeListener,
    footnoteNumberingPlugin,
    footnoteReferenceInputRule,
    foldRevealKeymapPlugin,
    formatKeymapPlugin,
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
    linkInputRule,
    linkUrlCompletePlugin,
    pasteLinkPlugin,
    mathInlineEditPlugin,
    wikiLinkCompletePlugin,
    listEnterPlugin,
    listLiftPlugin,
    listSpreadNormalizePlugin,
    pendingRangePlugin,
    proofreadPlugin,
    selectionPlugin,
    slashMenuPlugin,
    smartSelectKeymapPlugin,
    insertParagraphKeymapPlugin,
    tabKeymapPlugin,
    blockKeysPlugin,
    tableKeymapPlugin,
    toggleHighlightCommand,
    trailingHrParagraphPlugin,
} from "./plugins";

export { registerSelectionChangeHandler, setLogTableSel } from "./plugins";

// ── HTML inline NodeView ───────────────────────────────────────────────────
// Milkdown's html node (atom, inline) displays the raw tag as textContent by
// default. This NodeView renders real HTML after DOMPurify sanitization for a
// read-only preview. HTML comments would be sanitized away entirely — making
// them invisible and impossible to reason about in the editor — so they are
// rendered as a dimmed chip showing the raw comment text instead.
export function createHtmlView(node: { attrs: Record<string, string> }) {
    const dom = document.createElement("span");
    dom.dataset["type"] = "html";
    const raw = node.attrs["value"] ?? "";
    if (/^<!--[\s\S]*?-->$/.test(raw.trim())) {
        dom.className = "html-inline html-comment";
        dom.textContent = raw.trim();
        dom.title = "HTML comment — preserved in the file, hidden in rendered output";
    } else {
        dom.className = "html-inline";
        dom.innerHTML = DOMPurify.sanitize(raw, {
            USE_PROFILES: { html: true },
            ADD_ATTR: ["align", "width", "height"],
        });
    }
    return {
        dom,
        ignoreMutation: () => true,
        stopEvent: () => false,
    };
}

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

/**
 * Return the current round-trip protection, computing it from the pristine
 * snapshot on first demand (and caching it). Called before every save so an
 * edit that arrives before the idle precompute still diffs against the correct,
 * pristine-derived protection. The snapshot is bound to its editor instance, so
 * a deferred callback that fires after the editor was destroyed or replaced is a
 * no-op (guarded, since ctx access on a torn-down editor throws).
 */
function getProtection(): RoundTripProtection | null {
    if (_protection) return _protection;
    const snap = _protectionSnapshot;
    if (snap && snap.editor === _editor) {
        try {
            const serialized = snap.editor.action((ctx) => ctx.get(serializerCtx)(snap.doc));
            _protection = computeRoundTripProtection(snap.baseline, serialized);
        } catch {
            // Editor torn down before the deferred compute ran — no live save
            // path to protect, so leave protection unset.
        }
        _protectionSnapshot = null;
    }
    return _protection;
}

/** Precompute the deferred protection during idle, off the launch path. */
function scheduleProtection(): void {
    const ric = (globalThis as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
    }).requestIdleCallback;
    if (ric) ric(() => getProtection(), { timeout: 2000 });
    else setTimeout(() => getProtection(), 0);
}

// Whether the user has interacted with the editor yet (keyboard/mouse/paste/...)
// Reset to false on every createEditor() so that "just opening a file" never triggers an autosave.
let _hasUserInteracted = false;
let _interactionListenerAdded = false;

// Set once createEditor() has finished wiring an editor. Setting the initial
// content during create() dispatches doc-changing transactions; this blocks
// them from reaching the sync pipeline so opening a file never causes a silent
// save. Module-scoped (like _hasUserInteracted) because the doc-change
// subscriber is registered before the editor — and therefore before any local
// would be initialized.
let _isSettled = false;

// True only for the synchronous span in which an INBOUND external change is
// being dispatched. ProseMirror's dispatch runs plugin views synchronously, so
// this is precisely scoped to the external-sync transaction and read by the
// doc-change subscriber to keep that change from echoing back as a save (see
// _applyExternalNow).
let _applyingExternal = false;

// IME composition state, hoisted to module scope so inbound external syncs can
// defer while the user is mid-composition (see syncExternalContent). The
// outbound save pipeline reads it too, so a pinyin/kana candidate is never sent
// to the file half-formed.
let _isComposing = false;
// Latest external content that arrived DURING composition, applied on
// compositionend. Only the most recent push matters — older ones are stale.
let _pendingExternalMarkdown: string | null = null;

// ── Outbound sync pipeline (view → document) ───────────────────────────────
// Driven by docChangePlugin, which reports every doc-changing transaction
// SYNCHRONOUSLY (see onDocChanged below). The trigger is O(1): it flags that an
// edit happened and asks the scheduler when to sync. SERIALIZATION (whole-doc
// `getMarkdown()` + `applyMinimalChanges` + round-trip protection) is expensive
// — O(document size), ~49 ms on a 300 KB doc — so it runs ONLY in syncNow(),
// never on the keystroke path, and the scheduler keeps it off mid-burst
// (leading edge → dirty ASAP; trailing debounce → don't re-serialize while
// typing; max-wait → bound crash-safety staleness). The definitive freshest
// content is always captured at save via flushPendingEdit() regardless of where
// the debounce sits. The scheduling policy lives in webview/syncScheduler.ts
// (unit-tested there).
//
// This deliberately does NOT ride Milkdown's `listenerCtx.updated`, which wraps
// every callback in a lodash `debounce(fn, 200)` (trailing). That debounce sat
// upstream of the scheduler and starved it (MAR-145), breaking two invariants:
//   • #2 — the first keystroke took ~208 ms to dirty the TextDocument, so a
//     Cmd+S inside that window found a clean document, never fired
//     onWillSaveTextDocument, and did not write the keystroke;
//   • #3 — being TRAILING, it reset on every keystroke, so typing continuously
//     never fired it at all: request() was never called, the scheduler's
//     max-wait could never engage, and the document stayed clean for the whole
//     burst (measured: no update across 3 s of typing).
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

/**
 * Serialize the live document, merge it into the saved bytes with round-trip
 * protection, and ship it to the extension if it substantively changed. The
 * scheduler guarantees this is never called mid-IME-composition.
 */
function syncNow(): void {
    if (!_editor) { return; }
    const markdown = _editor.action(getMarkdown());
    const toSave = applyMinimalChanges(_savedMarkdown, markdown, getProtection());
    if (toSave === _savedMarkdown) { return; } // no substantive change — no save
    _savedMarkdown = toSave;
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
 * Views are still told about an external change — the doc really did change.
 */
function onDocChanged(): void {
    if (_isSettled && _hasUserInteracted && !_applyingExternal) {
        _scheduler.request();
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
 */
export function flushPendingEdit(): string {
    _scheduler.reset();
    if (_editor) {
        const markdown = _editor.action(getMarkdown());
        _savedMarkdown = applyMinimalChanges(_savedMarkdown, markdown, getProtection());
    }
    return _savedMarkdown;
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

export function getEditorView(): EditorView | null {
    if (!_editor) {
        return null;
    }
    return _editor.action((ctx) => ctx.get(editorViewCtx));
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
    // transaction from a user edit and not echo it back as a save. ProseMirror
    // dispatches synchronously, so the flag is down again before this returns.
    let applied: boolean;
    _applyingExternal = true;
    try {
        applied = applyExternalSync(_editor, newMarkdown);
    } finally {
        _applyingExternal = false;
    }
    if (!applied) {
        return false;
    }
    // Re-baseline against the freshly applied content so the NEXT genuine user
    // edit diffs against the right bytes (and the debounced listener never
    // echoes the external change back to the extension as a save). Protection
    // is recomputed because a different file may have different round-trip
    // trouble spots (reference links, setext headings, ...).
    _savedMarkdown = newMarkdown;
    // Recompute eagerly here (not a launch path) and drop any deferred load
    // snapshot so getProtection() returns this fresh, authoritative protection.
    _protectionSnapshot = null;
    _protection = computeRoundTripProtection(
        newMarkdown,
        _editor.action(getMarkdown()),
    );
    return true;
}

export async function createEditor(
    container: HTMLElement,
    initialMarkdown: string,
    onUpdate: (markdown: string) => void,
    onDocChange?: () => void,
): Promise<Editor> {
    // Plugins normalize the freshly loaded document asynchronously (RAF/
    // microtask) after create() returns, by which point _isSettled is already
    // true — and those are real doc changes, so the doc-change hook reports
    // them. _hasUserInteracted is what keeps merely OPENING a file from
    // serializing and posting a save; only real user input lifts it.
    _hasUserInteracted = false;
    _isSettled = false;
    _applyingExternal = false;
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

    container.addEventListener('compositionstart', () => {
        _isComposing = true;
    });
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
    });

    // Register syntax grammars before create when the document already contains a
    // fenced code block, so the prism plugin highlights it on the first paint. A
    // document with no code skips the ~155 KB grammar chunk entirely; a code
    // block added later loads it via the code-block NodeView.
    if (/(^|\n)[ \t]{0,3}(```|~~~)/.test(initialMarkdown)) {
        await ensureGrammars();
    }

    mark("create-start");
    _editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, container);
            ctx.set(defaultValueCtx, initialMarkdown);
            // Stringify options that keep serializer output close to the
            // original file formatting (bullets, rules, table widths)
            configureSerialization(ctx);
            _savedMarkdown = initialMarkdown;
            // Configure prism: use our refractor instance with the languages we registered
            ctx.set(prismConfig.key, {
                configureRefractor: () => refractor,
            });
            // Register the code_block NodeView (top language picker + copy button)
            ctx.set(nodeViewCtx, [
                ["code_block", createCodeBlockView],
                ["callout", createCalloutView],
                ["notion_callout", createNotionCalloutView],
                ["container_directive", createDirectiveView],
                ["footnote_reference", createFootnoteReferenceView],
                ["footnote_definition", createFootnoteDefinitionView],
                ["math_inline", createMathInlineView],
                ["table", createTableView],
                ["html", (node: { attrs: Record<string, string> }) => createHtmlView(node)],
                [
                    "image",
                    (node, view, getPos) => createImageView(node, view, getPos),
                ],
            ]);
        })
        // Registered BEFORE the commonmark/base keymap so table Tab/Enter/Delete
        // win over the defaults (e.g. base Backspace only clears cell contents).
        // mathInlineEdit is even earlier: its boundary keys (arrow into / backspace
        // against a formula) are narrowly guarded and must beat every other handler.
        .use(mathInlineEditPlugin)
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
        .use(pureCommonmark)
        // gfm plus its mandatory after-gfm overrides (null table-cell alignment
        // default; boolean list `spread`, MAR-124). Bundled in serialization.ts
        // so tests can't wire gfm without them and diverge (MAR-143).
        .use(gfmFidelity)
        // Synchronous doc-change reporting: drives BOTH the outbound save
        // pipeline and pure views (the TOC) — see plugins/docChange. Milkdown's
        // plugin-listener is deliberately not registered: its unconditional
        // 200ms debounce is what MAR-145 removed from the save path, and it has
        // no other consumer.
        .use(docChangePlugin)
        .use(prism)
        .use(historyPlugin)
        .use(historyKeymapPlugin)
        .use(listLiftPlugin)
        .use(listEnterPlugin)
        .use(horizontalRulePlugin)
        .use(horizontalRuleKeymapPlugin)
        .use(codeBlockBackspacePlugin)
        .use(codeBlockSelectAllPlugin)
        .use(headingEmptyDeletePlugin)
        .use(headingAbsoluteInputRule)
        .use(selectionPlugin)
        .use(pendingRangePlugin)
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
        .use(wikiLinkCompletePlugin)
        .use(slashMenuPlugin)
        .use(tabKeymapPlugin)
        .use(blockKeysPlugin)
        // Content-conservation guard (MAR-108): filterTransaction is
        // consulted for every plugin regardless of registration order, so
        // the guard sees the final transaction wherever it sits in the list.
        .use(contentGuardPlugin)
        .use(cellClickFixPlugin)
        .use(listSpreadNormalizePlugin)
        .use(trailingHrParagraphPlugin)
        .use(proofreadPlugin)
        .create();
    mark("create-end");
    measure("create", "create-start", "create-end");

    // Per-transaction cost marks (mdw:tx-apply) — read by e2e/perf-typing.mjs
    // and available in devtools against any real document. Installed once per
    // editor instance; initEditor destroys before it recreates.
    instrumentTransactions(_editor.action((ctx) => ctx.get(editorViewCtx)));

    // Snapshot the pristine document and defer its round-trip protection off the
    // critical path (see _protectionSnapshot above): the zero-edit
    // re-serialization used to learn which regions the round trip cannot
    // reproduce would otherwise block first paint on large files.
    _protection = null;
    _protectionSnapshot = {
        baseline: initialMarkdown,
        doc: _editor.action((ctx) => ctx.get(editorViewCtx).state.doc),
        editor: _editor,
    };
    scheduleProtection();

    _isSettled = true;
    return _editor;
}
