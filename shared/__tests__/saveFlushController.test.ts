/**
 * SaveFlushController: the extracted flush/seq protocol (MAR-168). The
 * provider-level suites (saveFlush/textSync) pin the protocol through the
 * public editor behavior; these tests pin the controller's own contract —
 * including the injectable timeout path, which the provider suite could only
 * reach at the fixed 1s value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SaveFlushController, type FlushBackend } from "../saveFlushController";

const URI = "file:///project/note.md";

describe("SaveFlushController", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    describe("version bookkeeping", () => {
        it("an untracked document should read as version 0 and current for base 0", () => {
            const c = new SaveFlushController<string>();
            expect(c.currentVersion(URI)).toBe(0);
            expect(c.isAdmissibleBase(URI, 0)).toBe(true);
        });

        it("bumpVersion should make an older base stale and the new base current", () => {
            const c = new SaveFlushController<string>();
            c.bumpVersion(URI);
            expect(c.currentVersion(URI)).toBe(1);
            expect(c.isAdmissibleBase(URI, 0)).toBe(false);
            expect(c.isAdmissibleBase(URI, 1)).toBe(true);
        });

        it("resetWebviewBaseline should re-baseline the document at 0", () => {
            const c = new SaveFlushController<string>();
            c.bumpVersion(URI);
            c.bumpVersion(URI);
            c.resetWebviewBaseline(URI);
            expect(c.isAdmissibleBase(URI, 0)).toBe(true);
        });
    });

    describe("seq claiming (total order)", () => {
        it("a fresh seq should be claimed and a lower-or-equal seq rejected afterwards", () => {
            const c = new SaveFlushController<string>();
            expect(c.claimSeq(URI, 5)).toBe(true);
            expect(c.claimSeq(URI, 5)).toBe(false);
            expect(c.claimSeq(URI, 3)).toBe(false);
            expect(c.claimSeq(URI, 6)).toBe(true);
        });

        it("seq order should be tracked per document", () => {
            const c = new SaveFlushController<string>();
            expect(c.claimSeq(URI, 5)).toBe(true);
            expect(c.claimSeq("file:///other.md", 1)).toBe(true);
        });

        it("a webview that re-baselines should have its restarted seq accepted, not rejected as stale", () => {
            // A reloaded webview (renderer crash recovery) restarts its outbound
            // `seq` at 1 while the panel — and so this controller's state —
            // survives. Resetting only the version left the high-water mark in
            // place, and every message from the new context failed the
            // staleness test: edits never dirtied the document and Cmd+S wrote
            // stale bytes. The observable is that the FIRST message of the new
            // context is accepted.
            const c = new SaveFlushController<string>();
            expect(c.claimSeq(URI, 1)).toBe(true);
            expect(c.claimSeq(URI, 2)).toBe(true);
            expect(c.claimSeq(URI, 3)).toBe(true);

            c.resetWebviewBaseline(URI);

            expect(c.claimSeq(URI, 1), "the reloaded webview's first update was dropped").toBe(true);
            expect(c.claimSeq(URI, 2)).toBe(true);
        });
    });

    describe("flushPendingEdit", () => {
        it("a fresh reply should resolve with the computed edits and claim its seq", async () => {
            const c = new SaveFlushController<string>();
            let flushId = "";
            const flush = c.flushPendingEdit(
                URI,
                (id) => { flushId = id; },
                async (content) => [`edit:${content}`],
            );
            c.resolveFlush(flushId, { content: "fresh", baseSyncVersion: 0, seq: 2 });
            await expect(flush).resolves.toEqual(["edit:fresh"]);
            // The flush claimed seq 2: a stale in-flight update must now be rejected.
            expect(c.claimSeq(URI, 1)).toBe(false);
        });

        it("a reply with a stale baseSyncVersion should resolve to no edits", async () => {
            const c = new SaveFlushController<string>();
            const compute = vi.fn(async () => ["edit"]);
            let flushId = "";
            const flush = c.flushPendingEdit(URI, (id) => { flushId = id; }, compute);
            c.bumpVersion(URI); // external change lands while the flush is in flight
            c.resolveFlush(flushId, { content: "stale", baseSyncVersion: 0, seq: 2 });
            await expect(flush).resolves.toEqual([]);
            expect(compute).not.toHaveBeenCalled();
        });

        it("a reply whose seq a newer update already claimed should resolve to no edits", async () => {
            const c = new SaveFlushController<string>();
            c.claimSeq(URI, 5);
            let flushId = "";
            const flush = c.flushPendingEdit(URI, (id) => { flushId = id; }, async () => ["edit"]);
            c.resolveFlush(flushId, { content: "old", baseSyncVersion: 0, seq: 3 });
            await expect(flush).resolves.toEqual([]);
        });

        it("no reply within the injected timeout should resolve to no edits", async () => {
            const c = new SaveFlushController<string>(50);
            const flush = c.flushPendingEdit(URI, () => {}, async () => ["edit"]);
            await vi.advanceTimersByTimeAsync(50);
            await expect(flush).resolves.toEqual([]);
        });

        it("a reply arriving before the injected timeout should beat the timeout", async () => {
            const c = new SaveFlushController<string>(50);
            let flushId = "";
            const flush = c.flushPendingEdit(URI, (id) => { flushId = id; }, async (t) => [t]);
            await vi.advanceTimersByTimeAsync(49);
            c.resolveFlush(flushId, { content: "made-it", baseSyncVersion: 0, seq: 1 });
            await expect(flush).resolves.toEqual(["made-it"]);
            // The cleared timer must not fire later against the settled flush.
            await vi.advanceTimersByTimeAsync(1000);
        });

        it("a throwing post (panel disposed) should resolve immediately to no edits", async () => {
            const c = new SaveFlushController<string>();
            const flush = c.flushPendingEdit(
                URI,
                () => { throw new Error("Webview is disposed"); },
                async () => ["edit"],
            );
            await expect(flush).resolves.toEqual([]);
        });

        it("a rejecting computeEdits should degrade to no edits instead of hanging the save", async () => {
            const c = new SaveFlushController<string>();
            let flushId = "";
            const flush = c.flushPendingEdit(URI, (id) => { flushId = id; }, async () => {
                throw new Error("serialize failed");
            });
            c.resolveFlush(flushId, { content: "x", baseSyncVersion: 0, seq: 1 });
            await expect(flush).resolves.toEqual([]);
        });

        it("a late duplicate reply after resolution should be ignored", async () => {
            const c = new SaveFlushController<string>();
            let flushId = "";
            const compute = vi.fn(async (content: string) => [content]);
            const flush = c.flushPendingEdit(URI, (id) => { flushId = id; }, compute);
            c.resolveFlush(flushId, { content: "first", baseSyncVersion: 0, seq: 1 });
            await expect(flush).resolves.toEqual(["first"]);
            c.resolveFlush(flushId, { content: "second", baseSyncVersion: 0, seq: 2 });
            expect(compute).toHaveBeenCalledTimes(1);
        });
    });

    // MAR-349: the webview parks a baseline candidate for every reply it sends,
    // so every reply that ARRIVES must produce exactly one verdict — applied
    // when computeEdits resolved (those bytes are the save's edits), discarded
    // otherwise. The timeout and post-throw paths see no reply and report
    // nothing; a reply landing after the timeout is the resolveFlush caller's
    // to ack, which is what its boolean return exists for.
    describe("flush verdicts (onDecided / resolveFlush return)", () => {
        it("a fresh applied reply should report applied under the flush's own id", async () => {
            const c = new SaveFlushController<string>();
            const onDecided = vi.fn();
            let flushId = "";
            const flush = c.flushPendingEdit(
                URI,
                (id) => { flushId = id; },
                async (t) => [t],
                onDecided,
            );
            expect(c.resolveFlush(flushId, { content: "x", baseSyncVersion: 0, seq: 1 })).toBe(true);
            await flush;
            expect(onDecided).toHaveBeenCalledExactlyOnceWith(flushId, true);
        });

        it("a stale-version reply should report discarded", async () => {
            const c = new SaveFlushController<string>();
            const onDecided = vi.fn();
            let flushId = "";
            const flush = c.flushPendingEdit(URI, (id) => { flushId = id; }, async (t) => [t], onDecided);
            c.bumpVersion(URI);
            c.resolveFlush(flushId, { content: "x", baseSyncVersion: 0, seq: 1 });
            await flush;
            expect(onDecided).toHaveBeenCalledExactlyOnceWith(flushId, false);
        });

        it("a superseded-seq reply should report discarded", async () => {
            const c = new SaveFlushController<string>();
            const onDecided = vi.fn();
            c.claimSeq(URI, 5);
            let flushId = "";
            const flush = c.flushPendingEdit(URI, (id) => { flushId = id; }, async (t) => [t], onDecided);
            c.resolveFlush(flushId, { content: "x", baseSyncVersion: 0, seq: 3 });
            await flush;
            expect(onDecided).toHaveBeenCalledExactlyOnceWith(flushId, false);
        });

        it("a rejecting computeEdits should report discarded", async () => {
            const c = new SaveFlushController<string>();
            const onDecided = vi.fn();
            let flushId = "";
            const flush = c.flushPendingEdit(
                URI,
                (id) => { flushId = id; },
                async () => { throw new Error("serialize failed"); },
                onDecided,
            );
            c.resolveFlush(flushId, { content: "x", baseSyncVersion: 0, seq: 1 });
            await flush;
            expect(onDecided).toHaveBeenCalledExactlyOnceWith(flushId, false);
        });

        it("a timeout with no reply should report nothing", async () => {
            const c = new SaveFlushController<string>(50);
            const onDecided = vi.fn();
            const flush = c.flushPendingEdit(URI, () => {}, async (t) => [t], onDecided);
            await vi.advanceTimersByTimeAsync(50);
            await flush;
            expect(onDecided).not.toHaveBeenCalled();
        });

        it("resolveFlush should return false for a reply with no parked flush", async () => {
            const c = new SaveFlushController<string>(50);
            let flushId = "";
            const flush = c.flushPendingEdit(URI, (id) => { flushId = id; }, async (t) => [t]);
            await vi.advanceTimersByTimeAsync(50); // the save gave up on this reply
            await flush;
            expect(
                c.resolveFlush(flushId, { content: "late", baseSyncVersion: 0, seq: 1 }),
                "a late reply must be reported undelivered so the caller can ack it discarded",
            ).toBe(false);
        });
    });

    // MAR-346: the concurrency assumptions are supplied, not baked in. Each
    // test here pins one inversion by driving a NON-default backend or writer
    // through the same primitives the host calls: it goes red if the
    // inversion is reverted to the hardwired form (equality comparison,
    // doc-global seq mark, unconditional repush), while the default-backend
    // suites above pin that the default is byte-for-byte today's behavior.
    describe("supplied backend (MAR-346)", () => {
        const ancestryBackend: FlushBackend = {
            // An ancestry-style admissibility: the immediately preceding
            // version is still a valid parent (a backend that can fast-forward
            // one step), anything older is not.
            isAdmissibleBase: (current, base) => current - base <= 1,
            onBaseRejected: () => ({ outcome: "repush" }),
        };

        it("inversion 1: a supplied predicate should judge admissibility in place of equality", () => {
            const c = new SaveFlushController<string>(1000, ancestryBackend);
            c.bumpVersion(URI);
            expect(c.isAdmissibleBase(URI, 0), "one version behind is admissible to this backend").toBe(true);
            c.bumpVersion(URI);
            expect(c.isAdmissibleBase(URI, 0), "two versions behind is not").toBe(false);
            expect(c.isAdmissibleBase(URI, 2)).toBe(true);
        });

        it("inversion 1: the flush reply guard should consult the same predicate", async () => {
            const c = new SaveFlushController<string>(1000, ancestryBackend);
            let flushId = "";
            const flush = c.flushPendingEdit(URI, (id) => { flushId = id; }, async (t) => [t]);
            c.bumpVersion(URI); // lands mid-flight; equality would now reject base 0
            c.resolveFlush(flushId, { content: "carried", baseSyncVersion: 0, seq: 1 });
            await expect(flush).resolves.toEqual(["carried"]);
        });

        it("inversion 2: writers should keep independent seq marks on one document", () => {
            const c = new SaveFlushController<string>();
            expect(c.claimSeq(URI, 5, "a")).toBe(true);
            // A doc-global mark would read seq 1 as superseded by a's 5.
            expect(c.claimSeq(URI, 1, "b"), "writer b's counter must not be starved by writer a's").toBe(true);
            expect(c.claimSeq(URI, 4, "a"), "a's own stale seq is still stale").toBe(false);
            expect(c.claimSeq(URI, 2, "b")).toBe(true);
        });

        it("inversion 2: resetWebviewBaseline should reset only the restarted writer's mark", () => {
            const c = new SaveFlushController<string>();
            c.claimSeq(URI, 3, "a");
            c.claimSeq(URI, 7, "b");
            c.resetWebviewBaseline(URI, "a");
            expect(c.claimSeq(URI, 1, "a"), "the restarted writer renumbers from 1").toBe(true);
            expect(c.claimSeq(URI, 7, "b"), "the surviving writer's ceiling must hold").toBe(false);
            expect(c.claimSeq(URI, 8, "b")).toBe(true);
        });

        it("inversion 2: a flush reply should claim under its own writer id", async () => {
            const c = new SaveFlushController<string>();
            c.claimSeq(URI, 5); // the local writer's mark
            let flushId = "";
            const flush = c.flushPendingEdit(URI, (id) => { flushId = id; }, async (t) => [t]);
            c.resolveFlush(flushId, { content: "remote", baseSyncVersion: 0, seq: 1, writerId: "remote" });
            await expect(flush).resolves.toEqual(["remote"]);
            expect(c.claimSeq(URI, 6), "the local writer's own ceiling is untouched").toBe(true);
        });

        it("inversion 3: rejectBase should return the backend's verdict, defaulting to repush", () => {
            const deferring: FlushBackend = {
                isAdmissibleBase: () => false,
                onBaseRejected: ({ content }) => (content === "hold" ? { outcome: "defer" } : { outcome: "escalate" }),
            };
            const c = new SaveFlushController<string>(1000, deferring);
            expect(c.rejectBase(URI, 0, "hold")).toEqual({ outcome: "defer" });
            expect(c.rejectBase(URI, 0, "boom")).toEqual({ outcome: "escalate" });
            const d = new SaveFlushController<string>();
            expect(d.rejectBase(URI, 0, "anything"), "the default maps everything to today's behavior").toEqual({
                outcome: "repush",
            });
        });

        it("teardown poison should stay rejected even under an admit-everything backend", async () => {
            const admitAll: FlushBackend = {
                isAdmissibleBase: () => true,
                onBaseRejected: () => ({ outcome: "repush" }),
            };
            const c = new SaveFlushController<string>(1000, admitAll);
            const flush = c.flushPendingEdit(URI, () => {}, async () => ["edit"]);
            c.failFlushes(URI);
            await expect(flush, "the poison rides the seq guard, not the version guard").resolves.toEqual([]);
        });
    });

    describe("teardown", () => {
        it("failFlushes should resolve a parked flush for the document to no edits", async () => {
            const c = new SaveFlushController<string>();
            const flush = c.flushPendingEdit(URI, () => {}, async () => ["edit"]);
            c.failFlushes(URI);
            await expect(flush).resolves.toEqual([]);
        });

        it("failFlushes should leave another document's parked flush pending", async () => {
            const c = new SaveFlushController<string>();
            let otherId = "";
            const other = c.flushPendingEdit(
                "file:///other.md",
                (id) => { otherId = id; },
                async (t) => [t],
            );
            c.failFlushes(URI);
            c.resolveFlush(otherId, { content: "alive", baseSyncVersion: 0, seq: 1 });
            await expect(other).resolves.toEqual(["alive"]);
        });

        it("dispose should drop version and seq state for the document", () => {
            const c = new SaveFlushController<string>();
            c.bumpVersion(URI);
            c.claimSeq(URI, 9);
            c.dispose(URI);
            expect(c.currentVersion(URI)).toBe(0);
            expect(c.claimSeq(URI, 1)).toBe(true);
        });
    });
});
