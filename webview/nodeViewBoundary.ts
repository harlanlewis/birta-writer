/**
 * webview/nodeViewBoundary.ts — the per-node crash boundary.
 *
 * A NodeView that throws must cost its own chrome, never the editor. Without
 * this boundary the blast radius of one bad block is the whole document:  a
 * throw in a constructor propagates out of ProseMirror's view build and the
 * editor never mounts; a throw in update() unwinds the dispatch that carried
 * a keystroke. Both punish a document for one node's bug, which is exactly
 * the failure shape that shipped as "one invalid mermaid diagram froze the
 * window" — the fix for the loop lives in mermaidPane.ts, and this boundary
 * is the general rule it taught: failures scope to the failing node.
 *
 * Degradation is ProseMirror's own: a guarded factory that throws reports
 * once and returns undefined, and a falsy NodeView makes prosemirror-view
 * fall back to the schema's toDOM rendering — the node stays visible and
 * editable, only its custom chrome is lost. A guarded update() that throws
 * reports and returns false, which tells ProseMirror to rebuild the view
 * (through the guarded factory, so a persistently broken view converges to
 * toDOM instead of throwing per transaction).
 *
 * Costs nothing until something actually throws: the guards are one
 * try/catch per call on paths that are already function calls.
 */
import type { NodeViewConstructor } from "./pm";
import { reportNodeViewFailure } from "./crashReporter";

/** The NodeView methods whose throw would otherwise unwind an editor-wide
 *  code path, each with the return that makes ProseMirror take its own
 *  fallback. destroy/select/deselect return nothing; a throw is swallowed. */
const METHOD_FALLBACKS: Record<string, unknown> = {
    update: false, // false → ProseMirror recreates the view
    ignoreMutation: false, // false → ProseMirror re-reads the DOM itself
    stopEvent: false, // false → the event flows to the editor normally
    setSelection: undefined,
    selectNode: undefined,
    deselectNode: undefined,
    destroy: undefined,
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
                return fallback;
            }
        };
    }
}

/**
 * Wrap one `nodeViewCtx` factory so a throw anywhere in the node's custom
 * rendering degrades that node to default rendering instead of taking the
 * editor down. Applied to every format-supplied NodeView at the composition
 * root (editor.ts).
 */
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
            // Falsy → prosemirror-view renders the node via its schema toDOM.
            return undefined as unknown as ReturnType<NodeViewConstructor>;
        }
        if (nv && typeof nv === "object") {
            guardMethods(nodeId, nv as unknown as Record<string, unknown>);
        }
        return nv;
    };
}
