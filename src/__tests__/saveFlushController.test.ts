/**
 * SaveFlushController: the extracted flush/seq protocol (MAR-168). The
 * provider-level suites (saveFlush/textSync) pin the protocol through the
 * public editor behavior; these tests pin the controller's own contract —
 * including the injectable timeout path, which the provider suite could only
 * reach at the fixed 1s value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SaveFlushController } from "../saveFlushController";

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
            expect(c.isCurrentVersion(URI, 0)).toBe(true);
        });

        it("bumpVersion should make an older base stale and the new base current", () => {
            const c = new SaveFlushController<string>();
            c.bumpVersion(URI);
            expect(c.currentVersion(URI)).toBe(1);
            expect(c.isCurrentVersion(URI, 0)).toBe(false);
            expect(c.isCurrentVersion(URI, 1)).toBe(true);
        });

        it("resetVersion should re-baseline the document at 0", () => {
            const c = new SaveFlushController<string>();
            c.bumpVersion(URI);
            c.bumpVersion(URI);
            c.resetVersion(URI);
            expect(c.isCurrentVersion(URI, 0)).toBe(true);
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
