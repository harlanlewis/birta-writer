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
 *     sync) fires ASAP (delay 0, async) so the document dirties before the user
 *     can reach Cmd+S. A leading-edge fire in flight is never pushed out by a
 *     fast follow-up edit — that is its whole job.
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
    let lastSyncMs = 0;      // when the last sync fired (leading-edge reference)
    let burstStartMs = 0;    // when the current un-synced burst began (max-wait reference)
    let pendingSync = false; // an edit is waiting to be synced
    let leadingPending = false; // the armed timer is a leading-edge (dirty-ASAP) one

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
            lastSyncMs = deps.now();
            fire();
        }, delay);
    };

    const request = (): void => {
        pendingSync = true;
        if (deps.isComposing()) { return; }
        const now = deps.now();
        // Leading edge: first edit after a lull → sync ASAP (async so the keypress
        // is free) so the document dirties before the user can reach Cmd+S.
        if (timer === null && now - lastSyncMs >= idleMs) {
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
        burstStartMs = 0;
        pendingSync = false;
        leadingPending = false;
    };

    return { request, compositionEnded, reset };
}
