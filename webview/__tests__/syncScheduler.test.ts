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
            now = target;
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
