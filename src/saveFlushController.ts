/**
 * saveFlushController.ts
 *
 * The webview→document flush/seq protocol, extracted from the provider
 * (MAR-168). This is the bookkeeping that upholds the three save-pipeline
 * invariants (see AGENTS.md "Autosave"):
 *
 * 1. A save never persists content older than the editor state — a save asks
 *    the webview to serialize NOW (`flushPendingEdit`) and applies the reply
 *    as the save's edits, bounded by a timeout so a wedged webview degrades to
 *    "save current document" rather than hanging.
 * 2. Ordering is total — every outbound content message carries a monotonic
 *    `seq`; `claimSeq` is the single high-water-mark guard that stops a stale
 *    in-flight `update` from reverting a fresher flush.
 * 3. Content serialized against a replaced document state is stale —
 *    `isCurrentVersion` compares the webview's echoed `baseSyncVersion`
 *    against the authoritative per-document version, bumped at OBSERVE time
 *    for every external change.
 *
 * Both stale guards are implemented here ONCE; the provider's `update` path
 * and the flush path call the same two primitives (they used to carry
 * duplicated copies of this logic).
 *
 * Format-agnostic by design: content is an opaque string and the edit type is
 * generic — no markdown (or any other format) knowledge lives here.
 */

/** A webview `flushResult` reply, or the poisoned teardown value. */
export interface FlushReply {
    content: string;
    baseSyncVersion: number;
    seq: number;
}

export class SaveFlushController<TEdit> {
    // Authoritative sync version per document (key: uriKey). Bumped on every
    // observed external change; the webview echoes the version it last applied
    // back as `baseSyncVersion`.
    private readonly _syncVersion = new Map<string, number>();

    // Highest outbound-content `seq` per document whose content has been
    // committed. Because a save-flush's TextEdits bypass the provider's
    // per-document edit queue (VS Code applies them as part of the save), this
    // total order is what stops a stale update from reverting a fresher flush.
    private readonly _appliedSeq = new Map<string, number>();

    // In-flight save flushes: correlation id → resolver called with the
    // webview's `flushResult` reply (or the timeout / teardown poison).
    private readonly _pendingFlushes = new Map<string, (reply: FlushReply) => void>();
    private _flushSeq = 0;

    /**
     * @param _flushTimeoutMs Safety valve, well under VS Code's ~1.75s
     * willSave budget: never hang a save on a wedged/slow webview. On expiry
     * the save writes the current document (≤ one throttle window stale); a
     * late reply still re-baselines the webview, so the gap self-heals on the
     * next real edit. Injectable so the timeout path is unit-testable.
     */
    constructor(private readonly _flushTimeoutMs: number = 1000) {}

    /** Reset a document's version to 0 (webview init/ready re-baseline). */
    resetVersion(uriKey: string): void {
        this._syncVersion.set(uriKey, 0);
    }

    /**
     * Record one observed external change. Must be called SYNCHRONOUSLY at
     * observe time (not when a debounced push later fires): an in-flight
     * webview update serialized against the pre-change text must already read
     * as stale inside the debounce window, or the external edit can be lost.
     */
    bumpVersion(uriKey: string): void {
        this._syncVersion.set(uriKey, (this._syncVersion.get(uriKey) ?? 0) + 1);
    }

    /** The authoritative version (a monotonic count of distinct external changes). */
    currentVersion(uriKey: string): number {
        return this._syncVersion.get(uriKey) ?? 0;
    }

    /**
     * Stale guard #1 (the ONE implementation): was this content serialized
     * against the document state we still hold? False means the webview must
     * re-base (the caller re-pushes the current state).
     */
    isCurrentVersion(uriKey: string, baseSyncVersion: number): boolean {
        return baseSyncVersion === this.currentVersion(uriKey);
    }

    /**
     * Stale guard #2 (the ONE implementation): admit `seq` only if it exceeds
     * the applied high-water mark, and claim it when admitted — even if the
     * subsequent apply turns out to be a no-op — so the mark stays a true
     * monotonic ceiling (later content always carries a higher seq).
     */
    claimSeq(uriKey: string, seq: number): boolean {
        if (seq <= (this._appliedSeq.get(uriKey) ?? -1)) { return false; }
        this._appliedSeq.set(uriKey, seq);
        return true;
    }

    /**
     * Run one save flush: `post` sends the flushSave request (its correlation
     * id is generated here); the returned promise resolves with the edits the
     * save should apply. Resolution paths, all bounded:
     * - the webview replies fresh → `computeEdits(content)` produces the edits;
     * - the reply is stale (version or seq guard) or computeEdits rejects → [];
     * - no reply within the timeout, or `post` throws (panel disposed) → [].
     */
    flushPendingEdit(
        uriKey: string,
        post: (id: string) => void,
        computeEdits: (content: string) => Promise<TEdit[]>,
    ): Promise<TEdit[]> {
        const id = `flush:${uriKey}:${++this._flushSeq}`;
        return new Promise<TEdit[]>((resolve) => {
            const finish = (edits: TEdit[]): void => {
                clearTimeout(timer);
                this._pendingFlushes.delete(id);
                resolve(edits);
            };
            const timer = setTimeout(() => finish([]), this._flushTimeoutMs);
            this._pendingFlushes.set(id, (reply) => {
                if (
                    !this.isCurrentVersion(uriKey, reply.baseSyncVersion) ||
                    !this.claimSeq(uriKey, reply.seq)
                ) {
                    finish([]);
                    return;
                }
                computeEdits(reply.content).then(finish, () => finish([]));
            });
            try {
                post(id);
            } catch {
                finish([]); // panel disposed between the caller's guard and the post
            }
        });
    }

    /** Deliver a webview `flushResult` reply to its parked flush (no-op if unknown/late). */
    resolveFlush(id: string, reply: FlushReply): void {
        this._pendingFlushes.get(id)?.(reply);
    }

    /**
     * Fail every parked flush for a document (panel teardown), so a save
     * mid-teardown resolves to "no edits" instead of hanging until the timeout.
     */
    failFlushes(uriKey: string): void {
        for (const [id, resolve] of this._pendingFlushes) {
            if (id.startsWith(`flush:${uriKey}:`)) {
                resolve({ content: "", baseSyncVersion: -1, seq: -1 });
            }
        }
    }

    /** Drop a document's protocol state (panel disposed). */
    dispose(uriKey: string): void {
        this._syncVersion.delete(uriKey);
        this._appliedSeq.delete(uriKey);
    }
}
