/**
 * plugins/docChange.ts
 *
 * A synchronous "the document changed" hook for pure VIEWS of the document
 * (the TOC outline). Deliberately NOT Milkdown's `listenerCtx.updated`:
 * plugin-listener wraps its callbacks in `debounce(fn, 200)` (lodash, trailing)
 * — fine for the serialize/save pipeline it was built for, but it makes any
 * view riding it lag the document by up to 200ms, and *trailing* means a view
 * stops updating entirely during continuous typing until the user pauses. An
 * outline that trails the text it describes reads as broken, and the lag is
 * exactly the "sometimes it updates late" symptom.
 *
 * A ProseMirror plugin view's `update` runs synchronously inside
 * `EditorView.updateState`, i.e. once per applied transaction. Doc identity is
 * the gate: ProseMirror reuses the doc node when a transaction changes only
 * the selection, so `prevState.doc !== view.state.doc` is an O(1) test for
 * "content actually changed" — no walk, no compare.
 *
 * Subscribers own their own coalescing (the TOC batches to one rAF); this
 * plugin's only job is to report the change the instant it happens.
 */
import { Plugin, PluginKey } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";

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
