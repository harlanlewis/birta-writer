/**
 * The outbound sync scheduler decides WHEN the editor pushes content to the
 * backing document. It is the subtle, data-integrity-critical timing core of the
 * save pipeline, so it is driven here through a fully deterministic injected
 * clock (no real timers), asserting each policy: leading edge, trailing debounce,
 * max-wait cap, IME deferral, and the leading-ready reset that a save flush needs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSyncScheduler, type SyncScheduler } from "../syncScheduler";

/** Deterministic clock + timer queue; `advance` fires due timers in time order,
 *  honoring timers (re)armed while firing. */
function makeClock(startMs = 1000) {
    let now = startMs;
    let seq = 0;
    const timers = new Map<number, { at: number; cb: () => void }>();
    return {
        now: () => now,
        setTimer: (cb: () => void, ms: number) => {
            const id = ++seq;
            timers.set(id, { at: now + ms, cb });
            return id;
        },
        clearTimer: (h: unknown) => { timers.delete(h as number); },
        /** Consume wall-clock time WITHOUT firing timers: what an expensive
         *  onSync does to the clock the scheduler reads. */
        spend: (ms: number) => { now += ms; },
        advance: (ms: number) => {
            const target = now + ms;
            for (;;) {
                let pick: { id: number; at: number; cb: () => void } | null = null;
                for (const [id, t] of timers) {
                    if (t.at <= target && (pick === null || t.at < pick.at)) {
                        pick = { id, at: t.at, cb: t.cb };
                    }
                }
                if (pick === null) { break; }
                timers.delete(pick.id);
                now = pick.at;
                pick.cb();
            }
            // A callback may have spent time of its own; never rewind past it.
            now = Math.max(now, target);
        },
    };
}

describe("createSyncScheduler", () => {
    let clock: ReturnType<typeof makeClock>;
    let onSync: ReturnType<typeof vi.fn>;
    let composing: boolean;
    let scheduler: SyncScheduler;

    beforeEach(() => {
        clock = makeClock();
        onSync = vi.fn();
        composing = false;
        scheduler = createSyncScheduler({
            now: clock.now,
            setTimer: clock.setTimer,
            clearTimer: clock.clearTimer,
            isComposing: () => composing,
            onSync,
            idleMs: 300,
            maxWaitMs: 2000,
        });
    });

    it("the first edit after a lull should sync on the leading edge (delay ~0)", () => {
        scheduler.request();
        expect(onSync).not.toHaveBeenCalled(); // async, even at delay 0
        clock.advance(1);
        expect(onSync).toHaveBeenCalledTimes(1);
    });

    it("a fast follow-up edit must NOT push out the pending leading-edge sync", () => {
        scheduler.request();       // arms the leading edge at +0
        scheduler.request();       // 2nd edit before it fires — must not re-arm to +300
        clock.advance(1);
        expect(onSync).toHaveBeenCalledTimes(1); // regression guard: still fired immediately
    });

    it("a burst should coalesce into one trailing sync after typing pauses", () => {
        scheduler.request();       // leading
        clock.advance(1);
        expect(onSync).toHaveBeenCalledTimes(1);
        // Keep typing every 100ms (< idle), then pause.
        scheduler.request(); clock.advance(100);
        scheduler.request(); clock.advance(100);
        scheduler.request();
        expect(onSync).toHaveBeenCalledTimes(1); // nothing extra mid-burst
        clock.advance(300);                       // pause ≥ idle
        expect(onSync).toHaveBeenCalledTimes(2);  // one trailing sync
    });

    it("continuous typing with no pause should still be forced to sync by the max-wait cap", () => {
        scheduler.request();       // leading
        clock.advance(1);
        expect(onSync).toHaveBeenCalledTimes(1);
        // Type every 100ms for 2.5s with no idle pause; max-wait (2000ms) must fire.
        for (let i = 0; i < 25; i++) { scheduler.request(); clock.advance(100); }
        expect(onSync.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    /**
     * The leading edge asks "has it been quiet for idleMs", and the reference it
     * measures from must be when the last sync ENDED. Stamped at the START, a
     * sync that itself costs more than idleMs makes the very next keystroke look
     * like a fresh lull: every edit re-fires a leading edge, the trailing
     * debounce and the max-wait cap are never reached, and the cost per
     * keystroke becomes the cost of a whole sync. The loop is self-sustaining,
     * and it tightens as the document grows — measured on a 765 KB file, 30
     * keystrokes produced 29 whole-document syncs.
     */
    it("a sync costing longer than idleMs should not make the next edit a fresh leading edge", () => {
        const SYNC_MS = 500; // > idleMs
        onSync.mockImplementation(() => { clock.spend(SYNC_MS); });

        scheduler.request();      // leading edge
        clock.advance(1);
        expect(onSync).toHaveBeenCalledTimes(1);

        // Continuous typing at 30 ms/key, run well past maxWaitMs so the cap
        // has to engage. Every one of these lands after a sync that took
        // longer than idleMs.
        const KEYS = 167;         // ~5 s of typing, > 2 max-wait windows
        for (let i = 0; i < KEYS; i++) {
            scheduler.request();
            clock.advance(30);
        }

        // Two-sided on purpose. The ceiling is the defect: one sync per
        // keystroke. The floor is the failure the ceiling alone would wave
        // through, a scheduler that answers the leading edge and then never
        // syncs again, which is the same starvation MAR-145 is about.
        const calls = onSync.mock.calls.length;
        expect(calls).toBeGreaterThan(1);
        expect(calls).toBeLessThanOrEqual(5);
        expect(calls).toBeLessThan(KEYS / 10);
    });

    it("edits while composing should not sync until compositionEnded()", () => {
        composing = true;
        scheduler.request();
        clock.advance(500);
        expect(onSync).not.toHaveBeenCalled(); // never serialize a half-formed IME candidate
        composing = false;
        scheduler.compositionEnded();
        clock.advance(1);
        expect(onSync).toHaveBeenCalledTimes(1);
    });

    it("reset() should cancel a pending sync", () => {
        scheduler.request();
        scheduler.reset();
        clock.advance(1000);
        expect(onSync).not.toHaveBeenCalled();
    });

    it("after reset() (a save flush), the very next edit should sync on the leading edge again", () => {
        // Prior activity leaves lastSyncMs set to ~now.
        scheduler.request();
        clock.advance(1);
        expect(onSync).toHaveBeenCalledTimes(1);
        clock.advance(50); // only 50ms later — well within the idle window

        scheduler.reset();  // save flush returns the scheduler to leading-ready posture
        scheduler.request();
        clock.advance(1);
        // Without the leading-ready reset this would be a trailing sync (no fire yet),
        // reproducing the "second save after a quick re-edit no-ops" bug.
        expect(onSync).toHaveBeenCalledTimes(2);
    });
});
