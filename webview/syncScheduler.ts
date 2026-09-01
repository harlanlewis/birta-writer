/**
 * syncScheduler.ts
 *
 * Decides *when* to push the editor's content to the backing TextDocument. Pure
 * timing logic with no editor/Milkdown dependencies (injected via `deps`) so it
 * is unit-testable in isolation — the subtle part of the save-integrity pipeline
 * that regressions hide in.
 *
 * Policy (see the "View→document sync invariant" in AGENTS.md):
 *   • Leading edge — the first edit after a quiet period (≥ idleMs since the last
 *     sync ENDED) fires ASAP (delay 0, async) so the document dirties before the
 *     user can reach Cmd+S. A leading-edge fire in flight is never pushed out by
 *     a fast follow-up edit — that is its whole job. Measuring the lull from the
 *     sync's end rather than its start is load-bearing on a large document,
 *     where one sync outlasts idleMs; see the stamp in `arm`, and the
 *     `syncing` guard in `request` that covers the window that stamp runs in.
 *   • Trailing debounce — during a burst, the sync is deferred until typing
 *     pauses (idleMs), so a large document is not re-serialized mid-burst.
 *   • Max-wait cap — during genuinely continuous typing (never an idleMs pause)
 *     a sync is still forced every maxWaitMs, bounding how far the document may
 *     trail the editor (the crash-safety window).
 *   • IME — while composing, requests are flagged but never fire; compositionEnded()
 *     flushes any flag so a committed candidate syncs.
 *   • reset() returns to the initial (leading-ready) posture. Call it after a
 *     save flush so the FIRST edit after a save is again a leading edge — without
 *     this, a quick edit-then-save right after a prior save can land in the
 *     trailing window and no-op the save.
 */

export type TimerHandle = unknown;

export interface SyncSchedulerDeps {
    /** Monotonic clock in ms (performance.now in the webview). */
    now(): number;
    setTimer(cb: () => void, ms: number): TimerHandle;
    clearTimer(handle: TimerHandle): void;
    /** True while the user is mid-IME-composition — never sync a half-formed candidate. */
    isComposing(): boolean;
    /** Perform the actual serialize + ship. Only ever called when NOT composing. */
    onSync(): void;
    idleMs?: number;      // default 300
    maxWaitMs?: number;   // default 2000
}

export interface SyncScheduler {
    /** An edit happened: schedule a sync per the leading/trailing/max-wait policy. */
    request(): void;
    /** IME composition committed: fire a deferred request, if any. */
    compositionEnded(): void;
    /** Cancel any pending sync and return to the initial leading-ready posture. */
    reset(): void;
}

export function createSyncScheduler(deps: SyncSchedulerDeps): SyncScheduler {
    const idleMs = deps.idleMs ?? 300;
    const maxWaitMs = deps.maxWaitMs ?? 2000;

    let timer: TimerHandle | null = null;
    let lastSyncMs = 0;      // when the last sync ENDED (leading-edge reference)
    let burstStartMs = 0;    // when the current un-synced burst began (max-wait reference)
    let pendingSync = false; // an edit is waiting to be synced
    let leadingPending = false; // the armed timer is a leading-edge (dirty-ASAP) one
    let syncing = false;     // a sync is on the stack RIGHT NOW (see `request`)

    const fire = (): void => {
        // A timer armed before composition started can fire mid-composition;
        // defer it rather than serialize a half-formed candidate.
        if (deps.isComposing()) { pendingSync = true; return; }
        pendingSync = false;
        deps.onSync();
    };

    const arm = (delay: number, leading: boolean): void => {
        if (timer !== null) { deps.clearTimer(timer); }
        leadingPending = leading;
        timer = deps.setTimer(() => {
            timer = null;
            leadingPending = false;
            burstStartMs = 0;
            syncing = true;
            try {
                fire();
            } finally {
                syncing = false;
                // The lull the leading edge tests for is time since the last
                // sync ENDED, which is why this is stamped here and not before
                // the fire. Stamped at the START, a sync costing more than
                // idleMs makes the next keystroke look like a fresh lull, so
                // every edit re-fires a leading edge and neither the trailing
                // debounce nor the max-wait cap is ever reached. That loop
                // tightens as the document grows, which is the opposite of what
                // the debounce exists to do. `finally` so a throwing sync still
                // advances the reference rather than leaving the next edit to
                // test against a stale one.
                lastSyncMs = deps.now();
            }
        }, delay);
    };

    const request = (): void => {
        pendingSync = true;
        if (deps.isComposing()) { return; }
        const now = deps.now();
        // Leading edge: first edit after a lull → sync ASAP (async so the keypress
        // is free) so the document dirties before the user can reach Cmd+S.
        //
        // `syncing` is what makes the lull test safe under reentrancy. A
        // request raised from INSIDE a sync (a plugin dispatching in response
        // to the doc change) reads a reference the `finally` above has not
        // advanced yet, and on a sync outlasting idleMs the gap it measures is
        // the running sync's own duration — so without this it would arm a
        // second leading edge inside the one already running, at delay 0,
        // which is the very loop the end-stamp exists to close. A timestamp
        // cannot express this: the reference is stale for exactly as long as
        // the sync runs, and a stamp taken before the fire is only correct
        // while the sync is shorter than idleMs, which is the case where none
        // of this matters. It takes the trailing path instead, like any other
        // mid-burst edit.
        if (timer === null && !syncing && now - lastSyncMs >= idleMs) {
            burstStartMs = now;
            arm(0, true);
            return;
        }
        // A pending leading-edge sync must NOT be pushed out by a fast follow-up.
        if (leadingPending) { return; }
        if (burstStartMs === 0) { burstStartMs = now; }
        // Trailing debounce, but never past the max-wait since the burst began.
        const delay = Math.min(idleMs, Math.max(0, maxWaitMs - (now - burstStartMs)));
        arm(delay, false);
    };

    const compositionEnded = (): void => {
        if (pendingSync) { request(); }
    };

    const reset = (): void => {
        if (timer !== null) { deps.clearTimer(timer); timer = null; }
        lastSyncMs = 0;   // leading-ready: next edit fires immediately
        // `syncing` is deliberately NOT cleared: it describes whether a sync is
        // on the stack, which a reset cannot change, and clearing it from
        // inside one would re-open the reentrant leading edge above.
        burstStartMs = 0;
        pendingSync = false;
        leadingPending = false;
    };

    return { request, compositionEnded, reset };
}
