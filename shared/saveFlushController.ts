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
 * 2. Ordering is total per writer — every outbound content message carries a
 *    monotonic `seq`, and `claimSeq` keeps one high-water mark per
 *    (document, writer), which stops a stale in-flight `update` from
 *    reverting a fresher flush without letting one writer's counter starve
 *    another's (MAR-346; a reloaded webview restarting its counter is the
 *    single-writer form of that collision, see `resetWebviewBaseline`).
 * 3. Whether content serialized against an older document state is still
 *    admissible is the BACKEND's question, not this file's —
 *    `isAdmissibleBase` delegates to the injected `FlushBackend`, whose
 *    default is the equality check the VS Code host has always run against
 *    the authoritative per-document version, bumped at OBSERVE time for
 *    every external change.
 *
 * Both stale guards are implemented here ONCE, and must stay that way: the
 * provider's `update` path and the flush path call the same two primitives
 * rather than carrying their own copies.
 *
 * Format-agnostic by design: content is an opaque string and the edit type is
 * generic — no markdown (or any other format) knowledge lives here. The
 * concurrency assumptions are supplied the same way (MAR-346): a host with a
 * continuously-syncing backend swaps the `FlushBackend`, not this file.
 *
 * Known scalar left in place, deliberately (MAR-346 scope note):
 * `resetWebviewBaseline` sets the version to literal `0`, which is meaningful
 * only while this side owns the counter; it becomes a backend call when a
 * backend with its own version space first exists.
 */

/** A webview `flushResult` reply, or the poisoned teardown value. */
export interface FlushReply {
    content: string;
    baseSyncVersion: number;
    seq: number;
    /** Ordering identity of the sender. Today's single webview context omits
     * it and gets `LOCAL_WRITER`; a second writer supplies its own so the two
     * counters cannot collide. */
    writerId?: string;
}

/** The one writer the VS Code host has: the document's webview context. */
export const LOCAL_WRITER = "webview";

/**
 * What to do with a proposal whose base the backend rejected (MAR-346
 * inversion 3). "Drop and re-push" stops being the only answer once a backend
 * can carry an edit forward or expects the remote to settle:
 * - `repush`: drop the content and re-push authoritative state so the writer
 *   re-bases — the VS Code host's long-standing behavior, and the default.
 * - `rebase`: the backend carried the edit forward; admit `content` in place
 *   of the rejected proposal.
 * - `defer`: push nothing; the writer retries once the remote settles.
 * - `escalate`: the diskDrift stance — tell the user, change nothing.
 */
export type BaseRejection =
    | { outcome: "repush" }
    | { outcome: "rebase"; content: string }
    | { outcome: "defer" }
    | { outcome: "escalate" };

/**
 * The concurrency assumptions of the sync backend, supplied rather than baked
 * in (MAR-346). The controller asks it two questions and nothing else.
 */
export interface FlushBackend {
    /**
     * Is the base this content was serialized against still admissible as its
     * parent? Equality for a single-writer host (external changes are rare
     * and drop-and-rebase is acceptable); reachability for a backend with
     * ancestry; causal inclusion for a CRDT.
     */
    isAdmissibleBase(currentVersion: number, baseSyncVersion: number): boolean;
    /** The outcome for a proposal whose base was rejected. */
    onBaseRejected(proposal: {
        uriKey: string;
        baseSyncVersion: number;
        currentVersion: number;
        content: string;
    }): BaseRejection;
}

/** Today's exact behavior: only the current version is admissible, and a
 * rejected base drops the content and re-pushes authoritative state. */
export const singleWriterBackend: FlushBackend = {
    isAdmissibleBase: (currentVersion, baseSyncVersion) => baseSyncVersion === currentVersion,
    onBaseRejected: () => ({ outcome: "repush" }),
};

export class SaveFlushController<TEdit> {
    // Authoritative sync version per document (key: uriKey). Bumped on every
    // observed external change; the webview echoes the version it last applied
    // back as `baseSyncVersion`.
    private readonly _syncVersion = new Map<string, number>();

    // Highest committed outbound-content `seq` per (document, writer).
    // Because a save-flush's TextEdits bypass the provider's per-document
    // edit queue (VS Code applies them as part of the save), this order is
    // what stops a stale update from reverting a fresher flush. The mark is
    // per WRITER (MAR-346 inversion 2): a doc-global mark makes any second
    // counter — a reloaded webview's, a second surface's — read as
    // permanently stale, which is the shipped reload bug generalized.
    private readonly _appliedSeq = new Map<string, Map<string, number>>();

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
    constructor(
        private readonly _flushTimeoutMs: number = 1000,
        private readonly _backend: FlushBackend = singleWriterBackend,
    ) {}

