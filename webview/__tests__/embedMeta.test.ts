/**
 * The webview embed-metadata store: one ask per kind:id per session, parked
 * subscribers, negative caching, and the reply backstop. Message posting goes
 * through the mocked acquireVsCodeApi (setup.ts); the store never touches the
 * document by construction (nothing here imports the editor).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import {
    _resetEmbedMetaForTests,
    handleEmbedMetaResult,
    queueEmbedMetaResolution,
    subscribeEmbedMeta,
} from "../embedMeta";

const YT = { match: { kind: "youtube" as const, id: "dQw4w9WgXcQ" }, href: "https://youtu.be/dQw4w9WgXcQ" };
const LOOM = { match: { kind: "loom" as const, id: "f".repeat(32) }, href: `https://www.loom.com/share/${"f".repeat(32)}` };
const GH = { match: { kind: "github" as const, id: "owner/repo" }, href: "https://github.com/owner/repo" };

/** The resolveEmbedMeta messages posted so far. */
function postedRequests(): Array<{ id: string; url: string }> {
    return mockVscodeApi.postMessage.mock.calls
        .map((c) => c[0] as { type: string; id: string; url: string })
        .filter((m) => m.type === "resolveEmbedMeta");
}

describe("embedMeta store", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetEmbedMetaForTests();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("queue should ask once per metadata-capable embed and skip GitHub", () => {
        queueEmbedMetaResolution([YT, LOOM, GH]);
        const asked = postedRequests();
        expect(asked).toHaveLength(2);
        expect(asked.map((r) => r.url)).toEqual([YT.href, LOOM.href]);
    });

    it("a second queue pass should ask nothing new (session dedupe)", () => {
        queueEmbedMetaResolution([YT, LOOM]);
        queueEmbedMetaResolution([YT, LOOM]);
        expect(postedRequests()).toHaveLength(2);
    });

    it("a reply should reach a parked subscriber, and later subscribers synchronously", () => {
        queueEmbedMetaResolution([YT]);
        const early = vi.fn();
        subscribeEmbedMeta("youtube", YT.match.id, early);

        const requestId = postedRequests()[0];
        handleEmbedMetaResult((mockVscodeApi.postMessage.mock.calls[0][0] as { id: string }).id, "A Title");
        expect(early).toHaveBeenCalledWith("A Title");
        expect(requestId).toBeDefined();

        const late = vi.fn();
        subscribeEmbedMeta("youtube", YT.match.id, late);
        expect(late).toHaveBeenCalledWith("A Title"); // sync cache hit
    });

    it("a null reply should be negatively cached — no re-ask on the next queue pass", () => {
        queueEmbedMetaResolution([LOOM]);
        handleEmbedMetaResult((mockVscodeApi.postMessage.mock.calls[0][0] as { id: string }).id, null);

        queueEmbedMetaResolution([LOOM]);
        expect(postedRequests()).toHaveLength(1);

        const sub = vi.fn();
        subscribeEmbedMeta("loom", LOOM.match.id, sub);
        expect(sub).toHaveBeenCalledWith(null);
    });

    it("a subscriber arriving BEFORE the ask should still be served by it", () => {
        const sub = vi.fn();
        subscribeEmbedMeta("youtube", YT.match.id, sub);
        expect(postedRequests()).toHaveLength(0);

        // The idle pass eventually asks; the pre-registered entry must not
        // suppress the request, and the reply must reach the parked waiter.
        queueEmbedMetaResolution([YT]);
        expect(postedRequests()).toHaveLength(1);
        handleEmbedMetaResult((mockVscodeApi.postMessage.mock.calls[0][0] as { id: string }).id, "Late");
        expect(sub).toHaveBeenCalledWith("Late");
    });

    it("a dropped reply should settle null via the backstop, not pend forever", () => {
        vi.useFakeTimers();
        queueEmbedMetaResolution([YT]);
        const sub = vi.fn();
        subscribeEmbedMeta("youtube", YT.match.id, sub);
        expect(sub).not.toHaveBeenCalled();

        vi.advanceTimersByTime(15001);
        expect(sub).toHaveBeenCalledWith(null);
        // And the failure is cached like any other.
        queueEmbedMetaResolution([YT]);
        expect(postedRequests()).toHaveLength(1);
    });

    it("an unknown request id in a reply should be ignored", () => {
        queueEmbedMetaResolution([YT]);
        expect(() => handleEmbedMetaResult("bogus", "X")).not.toThrow();
        const sub = vi.fn();
        subscribeEmbedMeta("youtube", YT.match.id, sub);
        expect(sub).not.toHaveBeenCalled(); // still pending
    });
});
