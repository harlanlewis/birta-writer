/**
 * externalSync.ts
 *
 * Cursor-preserving inbound sync. When the extension pushes a new document
 * state (external text-editor edit, undo/redo, git checkout, hot-exit restore),
 * a full editor rebuild would throw away the user's selection and scroll. This
 * module instead parses the new markdown into a ProseMirror doc, computes a
 * minimal diff against the current doc, and applies only the changed ranges —
 * so a caret or selection that isn't inside an edited region survives untouched.
 *
 * All work happens in DISPLAY space (image src = webview URIs), exactly like the
 * editor's own doc; the extension converts webview URIs back to file-relative
 * paths on save, so nothing display-only ever leaks into the file.
 *
 * On ANY failure (parse returns null, computeDocDiff throws on an incompatible
 * structure, or the applied transaction fails its self-check) this returns
 * false WITHOUT dispatching, and the caller falls back to the full-rebuild
 * (revert) path.
 */
import { type Editor, editorViewCtx, parserCtx } from "@milkdown/core";
import { computeDocDiff } from "@milkdown/plugin-diff";

/**
 * Applies `newMarkdown` to the editor as a minimal ProseMirror diff.
 *
 * @returns true when the diff was computed, verified and dispatched; false when
 * the caller must fall back to a full rebuild. A false return never leaves a
 * partial transaction applied — the self-check runs on the prospective
 * transaction before it is dispatched.
 */
export function applyExternalSync(editor: Editor, newMarkdown: string): boolean {
    try {
        return editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const parser = ctx.get(parserCtx);
            const newDoc = parser(newMarkdown);
            if (!newDoc) {
                return false;
            }

            const changes = computeDocDiff(view.state.doc, newDoc);
            let tr = view.state.tr;
            // Apply changes from last to first: reverse iteration keeps every
            // earlier offset valid as later ranges are replaced (changeset
            // guarantees the changes are ordered and non-overlapping). This
            // mirrors the diff plugin's own acceptAll path.
            for (let i = changes.length - 1; i >= 0; i--) {
                const change = changes[i];
                tr = tr.replace(
                    change.fromA,
                    change.toA,
                    newDoc.slice(change.fromB, change.toB),
                );
            }

            // Self-check BEFORE dispatch: the assembled transaction must
            // reproduce newDoc exactly. If the diff/apply was lossy (rare
            // structural edge cases), bail so the caller rebuilds instead of
            // dispatching a corrupt intermediate doc.
            if (!tr.doc.eq(newDoc)) {
                return false;
            }

            // Tag the transaction so it is recognizable as inbound sync, and
            // keep it out of the webview's local undo history — these changes
            // originate outside the webview (VS Code's own undo/redo, git, a
            // side-by-side text editor), so they must not create phantom
            // entries in the ProseMirror history stack. The addToHistory tag
            // governs ONLY undo history: suppressing the save-pipeline echo
            // back to the extension is the caller's job (`_applyingExternal`
            // in editor.ts), since the doc-change hook that now drives saves
            // reports every doc change regardless of how it is tagged.
            tr.setMeta("external-sync", true);
            tr.setMeta("addToHistory", false);
            view.dispatch(tr);
            return true;
        });
    } catch {
        // parser throw, computeDocDiff RangeError, or any dispatch failure.
        return false;
    }
}