    /**
     * Re-baseline a document for a FRESH webview context (its `ready`).
     *
     * Resets both counters, because a webview that just announced `ready` has
     * restarted BOTH of its own: `baseSyncVersion` and the module-level
     * outbound `seq` in webview/messaging.ts. Resetting only the version left
     * `_appliedSeq` at the previous context's high-water mark, so every
     * `update` and `flushResult` from the new context — numbered from 1 again —
     * failed the `seq <= _appliedSeq` staleness test and was silently dropped:
     * edits would never dirty the document and Cmd+S would write stale bytes.
     * `dispose()` cleared it only when the PANEL went away, which a webview
     * reload (renderer crash recovery) does not do.
     *
     * The seq reset is scoped to the writer that restarted: another writer's
     * counter did not restart, so its mark must survive this call.
     */
    resetWebviewBaseline(uriKey: string, writerId: string = LOCAL_WRITER): void {
        this._syncVersion.set(uriKey, 0);
        this._appliedSeq.get(uriKey)?.delete(writerId);
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
     * Stale guard #1 (the ONE implementation): is the base this content was
     * serialized against still admissible as its parent? The backend answers
     * (MAR-346 inversion 1); the default backend answers with equality, which
     * is today's exact behavior. False means the caller asks `rejectBase` what
     * to do with the proposal.
     */
    isAdmissibleBase(uriKey: string, baseSyncVersion: number): boolean {
        return this._backend.isAdmissibleBase(this.currentVersion(uriKey), baseSyncVersion);
    }

    /**
     * The backend's verdict on a proposal whose base `isAdmissibleBase`
     * rejected (MAR-346 inversion 3). The default backend always answers
     * `repush` — drop and re-push authoritative state, today's behavior.
     */
    rejectBase(uriKey: string, baseSyncVersion: number, content: string): BaseRejection {
        return this._backend.onBaseRejected({
            uriKey,
            baseSyncVersion,
            currentVersion: this.currentVersion(uriKey),
            content,
        });
    }

    /**
     * Stale guard #2 (the ONE implementation): admit `seq` only if it exceeds
     * the writer's applied high-water mark, and claim it when admitted — even
     * if the subsequent apply turns out to be a no-op — so the mark stays a
     * true monotonic ceiling (later content from that writer always carries a
     * higher seq). Identity is (document, writer), MAR-346 inversion 2.
     */
    claimSeq(uriKey: string, seq: number, writerId: string = LOCAL_WRITER): boolean {
        const marks = this._appliedSeq.get(uriKey);
        if (seq <= (marks?.get(writerId) ?? -1)) { return false; }
        if (marks) {
            marks.set(writerId, seq);
        } else {
            this._appliedSeq.set(uriKey, new Map([[writerId, seq]]));
        }
        return true;
    }

    /**
     * Run one save flush: `post` sends the flushSave request (its correlation
     * id is generated here); the returned promise resolves with the edits the
     * save should apply. Resolution paths, all bounded:
     * - the webview replies fresh → `computeEdits(content)` produces the edits;
     * - the reply is stale (version or seq guard) or computeEdits rejects → [];
     * - no reply within the timeout, or `post` throws (panel disposed) → [].
     *
     * `onDecided` reports the verdict on a reply that DID arrive in time, so the
     * caller can acknowledge it to the webview (MAR-349): `true` exactly when
     * `computeEdits` resolved — the bytes were handed to the save. That is
     * optimistic, not proof of application (VS Code may still drop a
     * participant's edits), so the caller confirms against the saved text
     * before relaying `true`. It never fires on the timeout or post-throw
     * paths, where there is no reply to judge; a reply that arrives after the
     * timeout is `resolveFlush`'s caller's to acknowledge (it returns false
     * for exactly that case).
     */
    flushPendingEdit(
        uriKey: string,
        post: (id: string) => void,
        computeEdits: (content: string) => Promise<TEdit[]>,
        onDecided?: (id: string, applied: boolean) => void,
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
                    !this.isAdmissibleBase(uriKey, reply.baseSyncVersion) ||
                    !this.claimSeq(uriKey, reply.seq, reply.writerId)
                ) {
                    onDecided?.(id, false);
                    finish([]);
                    return;
                }
                computeEdits(reply.content).then(
                    (edits) => {
                        onDecided?.(id, true);
                        finish(edits);
                    },
                    () => {
                        onDecided?.(id, false);
                        finish([]);
                    },
                );
            });
            try {
                post(id);
            } catch {
                finish([]); // panel disposed between the caller's guard and the post
            }
        });
    }

    /**
     * Deliver a webview `flushResult` reply to its parked flush. Returns false
     * when no flush is parked under `id` (late reply after the timeout, or a
     * duplicate) — the caller owes the webview a discarded-ack for that reply,
     * because the webview is holding a baseline candidate for it (MAR-349).
     */
    resolveFlush(id: string, reply: FlushReply): boolean {
        const resolver = this._pendingFlushes.get(id);
        if (!resolver) { return false; }
        resolver(reply);
        return true;
    }

    /**
     * Fail every parked flush for a document (panel teardown), so a save
     * mid-teardown resolves to "no edits" instead of hanging until the timeout.
     * The poison rides the SEQ guard, not the version guard: `seq: -1` can
     * never exceed a high-water mark (empty reads as -1), so it is rejected
     * whatever admissibility the injected backend grants `baseSyncVersion: -1`.
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
