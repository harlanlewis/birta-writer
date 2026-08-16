/**
 * webview/plugins/readOnly.ts
 *
 * Layer 2 of the read-only lock (MAR-53; the layers are enumerated in
 * webview/readOnly.ts). A `filterTransaction` that drops any doc-changing
 * transaction while the mode is on.
 *
 * Why a filter and not an audit of the chrome. ProseMirror consults every
 * plugin's `filterTransaction` for every transaction regardless of
 * registration order, and for appended transactions too, so this sees the
 * final transaction wherever it sits in the plugin list — the same property
 * contentGuard relies on. That turns "did we remember to disable this button?"
 * from a question the chrome has to answer correctly a hundred times into one
 * the state boundary answers once. A control we missed becomes a no-op, which
 * is a cosmetic bug; without this it would be a broken promise.
 *
 * Two things are deliberately NOT filtered.
 *
 * Selection-only transactions pass, and that is the whole reading story:
 * caret placement, block ranges, cell selections, and every decoration layer
 * (find highlights, proofreading, fold state, note markers) ride transactions
 * that leave the doc alone. Filtering on `tr.docChanged` rather than on the
 * transaction wholesale is what keeps selection, copy, find and folding
 * working.
 *
 * An inbound external change passes. The content came FROM the file, so it is
 * the author's text whatever this mode says, and refusing it would leave the
 * editor showing bytes the file no longer has — a far worse lie than the edit
 * the mode exists to prevent (docs/DESIGN_PRINCIPLES.md, "Never fight an
 * external edit"). `EXTERNAL_SYNC_META` is the tag applyExternalSync already
 * sets for its own reasons.
 */
import { Plugin, PluginKey } from "../pm";
import { $prose } from "@milkdown/utils";
import { isReadOnly, subscribeReadOnly, syncReadOnlyBodyClass } from "../readOnly";
import { EXTERNAL_SYNC_META } from "./docChange";

export const readOnlyKey = new PluginKey("read-only");

export const readOnlyPlugin = $prose(
    () =>
        new Plugin({
            key: readOnlyKey,
            filterTransaction(tr) {
                if (!tr.docChanged) { return true; }
                if (!isReadOnly()) { return true; }
                return Boolean(tr.getMeta(EXTERNAL_SYNC_META));
            },
            view(view) {
                // Per editor instance: a revert or a format re-init builds a
                // new view, and it must not paint editable for a frame.
                syncReadOnlyBodyClass();
                const unsubscribe = subscribeReadOnly(() => {
                    // `editable` is a PROP, cached on the view as
                    // `view.editable` and only recomputed when the view
                    // updates. An empty setProps is the documented way to ask
                    // for that recompute, and it is what makes the toggle live
                    // rather than reload-only: without it the predicate in
                    // editor.ts would be read once at mount and never again.
                    view.setProps({});
                });
                return { destroy: unsubscribe };
            },
        }),
);
