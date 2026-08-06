/**
 * Per-node crash boundary: a NodeView that throws costs its own chrome, never
 * the editor. Unguarded, a constructor throw aborts the mount and an update()
 * throw unwinds the keystroke's dispatch — one bad block, whole document.
 *
 * Degradation is ProseMirror's own: a throwing factory reports once and
 * returns undefined, which prosemirror-view renders via the schema's toDOM,
 * so the node stays editable without its chrome. update() → false rebuilds
 * through the guarded factory, converging a persistently broken view to toDOM.
 */
import type { NodeViewConstructor } from "./pm";
import { reportNodeViewFailure } from "./crashReporter";

/** Guarded methods, each with the fallback that makes ProseMirror take its
 *  own path. Void methods swallow the throw. `ignoreMutation` gets `true` for
 *  attribute mutations (chrome writes attrs constantly; `false` there is the
 *  B085 reconcile loop) and `false` otherwise so real content edits re-read. */
const METHOD_FALLBACKS: Record<string, (args: unknown[]) => unknown> = {
    update: () => false, // false → ProseMirror recreates the view
    ignoreMutation: (args) => (args[0] as MutationRecord | undefined)?.type === "attributes",
    stopEvent: () => false, // false → the event flows to the editor normally
    setSelection: () => undefined,
    selectNode: () => undefined,
    deselectNode: () => undefined,
    destroy: () => undefined,
};

function guardMethods(nodeId: string, nv: Record<string, unknown>): void {
    for (const [method, fallback] of Object.entries(METHOD_FALLBACKS)) {
        const original = nv[method];
        if (typeof original !== "function") { continue; }
        nv[method] = function guarded(this: unknown, ...args: unknown[]): unknown {
            try {
                return (original as (...a: unknown[]) => unknown).apply(this, args);
            } catch (err) {
                reportNodeViewFailure(nodeId, method, err);
                return fallback(args);
            }
        };
    }
}

/** Wrap one `nodeViewCtx` factory. Applied to every format-supplied NodeView
 *  at the composition root (editor.ts). */
export function guardNodeViewFactory(
    nodeId: string,
    factory: NodeViewConstructor,
): NodeViewConstructor {
    return (...args: Parameters<NodeViewConstructor>) => {
        let nv: ReturnType<NodeViewConstructor>;
        try {
            nv = factory(...args);
        } catch (err) {
            reportNodeViewFailure(nodeId, "create", err);
            return undefined as unknown as ReturnType<NodeViewConstructor>;
        }
        if (nv && typeof nv === "object") {
            // The wrap itself can throw on a frozen/getter-only NodeView; the
            // boundary must never become the thrower. Degrade to unguarded.
            try {
                guardMethods(nodeId, nv as unknown as Record<string, unknown>);
            } catch (err) {
                reportNodeViewFailure(nodeId, "guard", err);
            }
        }
        return nv;
    };
}
