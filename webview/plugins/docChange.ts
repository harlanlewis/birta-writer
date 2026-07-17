/**
 * plugins/docChange.ts
 *
 * A synchronous "the document changed" hook — the single trigger for both the
 * outbound save pipeline and pure VIEWS of the document (the TOC outline).
 *
 * Deliberately NOT Milkdown's `listenerCtx.updated`, which wraps its callbacks
 * in `debounce(fn, 200)` (lodash, trailing). That debounce hurt both consumers:
 * a view riding it lags the document by up to 200ms and, being *trailing*,
 * stops updating entirely during continuous typing until the user pauses (an
 * outline that trails the text it describes reads as broken); and upstream of
 * the save pipeline it defeated syncScheduler's leading edge, so the first
 * keystroke took ~208ms to dirty the TextDocument and a Cmd+S inside that
 * window silently didn't write it (MAR-145). Both consumers do their own
 * coalescing — the TOC batches to one rAF, the save pipeline has syncScheduler
 * — so this plugin's only job is to report the change the instant it happens.
 *
 * A ProseMirror plugin view's `update` runs synchronously inside
 * `EditorView.updateState`, i.e. once per applied transaction. Doc identity is
 * the gate: ProseMirror reuses the doc node when a transaction changes only
 * the selection, so `prevState.doc !== view.state.doc` is an O(1) test for
 * "content actually changed" — no walk, no compare. Unlike plugin-listener this
 * does NOT skip `addToHistory: false` transactions: a transaction that changes
 * the doc must reach the save pipeline however it is tagged, since the tag
 * governs undo history, not persistence.
 *
 * Subscribers that need to distinguish an inbound external change from a user
 * edit do so at their own layer, and the two layers deliberately use two
 * mechanisms for two different questions (MAR-152):
 *   - "is THIS TRANSACTION part of a sync?" → the `EXTERNAL_SYNC_META`
 *     transaction meta (set by externalSync.ts, read by slashMenu's history
 *     gate);
 *   - "is this doc change CAUSED BY the sync?" → `_applyingExternal` in
 *     editor.ts, a flag spanning the synchronous dispatch. These are not
 *     interchangeable: capturing the meta into plugin state here was tried
 *     (2026-07-17) and failed savePipeline's no-echo pin, because plugins
 *     react to a sync by dispatching NEW transactions reentrantly — those
 *     carry neither the meta nor ProseMirror's `appendedTransaction` stamp,
 *     so no per-transaction provenance can cover the span. The flag's
 *     synchronous-dispatch assumption is itself pinned by that same test: an
 *     async refactor of the sync path would un-suppress the echo and turn
 *     the test red.
 */
import { Plugin, PluginKey } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";

/** The transaction meta marking an inbound external sync. One definition —
 * set by externalSync.ts, read by per-transaction consumers (slashMenu's
 * history gate). Span-scoped consumers use editor.ts's `_applyingExternal`
 * instead — see the module header for why the two cannot be unified. */
export const EXTERNAL_SYNC_META = "external-sync";

export const docChangeKey = new PluginKey("birta-doc-change");

let _listener: (() => void) | null = null;

/**
 * Register the doc-change subscriber (null clears it). Module-level rather
 * than per-editor because the plugin is constructed inside Milkdown's ctx and
 * the webview only ever has one live editor — the same singleton posture
 * blockMenu's editor context uses. createEditor re-sets it per instance, so a
 * destroyed editor's subscriber never outlives its replacement.
 */
export function setDocChangeListener(fn: (() => void) | null): void {
    _listener = fn;
}

export const docChangePlugin = $prose(
    () =>
        new Plugin({
            key: docChangeKey,
            view: () => ({
                update: (view, prevState) => {
                    if (prevState.doc !== view.state.doc) {
                        _listener?.();
                    }
                },
            }),
        }),
);
